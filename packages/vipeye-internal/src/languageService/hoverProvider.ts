/*
 * hoverProvider.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Logic that maps a position within a Viper program file into
 * markdown text that is displayed when the user hovers over that
 * position within a smart editor.
 */

import { CancellationToken, Hover, MarkupKind } from 'vscode-languageserver';

import {
    Declaration,
    DeclarationType,
    FunctionDeclaration,
    VariableDeclaration,
    isUnresolvedAliasDeclaration,
} from '../analyzer/declaration';
import { getFileInfo } from '../analyzer/analyzerNodeInfo';
import { getViperEnumMemberValues } from '../analyzer/enums';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { SourceMapper } from '../analyzer/sourceMapper';
import { SynthesizedTypeInfo } from '../analyzer/symbol';
import { isBuiltInModule } from '../analyzer/typeDocStringUtils';
import { PrintTypeOptions, TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { convertToInstance, doForEachSubtype, isMaybeDescriptorInstance } from '../analyzer/typeUtils';
import {
    ClassType,
    Type,
    TypeCategory,
    getTypeAliasInfo,
    isAnyOrUnknown,
    isClassInstance,
    isFunction,
    isFunctionOrOverloaded,
    isModule,
    isParamSpec,
    isTypeVar,
} from '../analyzer/types';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { SignatureDisplayType } from '../common/configOptions';
import { IsViperDialect } from '../common/dialect';
import { assertNever, fail } from '../common/debug';
import { ProgramView } from '../common/extensibility';
import { convertOffsetToPosition, convertPositionToOffset } from '../common/positionUtils';
import { ServiceProvider } from '../common/serviceProvider';
import { Position, Range, TextRange } from '../common/textRange';
import { Uri } from '../common/uri/uri';
import {
    ExpressionNode,
    FunctionNode,
    IndexNode,
    NameNode,
    ParamCategory,
    ParameterNode,
    ParseNode,
    ParseNodeType,
    StringNode,
} from '../parser/parseNodes';
import { ParseFileResults } from '../parser/parser';
import { TokenType } from '../parser/tokenizerTypes';
import {
    getClassAndConstructorTypes,
    getConstructorTooltip,
    getDocumentationPartsForTypeAndDeclWithSource,
    getToolTipForType,
    getTypeForToolTip,
    getWrappedFunctionType,
} from './tooltipUtils';
import { findViperAttributeContext, getViperAttributeSymbols } from './viperAttributeUtils';

export interface HoverTextPart {
    // 该部分按代码块渲染（markdown 下加代码围栏，见 convertHoverResults）。
    python?: boolean;
    text: string;
}

export interface HoverResults {
    parts: HoverTextPart[];
    range: Range;
}

export function convertHoverResults(hoverResults: HoverResults | null, format: MarkupKind): Hover | null {
    if (!hoverResults) {
        return null;
    }

    const markupString = hoverResults.parts
        .map((part) => {
            if (part.python) {
                if (format === MarkupKind.Markdown) {
                    // 围栏语言保持 `python`：hover 代码块由宿主 markdown 渲染器着色，它先用
                    // languageService.getLanguageIdByLanguageName() 把围栏语言名解析成语言 id，
                    // 再取该语言的 TM tokenization，取不到才整块退化为纯文本。
                    // 本扩展贡献的 `viper` 语法在该路径下能取到 tokenization，但只有通用 scope
                    // （comment/string/keyword.control.flow/constant.numeric）能命中主题规则；
                    // `def`/`class` 用的 storage.type.*.viper 匹配不到主题里按 Python 精调的
                    // 规则，裸类型名（int/str）语法里也没有规则 —— 实测 ```viper 只部分着色，
                    // 而 ```python 走 MagicPython，关键字/类型/装饰器齐全，故用它。
                    // Viper 语法本就是 CPython 派生，Python 语法对关键字/装饰器/字符串/数字的
                    // 着色是正确的。
                    return '```python\n' + part.text + '\n```\n';
                } else if (format === MarkupKind.PlainText) {
                    return part.text + '\n\n';
                } else {
                    fail(`Unsupported markup type: ${format}`);
                }
            }
            return part.text;
        })
        .join('')
        .trimEnd();

    return {
        contents: {
            kind: format,
            value: markupString,
        },
        range: hoverResults.range,
    };
}

function getDocumentationSeparator(previousPart: HoverTextPart): string {
    if (previousPart.python) {
        return '---\n';
    }

    if (previousPart.text.endsWith('\n\n')) {
        return '---\n';
    }

    if (previousPart.text.endsWith('\n')) {
        return '\n---\n';
    }

    return '\n\n---\n';
}

export function addParameterResultsPart(
    serviceProvider: ServiceProvider,
    paramNameNode: NameNode,
    resolvedDecl: Declaration | undefined,
    format: MarkupKind,
    parts: HoverTextPart[]
) {
    // See if we have a docstring for the parent function.
    let docString: string | undefined = undefined;
    const funcNode = ParseTreeUtils.getEnclosingFunction(resolvedDecl?.node || paramNameNode);
    if (funcNode) {
        docString = ParseTreeUtils.getDocString(funcNode?.d.suite?.d.statements ?? []);
        if (docString) {
            // Compute the docstring now.
            docString = serviceProvider
                .docStringService()
                .extractParameterDocumentation(docString, paramNameNode.d.value, format);
        }
    }
    if (!docString) {
        return;
    }

    parts.push({
        python: false,
        text: docString,
    });
}

function addReturnResultsPart(
    serviceProvider: ServiceProvider,
    functionNode: FunctionNode,
    format: MarkupKind,
    parts: HoverTextPart[]
) {
    // See if we have a docstring for the function whose return arrow is being hovered.
    const docString = ParseTreeUtils.getDocString(functionNode.d.suite?.d.statements ?? []);
    if (!docString) {
        return;
    }

    const returnDoc = serviceProvider.docStringService().extractReturnDocumentation(docString, format);
    if (!returnDoc) {
        return;
    }

    parts.push({
        python: false,
        text: returnDoc,
    });
}

export function addDocumentationResultsPart(
    serviceProvider: ServiceProvider,
    docString: string | undefined,
    format: MarkupKind,
    parts: HoverTextPart[],
    resolvedDecl: Declaration | undefined,
    forceLiteralOverride?: boolean
) {
    if (!docString) {
        return;
    }

    if (format === MarkupKind.Markdown) {
        const forceLiteral = forceLiteralOverride ?? isBuiltInModule(resolvedDecl?.uri);
        const markDown = serviceProvider
            .docStringService()
            .convertDocStringToMarkdown(docString, forceLiteral, resolvedDecl?.uri);

        if (parts.length > 0 && markDown.length > 0) {
            parts.push({ text: getDocumentationSeparator(parts[parts.length - 1]) });
        }

        parts.push({ text: markDown, python: false });
        return;
    }

    if (format === MarkupKind.PlainText) {
        parts.push({ text: serviceProvider.docStringService().convertDocStringToPlainText(docString), python: false });
        return;
    }

    fail(`Unsupported markup type: ${format}`);
}

// Viper 扩展：构造 `enum X:` 枚举成员的 hover 类型文本（枚举类型 + 编译期推导值），
// 例如 `ASTFlag = 0`。非 `enum X:` 的成员返回 undefined，走常规显示逻辑。
function getViperEnumMemberTypeText(declaration: VariableDeclaration | undefined, name: string): string | undefined {
    if (!declaration || declaration.node.nodeType !== ParseNodeType.Name) {
        return undefined;
    }

    const classNode = ParseTreeUtils.getEnclosingClass(declaration.node, /* stopAtFunction */ true);
    if (!classNode?.d.isViperEnum) {
        return undefined;
    }

    const className = classNode.d.name.d.value;
    const value = getViperEnumMemberValues(classNode).get(name);

    return value === undefined ? `${name}: ${className}` : `${name}: ${className} = ${value}`;
}

// Viper 扩展：判断类型注解是否是/包含 `[SIZE]T` 数组语法（脱糖后的下标节点，
// 见 parser._parseViperBracketArrayType）。用于让 hover 按源码原形显示
// （如 `[4]t.CInt`）而非脱糖后的 `CArray[CInt, 4]`。联合类型逐操作数判断。
function hasViperBracketArrayAnnotation(node: ExpressionNode | undefined): boolean {
    if (!node) {
        return false;
    }
    if (node.nodeType === ParseNodeType.Index && (node as IndexNode).d.isViperBracketArray === true) {
        return true;
    }
    if (node.nodeType === ParseNodeType.BinaryOperation) {
        return (
            hasViperBracketArrayAnnotation(node.d.leftExpr) ||
            hasViperBracketArrayAnnotation(node.d.rightExpr)
        );
    }
    return false;
}

export function getVariableTypeText(
    evaluator: TypeEvaluator,
    declaration: VariableDeclaration | undefined,
    name: string,
    type: Type,
    typeNode: ExpressionNode,
    functionSignatureDisplay: SignatureDisplayType,
    sourceMapper?: SourceMapper,
    printOptions?: PrintTypeOptions
) {
    let label = 'variable';
    if (declaration) {
        label = declaration.isConstant || evaluator.isFinalVariableDeclaration(declaration) ? 'constant' : 'variable';
    }

    // Viper 扩展：`enum X:` 枚举成员显示枚举类型与编译期推导值（如 `ASTFlag = 0`）。
    // 裸名成员没有赋值也没有注解，常规路径只会给出 Unbound。
    const viperEnumMemberText = getViperEnumMemberTypeText(declaration, name);
    if (viperEnumMemberText) {
        return `(${label}) ` + viperEnumMemberText;
    }

    // Viper 扩展：`[SIZE]T` 数组语法注解按源码原形显示（如 `x: [4]t.CInt`），
    // 而不是脱糖后的 `CArray[CInt, 4]`，与用户书写形态保持一致。
    const bracketArrayAnnotation = declaration?.typeAnnotationNode;
    if (bracketArrayAnnotation && hasViperBracketArrayAnnotation(bracketArrayAnnotation)) {
        return `(${label}) ${name}: ` + ParseTreeUtils.printExpression(bracketArrayAnnotation);
    }

    let typeVarName: string | undefined;

    if (type.props?.typeAliasInfo && typeNode.nodeType === ParseNodeType.Name) {
        const typeAliasInfo = getTypeAliasInfo(type);
        if (typeAliasInfo?.shared.name === typeNode.d.value) {
            if (isTypeVar(type)) {
                label = isParamSpec(type) ? 'param spec' : 'type variable';
                typeVarName = type.shared.name;
            } else {
                // Handle type aliases specially.
                const typeText = evaluator.printType(convertToInstance(getTypeForToolTip(evaluator, typeNode)), {
                    ...printOptions,
                    expandTypeAlias: true,
                });

                return `(type) ${name} = ` + typeText;
            }
        }
    }

    // Viper 扩展：t.CTypedef 声明的类型别名悬浮提示。
    // 当变量声明带 t.CTypedef 注解时（如 `UINT32PTR: t.CTypedef = t.CUInt32T | t.CPtr`），
    // 即使 typeAliasInfo 未被设置（跨模块 import 等场景），也显示类型别名格式。
    // 格式：(type) name = actualType。不展开类型别名（expandTypeAlias: false），
    // 保留原始 typedef 表达式中的类型名称（如 CUInt32T 而非 int）。
    if (
        declaration?.typeAnnotationNode &&
        declaration.typeAnnotationNode.nodeType === ParseNodeType.MemberAccess &&
        (declaration.typeAnnotationNode as any).d?.member?.d?.value === 'CTypedef'
    ) {
        const typeText = evaluator.printType(convertToInstance(getTypeForToolTip(evaluator, typeNode)), {
            ...printOptions,
            expandTypeAlias: false,
        });
        return `(type) ${name} = ` + typeText;
    }

    if (
        type.category === TypeCategory.Function ||
        type.category === TypeCategory.Overloaded ||
        typeNode.parent?.nodeType === ParseNodeType.Call
    ) {
        return getToolTipForType(
            type,
            label,
            name,
            evaluator,
            /* isProperty */ false,
            functionSignatureDisplay,
            typeNode,
            sourceMapper,
            printOptions
        );
    }

    const typeText =
        typeVarName ?? name + ': ' + evaluator.printType(getTypeForToolTip(evaluator, typeNode), printOptions);

    // Viper 扩展：变量类型是 typedef 别名时，附加 typedef 信息换行显示。
    // 例如 `k: UINT16PTR` 悬浮显示：
    //   (variable) k: UINT16PTR
    //   (typedef) UINT16PTR = CPtr[CUInt16T]
    // 仅当变量类型带有 typeAliasInfo 且别名名与变量名不同时触发
    // （避免类型别名定义本身悬浮时重复显示）。
    if (
        typeNode.nodeType === ParseNodeType.Name &&
        type.props?.typeAliasInfo
    ) {
        const aliasInfo = getTypeAliasInfo(type);
        if (aliasInfo && aliasInfo.shared.name !== typeNode.d.value) {
            const fileInfo = getFileInfo(typeNode);
            if (IsViperDialect(fileInfo.executionEnvironment.dialect)) {
                const aliasName = aliasInfo.shared.name;
                const actualType = evaluator.printType(convertToInstance(getTypeForToolTip(evaluator, typeNode)), {
                    ...printOptions,
                    expandTypeAlias: false,
                });
                return `(${label}) ` + typeText + `\n(typedef) ${aliasName} = ` + actualType;
            }
        }
    }

    return `(${label}) ` + typeText;
}

export class HoverProvider {
    private readonly _parseResults: ParseFileResults | undefined;
    private readonly _sourceMapper: SourceMapper;

    constructor(
        private readonly _program: ProgramView,
        private readonly _fileUri: Uri,
        private readonly _position: Position,
        private readonly _format: MarkupKind,
        private readonly _token: CancellationToken
    ) {
        this._parseResults = this._program.getParseResults(this._fileUri);
        this._sourceMapper = this._program.getSourceMapper(this._fileUri, this._token, /* mapCompiled */ true);
    }

    getHover(): Hover | null {
        return convertHoverResults(this._getHoverResult(), this._format);
    }

    static getPrimaryDeclaration(declarations: Declaration[]) {
        // In most cases, it's best to treat the first declaration as the
        // "primary". This works well for properties that have setters
        // which often have doc strings on the getter but not the setter.
        // The one case where using the first declaration doesn't work as
        // well is the case where an import statement within an __init__.py
        // file uses the form "from .A import A". In this case, if we use
        // the first declaration, it will show up as a module rather than
        // the imported symbol type.
        const primaryDeclaration = declarations[0];
        if (primaryDeclaration.type === DeclarationType.Alias && declarations.length > 1) {
            return declarations[1];
        } else if (
            primaryDeclaration.type === DeclarationType.Variable &&
            declarations.length > 1 &&
            primaryDeclaration.isDefinedBySlots
        ) {
            // Slots cannot have docstrings, so pick the secondary.
            return declarations[1];
        }

        return primaryDeclaration;
    }

    private get _evaluator(): TypeEvaluator {
        return this._program.evaluator!;
    }

    private get _functionSignatureDisplay() {
        return this._program.configOptions.functionSignatureDisplay;
    }

    // Viper 方言：hover 的类型展示保留源码中书写时的完整 module 路径（如 `ast.AST`）。
    // 未写限定路径的裸名（`list`/`str`）仍显示短名，具体规则见 typePrinter。
    private _getPrintTypeOptions(options?: PrintTypeOptions): PrintTypeOptions {
        return { ...options, sourceQualifiedNames: true };
    }

    private _printType(type: Type, options?: PrintTypeOptions): string {
        return this._evaluator.printType(type, this._getPrintTypeOptions(options));
    }

    // Viper 扩展：光标位于 `__attribute__(...)` 实参括号内时，列出该修饰器可用的
    // 全部属性名（section / aligned / always_inline / weak 等）。
    // 上下文识别与 `t.attr` 成员查找复用 viperAttributeUtils，与括号内补全同源。
    private _getViperAttributeHover(offset: number): HoverResults | null {
        if (!this._parseResults) {
            return null;
        }

        const moduleNode = this._parseResults.parserOutput.parseTree;
        if (!IsViperDialect(getFileInfo(moduleNode).executionEnvironment.dialect)) {
            return null;
        }

        const context = findViperAttributeContext(this._parseResults.text, offset);
        if (!context) {
            return null;
        }

        const attributeInfo = getViperAttributeSymbols(this._evaluator, moduleNode);
        if (!attributeInfo) {
            return null;
        }

        const names = Array.from(attributeInfo.symbolTable.keys()).sort();

        return {
            parts: [
                { text: '`__attribute__(...)` 可用属性名：' },
                { text: names.join(' '), python: true },
                {
                    text:
                        '\n\n带参数者写成调用，如 `section(".text.wo")` / `aligned(16)` / ' +
                        '`format(printf, 1, 2)`；无参数者可直接写属性名（`packed`）或写调用（`packed()`）。' +
                        '\n\n属性清单来自 `t.attr`（TransPyC 的 `lib/includes/t.py`）。',
                },
            ],
            range: {
                start: convertOffsetToPosition(context.nameStart, this._parseResults.tokenizerOutput.lines),
                end: convertOffsetToPosition(context.openParen + 1, this._parseResults.tokenizerOutput.lines),
            },
        };
    }

    private _getHoverResult(): HoverResults | null {
        throwIfCancellationRequested(this._token);

        if (!this._parseResults) {
            return null;
        }

        const offset = convertPositionToOffset(this._position, this._parseResults.tokenizerOutput.lines);
        if (offset === undefined) {
            return null;
        }

        // Viper 扩展：光标位于 `__attribute__(...)` 实参括号内时，提示可用的全部属性名。
        // 必须在常规 parse 树分派之前：`__attribute__(...)` 脱糖后原始调用节点不保留在
        // parse 树中，光标位置（尤其实参为空/未写完时）没有可命中的节点。
        const attributeHover = this._getViperAttributeHover(offset);
        if (attributeHover) {
            return attributeHover;
        }

        const node = ParseTreeUtils.findNodeByOffset(this._parseResults.parserOutput.parseTree, offset);
        if (node === undefined) {
            return null;
        }

        const results: HoverResults = {
            parts: [],
            range: {
                start: convertOffsetToPosition(node.start, this._parseResults.tokenizerOutput.lines),
                end: convertOffsetToPosition(TextRange.getEnd(node), this._parseResults.tokenizerOutput.lines),
            },
        };

        if (node.nodeType === ParseNodeType.Name) {
            const declInfo = this._evaluator.getDeclInfoForNameNode(node);
            const declarations = declInfo?.decls;

            if (declarations && declarations.length > 0) {
                const primaryDeclaration = HoverProvider.getPrimaryDeclaration(declarations);
                this._addResultsForDeclaration(results.parts, primaryDeclaration, node);
            } else if (declInfo && declInfo.synthesizedTypes.length > 0) {
                const nameNode = node;
                declInfo?.synthesizedTypes.forEach((type) => {
                    this._addResultsForSynthesizedType(results.parts, type, nameNode);
                });
                this._addDocumentationPart(results.parts, node, /* resolvedDecl */ undefined);
            } else if (!node.parent || node.parent.nodeType !== ParseNodeType.ModuleName) {
                // If we had no declaration, see if we can provide a minimal tooltip. We'll skip
                // this if it's part of a module name, since a module name part with no declaration
                // is a directory (a namespace package), and we don't want to provide any hover
                // information in that case.
                if (results.parts.length === 0) {
                    const type = this._getType(node);
                    let typeText: string;
                    if (isModule(type)) {
                        // Handle modules specially because submodules aren't associated with
                        // declarations, but we want them to be presented in the same way as
                        // the top-level module, which does have a declaration.
                        typeText = '(module) ' + node.d.value;
                    } else {
                        let label = 'function';
                        let isProperty = false;

                        if (isMaybeDescriptorInstance(type, /* requireSetter */ false)) {
                            isProperty = true;
                            label = 'property';
                        }

                        typeText = getToolTipForType(
                            type,
                            label,
                            node.d.value,
                            this._evaluator,
                            isProperty,
                            this._functionSignatureDisplay,
                            /* typeNode */ undefined,
                            /* sourceMapper */ undefined,
                            this._getPrintTypeOptions()
                        );
                    }

                    this._addResultsPart(results.parts, typeText, /* python */ true);
                    this._addDocumentationPart(results.parts, node, /* resolvedDecl */ undefined);
                }
            }
        } else if (node.nodeType === ParseNodeType.String) {
            const type = this._evaluator.getExpectedType(node)?.type;
            if (type !== undefined) {
                this._tryAddPartsForTypedDictKey(node, type, results.parts);
            }
        } else if (node.nodeType === ParseNodeType.Function) {
            // Hovering over the `->` return-type arrow shows the function's return documentation.
            const token = ParseTreeUtils.getTokenOverlapping(this._parseResults.tokenizerOutput.tokens, offset);
            if (token?.type === TokenType.Arrow) {
                addReturnResultsPart(this._program.serviceProvider, node, this._format, results.parts);
            }
        }

        return results.parts.length > 0 ? results : null;
    }

    private _addResultsForDeclaration(parts: HoverTextPart[], declaration: Declaration, node: NameNode): void {
        const resolvedDecl =
            declaration.type === DeclarationType.Alias
                ? this._evaluator.resolveAliasDeclaration(declaration, /* resolveLocalNames */ true)
                : declaration;
        if (
            !resolvedDecl ||
            (resolvedDecl.type === DeclarationType.Alias && isUnresolvedAliasDeclaration(resolvedDecl))
        ) {
            this._addResultsPart(parts, `(import) ` + node.d.value + this._getTypeText(node), /* python */ true);
            return;
        }

        switch (resolvedDecl.type) {
            case DeclarationType.Intrinsic: {
                this._addResultsPart(parts, node.d.value + this._getTypeText(node), /* python */ true);
                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            case DeclarationType.Variable: {
                // If the named node is an aliased import symbol, we can't call
                // getType on the original name because it's not in the symbol
                // table. Instead, use the node from the resolved alias.
                let typeNode: ParseNode = node;
                let cachedTypeForTypeNode: Type | undefined;
                if (
                    declaration.node.nodeType === ParseNodeType.ImportAs ||
                    declaration.node.nodeType === ParseNodeType.ImportFromAs
                ) {
                    if (declaration.node.d.alias && node !== declaration.node.d.alias) {
                        if (resolvedDecl.node.nodeType === ParseNodeType.Name) {
                            typeNode = resolvedDecl.node;
                        }
                    }
                } else if (node.parent?.nodeType === ParseNodeType.Argument && node.parent.d.name === node) {
                    // If this is a named argument, we would normally have received a Parameter declaration
                    // rather than a variable declaration, but we can get here in the case of a dataclass.
                    if (declaration.node.nodeType === ParseNodeType.Name) {
                        if (!resolvedDecl.typeAnnotationNode) {
                            // No annotation: use the declaration name node.
                            typeNode = declaration.node;
                        } else {
                            // Has annotation: prefer the call-site node so the type evaluator
                            // returns the declared annotation type (not flow-narrowed by the default).
                            // Fall back to declaration node if the call-site resolves to Any/Unknown
                            // (e.g. NamedTuple synthesized constructors).
                            const callSiteType = this._getType(node);
                            if (isAnyOrUnknown(callSiteType)) {
                                typeNode = declaration.node;
                            } else {
                                // typeNode stays as `node`; reuse the type we just computed to
                                // avoid a duplicate _getType call on this hot hover path.
                                cachedTypeForTypeNode = callSiteType;
                            }
                        }
                    }
                }

                // Determine if this identifier is a type alias. If so, expand
                // the type alias when printing the type information.
                const type = cachedTypeForTypeNode ?? this._getType(typeNode);
                const typeText = getVariableTypeText(
                    this._evaluator,
                    resolvedDecl,
                    node.d.value,
                    type,
                    typeNode,
                    this._functionSignatureDisplay,
                    this._sourceMapper,
                    this._getPrintTypeOptions()
                );

                this._addResultsPart(parts, typeText, /* python */ true);
                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            case DeclarationType.Param: {
                // Viper 扩展：参数类型是 typedef 别名时，附加 typedef 信息换行显示。
                // 例如 `fb: UINT32PTR` 悬浮显示：
                //   (parameter) fb: UINT32PTR
                //   (typedef) UINT32PTR = CPtr[CUInt32T]
                const paramType = this._getType(node);
                // Viper 扩展：`[SIZE]T` 数组语法注解按源码原形显示（如 `[4]t.CInt`）。
                const paramAnnotation = resolvedDecl.node.d.annotation;
                let paramLine =
                    paramAnnotation && hasViperBracketArrayAnnotation(paramAnnotation)
                        ? '(parameter) ' +
                          node.d.value +
                          ': ' +
                          ParseTreeUtils.printExpression(paramAnnotation)
                        : '(parameter) ' + node.d.value + this._getTypeText(node);
                if (paramType?.props?.typeAliasInfo && node.nodeType === ParseNodeType.Name) {
                    const aliasInfo = getTypeAliasInfo(paramType);
                    if (aliasInfo && aliasInfo.shared.name !== node.d.value) {
                        const fileInfo = getFileInfo(node);
                        if (IsViperDialect(fileInfo.executionEnvironment.dialect)) {
                            const actualType = this._printType(
                                convertToInstance(getTypeForToolTip(this._evaluator, node)),
                                { expandTypeAlias: false }
                            );
                            paramLine += `\n(typedef) ${aliasInfo.shared.name} = ` + actualType;
                        }
                    }
                }
                this._addResultsPart(parts, paramLine, /* python */ true);
                addParameterResultsPart(this._program.serviceProvider, node, resolvedDecl, this._format, parts);
                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            case DeclarationType.TypeParam: {
                // If the user is hovering over a type parameter name in a class type parameter
                // list, display the computed variance of the type param.
                const typeParamListNode = ParseTreeUtils.getParentNodeOfType(node, ParseNodeType.TypeParameterList);
                const nodeType = typeParamListNode?.parent?.nodeType;
                const printTypeVarVariance = nodeType === ParseNodeType.Class || nodeType === ParseNodeType.TypeAlias;

                this._addResultsPart(
                    parts,
                    '(type parameter) ' + node.d.value + this._getTypeText(node, { printTypeVarVariance }),
                    /* python */ true
                );
                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            case DeclarationType.Class:
            case DeclarationType.SpecialBuiltInClass: {
                if (this._addInitOrNewMethodInsteadIfCallNode(node, parts, resolvedDecl)) {
                    return;
                }

                const nameNode = resolvedDecl.type === DeclarationType.Class ? resolvedDecl.node.d.name : node;
                this._addResultsPart(parts, '(class) ' + nameNode.d.value, /* python */ true);
                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            case DeclarationType.Function: {
                let label = 'function';
                let isProperty = false;
                if (resolvedDecl.isMethod) {
                    const declaredType = this._evaluator.getTypeForDeclaration(resolvedDecl)?.type;
                    isProperty = !!declaredType && isMaybeDescriptorInstance(declaredType, /* requireSetter */ false);
                    label = isProperty ? 'property' : 'method';
                }

                let type = this._getType(node);
                const resolvedType = this._getType(resolvedDecl.node.d.name);
                type = isAnyOrUnknown(type) ? resolvedType : type;

                // If this function is decorated with @functools.wraps, show the wrapped function's signature.
                if (isFunction(type)) {
                    const wrappedType = getWrappedFunctionType(resolvedDecl as FunctionDeclaration, this._evaluator);
                    if (wrappedType) {
                        type = wrappedType;
                    }
                }
                const signatureString = getToolTipForType(
                    type,
                    label,
                    node.d.value,
                    this._evaluator,
                    isProperty,
                    this._functionSignatureDisplay,
                    /* typeNode */ undefined,
                    this._sourceMapper,
                    this._getPrintTypeOptions()
                );

                this._addResultsPart(parts, signatureString, /* python */ true);

                // Viper 扩展：hover 函数时附加详尽调试信息（仅 Viper 方言）。
                this._addViperFunctionDebugPart(parts, resolvedDecl);

                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            case DeclarationType.Alias: {
                // First the 'module' header.
                this._addResultsPart(parts, '(module) ' + node.d.value, /* python */ true);
                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            case DeclarationType.TypeAlias: {
                const type = convertToInstance(this._getType(node));
                const typeText = this._printType(type, { expandTypeAlias: true });
                this._addResultsPart(parts, `(type) ${node.d.value} = ${typeText}`, /* python */ true);
                this._addDocumentationPart(parts, node, resolvedDecl);
                break;
            }

            default:
                assertNever(resolvedDecl);
        }
    }

    // Viper 扩展：hover 函数时附加详尽调试信息（仅 Viper 方言）。
    // 显示：定义位置、修饰符（extern/export/inline）、泛型参数、参数列表（类型/默认值）、返回类型。
    private _addViperFunctionDebugPart(parts: HoverTextPart[], resolvedDecl: FunctionDeclaration): void {
        const funcNode = resolvedDecl.node;
        if (funcNode.nodeType !== ParseNodeType.Function) {
            return;
        }

        const fileInfo = getFileInfo(funcNode);
        if (!IsViperDialect(fileInfo.executionEnvironment.dialect)) {
            return;
        }
        // 不对 stub 文件中的声明附加调试信息（如 stdlib .vpi / typeshed .pyi 类型定义），
        // 避免对纯声明函数产生噪声。
        const declPathLower = fileInfo.fileUri.getPath().toLowerCase();
        if (declPathLower.endsWith('.pyi') || declPathLower.endsWith('.vpi') || declPathLower.endsWith('.vpnci')) {
            return;
        }

        const declUri = fileInfo.fileUri;
        const declParseResults = this._program.getParseResults(declUri);
        if (!declParseResults) {
            return;
        }
        const declText = declParseResults.text;
        const declLines = declParseResults.parserOutput.lines;

        const isMarkdown = this._format === MarkupKind.Markdown;
        const code = (s: string) => (isMarkdown ? `\`${s}\`` : s);
        const bold = (s: string) => (isMarkdown ? `**${s}**` : s);
        const lines: string[] = [];

        // 定义位置（文件:行:列）
        const namePos = convertOffsetToPosition(funcNode.d.name.start, declLines);
        const locDisplay = declUri.key === this._fileUri.key ? '此文件' : declUri.getPath();
        lines.push(`${bold('位置')}: ${code(`${locDisplay}:${namePos.line + 1}:${namePos.character + 1}`)}`);

        // 修饰符（extern/export/inline 等 C 修饰关键字）
        if (funcNode.d.viperModifier) {
            lines.push(`${bold('修饰符')}: ${code(funcNode.d.viperModifier)}`);
        }

        // 泛型参数（PEP 695 type 参数）
        if (funcNode.d.typeParams && funcNode.d.typeParams.d.params.length > 0) {
            const typeParamNames = funcNode.d.typeParams.d.params.map((p) => p.d.name.d.value).join(', ');
            lines.push(`${bold('泛型参数')}: ${code(`[${typeParamNames}]`)}`);
        }

        // 参数列表（名称、类型、默认值、*args/**kwargs 类别）
        if (funcNode.d.params.length > 0) {
            lines.push(`${bold('参数')}:`);
            for (const param of funcNode.d.params) {
                const paramText = this._getViperParamDebugText(param, declText);
                if (paramText) {
                    lines.push(`  ${code(paramText)}`);
                }
            }
        }

        // 返回类型
        const returnType = this._getViperFunctionReturnType(funcNode);
        if (returnType) {
            lines.push(`${bold('返回类型')}: ${code(this._printType(convertToInstance(returnType)))}`);
        }

        if (lines.length === 0) {
            return;
        }

        const heading = isMarkdown ? '**函数调试信息**' : '函数调试信息';
        parts.push({ text: heading + '\n' + lines.join('\n'), python: false });
    }

    // 构造单个参数的调试文本：`*名称: 类型 = 默认值`。
    private _getViperParamDebugText(param: ParameterNode, declText: string): string | undefined {
        let text = '';
        if (param.d.category === ParamCategory.ArgsList) {
            text += '*';
        } else if (param.d.category === ParamCategory.KwargsDict) {
            text += '**';
        }
        text += param.d.name?.d.value ?? '(匿名)';

        let paramType: Type | undefined;
        if (param.d.annotation) {
            paramType = this._evaluator.getTypeOfAnnotation(param.d.annotation);
        } else if (param.d.name) {
            paramType = this._evaluator.getTypeOfExpression(param.d.name).type;
        }
        if (paramType) {
            text += ': ' + this._printType(convertToInstance(paramType));
        }

        if (param.d.defaultValue) {
            const defaultText = declText.slice(param.d.defaultValue.start, TextRange.getEnd(param.d.defaultValue));
            text += ` = ${defaultText}`;
        }

        return text;
    }

    // 返回类型：优先取注解类型，无注解时从函数类型的声明/推断返回类型提取。
    private _getViperFunctionReturnType(funcNode: FunctionNode): Type | undefined {
        if (funcNode.d.returnAnnotation) {
            return this._evaluator.getTypeOfAnnotation(funcNode.d.returnAnnotation);
        }

        const fnType = this._getType(funcNode.d.name);
        if (isFunction(fnType)) {
            return fnType.shared.declaredReturnType ?? fnType.shared.inferredReturnType?.type;
        }
        return undefined;
    }

    private _addResultsForSynthesizedType(parts: HoverTextPart[], typeInfo: SynthesizedTypeInfo, hoverNode: NameNode) {
        let typeText: string | undefined;

        if (isModule(typeInfo.type)) {
            typeText = '(module) ' + hoverNode.d.value;
        } else {
            const node = typeInfo.node ?? hoverNode;

            const type = this._getType(node);
            typeText = getVariableTypeText(
                this._evaluator,
                /* declaration */ undefined,
                node.d.value,
                type,
                node,
                this._functionSignatureDisplay,
                this._sourceMapper,
                this._getPrintTypeOptions()
            );
        }

        if (typeText) {
            this._addResultsPart(parts, typeText, /* python */ true);
        }
    }

    private _tryAddPartsForTypedDictKey(node: StringNode, type: Type, parts: HoverTextPart[]) {
        // If the expected type is a TypedDict and the current node is a key entry then we can provide a tooltip
        // with the type of the TypedDict key and its docstring, if available.
        const seenEntries = new Set<string>();
        doForEachSubtype(type, (subtype) => {
            if (isClassInstance(subtype) && ClassType.isTypedDictClass(subtype)) {
                const entry = subtype.shared.typedDictEntries?.knownItems.get(node.d.value);
                if (entry) {
                    // e.g. (key) name: str
                    const text = '(key) ' + node.d.value + ': ' + this._printType(entry.valueType);

                    const declarations = ClassType.getSymbolTable(subtype).get(node.d.value)?.getDeclarations();
                    let declarationWithDoc: Declaration | undefined;
                    let docString = '';
                    if (declarations !== undefined && declarations?.length !== 0) {
                        // As we are just interested in the docString we don't have to worry about
                        // anything other than the first declaration. There also shouldn't be more
                        // than one declaration for a TypedDict key variable.
                        const declaration = declarations[0];
                        if (declaration.type === DeclarationType.Variable && declaration.docString !== undefined) {
                            declarationWithDoc = declaration;
                            docString = declaration.docString;
                        }
                    }

                    const dedupKey = `${text}\n${docString}`;
                    if (seenEntries.has(dedupKey)) {
                        return;
                    }

                    seenEntries.add(dedupKey);

                    // If we have already added parts for another declaration (e.g. for a union of TypedDicts that share the same key)
                    // then we need to add a separator to prevent a visual bug.
                    if (parts.length > 0) {
                        parts.push({ text: '\n\n---\n' });
                    }

                    this._addResultsPart(parts, text, /* python */ true);

                    if (declarationWithDoc) {
                        this._addDocumentationPartForType(parts, subtype, declarationWithDoc);
                    }
                }
            }
        });
    }

    private _addInitOrNewMethodInsteadIfCallNode(node: NameNode, parts: HoverTextPart[], declaration: Declaration) {
        const result = getClassAndConstructorTypes(node, this._evaluator);
        if (!result) {
            return false;
        }

        if (result.methodType && isFunctionOrOverloaded(result.methodType)) {
            this._addResultsPart(
                parts,
                getConstructorTooltip(
                    node.d.value,
                    result.methodType,
                    this._evaluator,
                    this._functionSignatureDisplay,
                    this._getPrintTypeOptions()
                ),
                /* python */ true
            );

            const addedDoc = this._addDocumentationPartForType(parts, result.methodType, declaration);

            if (!addedDoc) {
                this._addDocumentationPartForType(parts, result.classType, declaration);
            }
            return true;
        }
        return false;
    }

    private _getType(node: ExpressionNode) {
        // It does common work necessary for hover for a type we got
        // from raw type evaluator.
        return getTypeForToolTip(this._evaluator, node);
    }

    private _getTypeText(node: ExpressionNode, options?: PrintTypeOptions): string {
        const type = this._getType(node);
        return ': ' + this._printType(type, options);
    }

    private _addDocumentationPart(parts: HoverTextPart[], node: NameNode, resolvedDecl: Declaration | undefined) {
        const type = this._getType(node);
        this._addDocumentationPartForType(parts, type, resolvedDecl, node.d.value);
    }

    private _addDocumentationPartForType(
        parts: HoverTextPart[],
        type: Type | undefined,
        resolvedDecl: Declaration | undefined,
        name?: string
    ): boolean {
        const documentation = getDocumentationPartsForTypeAndDeclWithSource(
            this._sourceMapper,
            type,
            resolvedDecl,
            this._evaluator,
            {
                name,
            }
        );

        addDocumentationResultsPart(
            this._program.serviceProvider,
            documentation?.text,
            this._format,
            parts,
            resolvedDecl,
            documentation?.forceLiteral
        );
        return !!documentation?.text;
    }

    private _addResultsPart(parts: HoverTextPart[], text: string, python = false) {
        parts.push({
            python,
            text,
        });
    }
}
