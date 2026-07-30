import { TypeServerProtocol } from './protocol/typeServerProtocol';

import * as ViperDecl from '../analyzer/declaration';
import { synthesizeAliasDeclaration } from '../analyzer/declarationUtils';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import * as ViperTypes from '../analyzer/types';
import { isCallableType, isLiteralType } from '../analyzer/typeUtils';
import { CaseSensitivityDetector } from '../common/caseSensitivityDetector';
import * as debug from '../common/debug';
import { FileSystem } from '../common/fileSystem';
import { convertOffsetsToRange, convertPositionToOffset } from '../common/positionUtils';
import { TextRange } from '../common/textRange';
import { Uri } from '../common/uri/uri';
import { convertUriToLspUriString } from '../common/uri/uriUtils';
import * as ViperNodes from '../parser/parseNodes';
import { ParserOutput } from '../parser/parser';

import { convertLspUriStringToUri } from './serverUtils';
import { ISymbolLookup, ParseResults } from './programTypes';

import { INotebookUriMapper } from './notebookUriMapper';

export interface IParserOutputProvider extends CaseSensitivityDetector {
    getUri(node: ViperNodes.ParseNode): Uri;
    getParserOutput(uri: Uri): ParserOutput | undefined;
    readonly fs: FileSystem;
    readonly uriMapper?: INotebookUriMapper;
    // Parse and return the results for stub code with a dummy URI
    // If directoryUri is provided, the stub URI will be created in that directory
    addStubCode(code: string, directoryUri?: Uri): { uri: Uri; parseResults: ParseResults };
}

export function toProtocolNode(node: ViperNodes.ParseNode, provider: IParserOutputProvider): TypeServerProtocol.Node {
    const uri = provider.getUri(node);
    const results = provider.getParserOutput(uri);
    if (!results) {
        throw new Error(`Unable to find parse results for ${uri}`);
    }
    const range = convertOffsetsToRange(node.start, node.start + node.length, results.lines);

    // Before becoming a protocol node, we need to convert the uri to an LSP URI string.
    const uriString = convertUriToLspUriString(provider.fs, uri);
    return {
        uri: uriString,
        range,
    };
}

export function fromProtocolNode<T extends ViperNodes.ParseNodeBase<ViperNodes.ParseNodeType>>(
    node: TypeServerProtocol.Node,
    resultsProvider: IParserOutputProvider,
    typeHints?: ViperNodes.ParseNodeType[]
): T {
    const uri = convertLspUriStringToUri(node.uri, resultsProvider, resultsProvider.uriMapper);
    const mappedUri = resultsProvider.fs.getMappedUri(uri);
    const parserOutput = resultsProvider.getParserOutput(mappedUri);
    const rootNode = parserOutput?.parseTree;
    if (!rootNode) {
        throw new Error(`Unable to find parse results for ${node.uri}`);
    }
    const start = convertPositionToOffset(node.range.start, parserOutput.lines);
    const end = convertPositionToOffset(node.range.end, parserOutput.lines);
    if (start === undefined || end === undefined) {
        throw new Error(`Invalid range for node: ${JSON.stringify(node)}`);
    }

    function keepNewType(oldType: ViperNodes.ParseNodeType, newType: ViperNodes.ParseNodeType) {
        if (typeHints) {
            return typeHints.some((t) => t === newType);
        }
        switch (oldType) {
            case ViperNodes.ParseNodeType.Name:
                return newType !== ViperNodes.ParseNodeType.Name;
            case ViperNodes.ParseNodeType.StringList:
                return newType !== ViperNodes.ParseNodeType.String;
            case ViperNodes.ParseNodeType.String:
                return newType === ViperNodes.ParseNodeType.StringList;
            case ViperNodes.ParseNodeType.Number:
                return newType === ViperNodes.ParseNodeType.Slice;
            case ViperNodes.ParseNodeType.Slice:
                return newType !== ViperNodes.ParseNodeType.Number;
            case ViperNodes.ParseNodeType.ModuleName:
                return (
                    newType === ViperNodes.ParseNodeType.Import ||
                    newType === ViperNodes.ParseNodeType.ImportFrom ||
                    newType === ViperNodes.ParseNodeType.ImportAs ||
                    newType === ViperNodes.ParseNodeType.ImportFromAs
                );
            case ViperNodes.ParseNodeType.Import:
            case ViperNodes.ParseNodeType.ImportFrom:
            case ViperNodes.ParseNodeType.ImportAs:
            case ViperNodes.ParseNodeType.ImportFromAs:
                return newType !== ViperNodes.ParseNodeType.ModuleName;
            case ViperNodes.ParseNodeType.Error:
                return newType !== ViperNodes.ParseNodeType.Error;
            default:
                return true;
        }
    }

    // Now that we have the root node, we can search for the node that contains the range.
    class ParseTreeWalkerImpl extends ParseTreeWalker {
        private _range: TextRange;
        private _bestMatch: ViperNodes.ParseNode = rootNode!;
        private _bestMatchType: ViperNodes.ParseNodeType = ViperNodes.ParseNodeType.Error;

        constructor(private _start: number, private _length: number) {
            super();
            this._range = TextRange.create(_start, _length);
        }

        getBestMatch(): ViperNodes.ParseNode {
            return this._bestMatch;
        }

        override visitNode(node: ViperNodes.ParseNode): ViperNodes.ParseNodeArray {
            if (
                node.start === this._start &&
                node.length >= this._length &&
                this._bestMatch.length >= node.length &&
                keepNewType(this._bestMatchType, node.nodeType)
            ) {
                this._bestMatchType = node.nodeType;
                this._bestMatch = node;
            }

            // Perform the same special case that findNodeByOffset does for augmented assignments. leftExpr is
            // not searched, but rather the destExpr is.
            if (node.nodeType === ViperNodes.ParseNodeType.AugmentedAssignment) {
                return [node.d.destExpr, node.d.rightExpr];
            }

            return super.visitNode(node);
        }

        override walk(node: ViperNodes.ParseNode): void {
            if (!TextRange.overlapsRange(this._range, node)) {
                // If the node doesn't overlap with the range, we can skip it.
                return;
            }

            super.walk(node);
        }
    }

    const walker = new ParseTreeWalkerImpl(start, end - start);
    walker.walk(rootNode);
    const bestMatch = walker.getBestMatch();
    if (typeHints && !typeHints.some((t) => t === bestMatch.nodeType)) {
        // The range may not line up exactly with the hinted node type (e.g. due to edits or
        // subtle parse differences). Prefer resiliency over crashing; retry without hints.
        return fromProtocolNode<T>(node, resultsProvider, /* typeHints */ undefined);
    }
    return bestMatch as T;
}

export function toProtocolDeclCategory(decl: ViperDecl.Declaration) {
    switch (decl.type) {
        case ViperDecl.DeclarationType.Intrinsic:
            return TypeServerProtocol.DeclarationCategory.Intrinsic;
        case ViperDecl.DeclarationType.Function:
            return TypeServerProtocol.DeclarationCategory.Function;
        case ViperDecl.DeclarationType.Class:
        case ViperDecl.DeclarationType.SpecialBuiltInClass:
            return TypeServerProtocol.DeclarationCategory.Class;
        case ViperDecl.DeclarationType.Param:
            return TypeServerProtocol.DeclarationCategory.Param;
        case ViperDecl.DeclarationType.TypeParam:
            return TypeServerProtocol.DeclarationCategory.TypeParam;
        case ViperDecl.DeclarationType.TypeAlias:
            return TypeServerProtocol.DeclarationCategory.TypeAlias;
        case ViperDecl.DeclarationType.Variable:
            return TypeServerProtocol.DeclarationCategory.Variable;
        case ViperDecl.DeclarationType.Alias:
            return TypeServerProtocol.DeclarationCategory.Import;
        default:
            throw new Error(`Unknown declaration type: ${(decl as any).type}`);
    }
}

export function toProtocolDecl(
    decl: ViperDecl.Declaration,
    provider: IParserOutputProvider
): TypeServerProtocol.Declaration {
    const wrap: IParserOutputProvider = {
        fs: provider.fs,
        uriMapper: provider.uriMapper,
        isCaseSensitive: (uri) => provider.isCaseSensitive(uri),
        getUri: (node) => (decl.node ? provider.getUri(decl.node) : decl.uri),
        getParserOutput: (uri) => provider.getParserOutput(uri),
        addStubCode: (code) => provider.addStubCode(code),
    };

    if (!decl.node) {
        return {
            kind: TypeServerProtocol.DeclarationKind.Synthesized,
            uri: convertUriToLspUriString(provider.fs, decl.uri),
        };
    }

    return {
        kind: TypeServerProtocol.DeclarationKind.Regular,
        category: toProtocolDeclCategory(decl),
        node: toProtocolNode(decl.node, wrap),
        name: getSymbolNameFromDeclaration(decl),
    };
}

/**
 * Build a stable string key for a TSP `Declaration`. Used to cache
 * `fromProtocolDecl` results on a snapshot.
 *
 * The key intentionally captures only the protocol-visible identity of the
 * declaration (uri + range + kind/category + name) so that distinct TSP
 * `Declaration` object instances that refer to the same source-level
 * declaration share a cache entry.
 */
export function getProtocolDeclKey(decl: TypeServerProtocol.Declaration): string {
    if (decl.kind === TypeServerProtocol.DeclarationKind.Synthesized) {
        return `s:${decl.uri}`;
    }
    const r = decl.node.range;
    return `r:${decl.node.uri}:${r.start.line},${r.start.character}-${r.end.line},${r.end.character}:${decl.category}:${
        decl.name ?? ''
    }`;
}

export function fromProtocolDecl(
    decl: TypeServerProtocol.Declaration,
    resultsProvider: IParserOutputProvider,
    symbolLookup: ISymbolLookup
): ViperDecl.Declaration | undefined {
    if (decl.kind === TypeServerProtocol.DeclarationKind.Synthesized) {
        return synthesizeAliasDeclaration(
            convertLspUriStringToUri(decl.uri, resultsProvider, resultsProvider.uriMapper)
        );
    }

    if (!decl.name) {
        return undefined;
    }

    const hints = getParseNodeTypesForDecl(decl);

    // Try to get the node from the protocol - if this fails (e.g., file not available in this context
    // or the range is invalid because the external server uses a different version of the file),
    // fall back to the module root node so we can still look up the symbol by name.
    let node: ViperNodes.ParseNode | undefined;
    try {
        node = fromProtocolNode<ViperNodes.ParseNode>(decl.node, resultsProvider, hints);
    } catch (error) {
        // Try to get the module root node as a fallback for symbol lookup.
        if (decl.node?.uri) {
            try {
                const uri = convertLspUriStringToUri(decl.node.uri, resultsProvider, resultsProvider.uriMapper);
                const mappedUri = resultsProvider.fs.getMappedUri(uri);
                const parserOutput = resultsProvider.getParserOutput(mappedUri);
                if (parserOutput?.parseTree) {
                    node = parserOutput.parseTree;
                }
            } catch {
                // Ignore - will fall through to return undefined below.
            }
        }
        if (!node) {
            return undefined;
        }
    }

    if (decl.category !== TypeServerProtocol.DeclarationCategory.Import && !node) {
        return undefined;
    }

    if (!node) {
        return undefined;
    }

    const symbol = symbolLookup.lookupSymbol(node, decl.name);
    if (!symbol) {
        return undefined;
    }

    // Helper to check if a declaration matches the expected category type.
    const matchesDeclCategory = (d: ViperDecl.Declaration): boolean => {
        switch (decl.category) {
            case TypeServerProtocol.DeclarationCategory.Import:
                return ViperDecl.isAliasDeclaration(d);
            case TypeServerProtocol.DeclarationCategory.Intrinsic:
                return ViperDecl.isIntrinsicDeclaration(d);
            case TypeServerProtocol.DeclarationCategory.Variable:
                return ViperDecl.isVariableDeclaration(d);
            case TypeServerProtocol.DeclarationCategory.Param:
                return ViperDecl.isParamDeclaration(d);
            case TypeServerProtocol.DeclarationCategory.TypeParam:
                return ViperDecl.isTypeParamDeclaration(d);
            case TypeServerProtocol.DeclarationCategory.TypeAlias:
                return ViperDecl.isTypeAliasDeclaration(d);
            case TypeServerProtocol.DeclarationCategory.Function:
                return ViperDecl.isFunctionDeclaration(d);
            case TypeServerProtocol.DeclarationCategory.Class:
                return ViperDecl.isClassDeclaration(d) || ViperDecl.isSpecialBuiltInClassDeclaration(d);
            default:
                return false;
        }
    };

    // Helper to check if a declaration's node matches the protocol node identity.
    const matchesNodeIdentity = (d: ViperDecl.Declaration): boolean => {
        if (d.node === node) {
            return true;
        }
        // For Function/Class declarations, also check if the name node matches.
        if (ViperDecl.isFunctionDeclaration(d) && d.node.d.name === node) {
            return true;
        }
        if (ViperDecl.isClassDeclaration(d) && d.node.d.name === node) {
            return true;
        }
        return false;
    };

    const allDecls = symbol.getDeclarations();

    // First try: exact node identity match (preferred).
    const exactMatch = allDecls.find((d) => matchesDeclCategory(d) && matchesNodeIdentity(d));
    if (exactMatch) {
        return exactMatch;
    }

    // Fallback: when the external type server provides imprecise node ranges (e.g., file-level
    // ranges that resolve to the Module node instead of the actual declaration node), the node
    // identity check fails. In that case, fall back to matching by category alone. Since
    // lookupSymbol already constrained to the correct symbol, this is safe.
    return allDecls.find((d) => matchesDeclCategory(d));
}

export function getSymbolNameFromDeclaration(declaration: ViperDecl.Declaration): string | undefined {
    switch (declaration.type) {
        case ViperDecl.DeclarationType.Alias: {
            if (declaration.node.nodeType === ViperNodes.ParseNodeType.ImportFrom) {
                if (declaration.node.d.isWildcardImport) {
                    return declaration.symbolName;
                }

                return declaration.node.d.module.d.nameParts[0].d.value;
            }

            if (declaration.node.nodeType === ViperNodes.ParseNodeType.ImportFromAs) {
                const nameNode = declaration.node.d.alias || declaration.node.d.name;
                return nameNode.d.value;
            }

            if (declaration.node.nodeType === ViperNodes.ParseNodeType.ImportAs) {
                return declaration.node.d.alias
                    ? declaration.node.d.alias.d.value
                    : declaration.node.d.module.d.nameParts[0].d.value;
            }

            return undefined;
        }
        case ViperDecl.DeclarationType.Class:
        case ViperDecl.DeclarationType.Function:
        case ViperDecl.DeclarationType.TypeParam:
        case ViperDecl.DeclarationType.TypeAlias:
            return declaration.node.d.name.d.value;

        case ViperDecl.DeclarationType.Param:
            return declaration.node.d.name?.d.value;

        case ViperDecl.DeclarationType.Variable: {
            const node = declaration.node;
            return node.nodeType === ViperNodes.ParseNodeType.Name
                ? node.d.value
                : node.nodeType === ViperNodes.ParseNodeType.StringList
                ? node.d.strings[0].d.value
                : undefined;
        }
        case ViperDecl.DeclarationType.Intrinsic:
            return declaration.name;
        case ViperDecl.DeclarationType.SpecialBuiltInClass:
            return declaration.node.d.valueExpr.nodeType === ViperNodes.ParseNodeType.Name
                ? declaration.node.d.valueExpr.d.value
                : undefined;
        default: {
            debug.assertNever(declaration);
        }
    }
}

export function getParseNodeTypesForDecl(decl: TypeServerProtocol.Declaration): ViperNodes.ParseNodeType[] {
    if (decl.kind === TypeServerProtocol.DeclarationKind.Synthesized) {
        // Synthesized declarations don't have an associated node.
        return [];
    }

    switch (decl.category) {
        case TypeServerProtocol.DeclarationCategory.Import: {
            return [
                ViperNodes.ParseNodeType.ImportAs,
                ViperNodes.ParseNodeType.ImportFromAs,
                ViperNodes.ParseNodeType.ImportFrom,
            ];
        }
        case TypeServerProtocol.DeclarationCategory.Intrinsic: {
            return [
                ViperNodes.ParseNodeType.Module |
                    ViperNodes.ParseNodeType.Function |
                    ViperNodes.ParseNodeType.Class,
            ];
        }
        case TypeServerProtocol.DeclarationCategory.Variable: {
            return [ViperNodes.ParseNodeType.Name, ViperNodes.ParseNodeType.StringList];
        }
        case TypeServerProtocol.DeclarationCategory.Param: {
            return [ViperNodes.ParseNodeType.Parameter];
        }
        case TypeServerProtocol.DeclarationCategory.TypeParam: {
            return [ViperNodes.ParseNodeType.TypeParameter];
        }
        case TypeServerProtocol.DeclarationCategory.TypeAlias: {
            return [ViperNodes.ParseNodeType.TypeAlias];
        }
        case TypeServerProtocol.DeclarationCategory.Function: {
            return [ViperNodes.ParseNodeType.Function];
        }
        case TypeServerProtocol.DeclarationCategory.Class: {
            return [ViperNodes.ParseNodeType.Class, ViperNodes.ParseNodeType.TypeAnnotation];
        }
    }
}

export function toProtocolTypeFlags(type: ViperTypes.Type): TypeServerProtocol.TypeFlags {
    let flags = TypeServerProtocol.TypeFlags.None;
    if (ViperTypes.isClass(type) && isLiteralType(type)) {
        flags |= TypeServerProtocol.TypeFlags.Literal;
    }
    if (ViperTypes.isClass(type) && type.shared.typeParams.length > 0) {
        flags |= TypeServerProtocol.TypeFlags.Generic;
    }
    if (ViperTypes.TypeBase.isInstance(type)) {
        flags |= TypeServerProtocol.TypeFlags.Instance;
    }
    if (ViperTypes.TypeBase.isInstantiable(type)) {
        flags |= TypeServerProtocol.TypeFlags.Instantiable;
    }
    if (isCallableType(type)) {
        flags |= TypeServerProtocol.TypeFlags.Callable;
    }
    if (ViperTypes.isClass(type) && ViperTypes.ClassType.isProtocolClass(type)) {
        flags |= TypeServerProtocol.TypeFlags.Interface;
    }
    if (type.props?.typeAliasInfo) {
        flags |= TypeServerProtocol.TypeFlags.FromAlias;
    }
    if (ViperTypes.isUnpacked(type)) {
        flags |= TypeServerProtocol.TypeFlags.Unpacked;
    }
    return flags;
}

export function toProtocolVariance(
    variance: ViperTypes.Variance | undefined
): TypeServerProtocol.Variance | undefined {
    if (variance === undefined) {
        return undefined;
    }

    switch (variance) {
        case ViperTypes.Variance.Auto:
            return TypeServerProtocol.Variance.Auto;
        case ViperTypes.Variance.Unknown:
            return TypeServerProtocol.Variance.Unknown;
        case ViperTypes.Variance.Invariant:
            return TypeServerProtocol.Variance.Invariant;
        case ViperTypes.Variance.Covariant:
            return TypeServerProtocol.Variance.Covariant;
        case ViperTypes.Variance.Contravariant:
            return TypeServerProtocol.Variance.Contravariant;
        default:
            debug.assertNever(variance);
    }

    return TypeServerProtocol.Variance.Unknown;
}
