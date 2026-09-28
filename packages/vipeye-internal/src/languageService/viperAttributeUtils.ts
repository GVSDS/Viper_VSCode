/*
 * viperAttributeUtils.ts
 *
 * Viper `__attribute__(...)` 的共享工具：文本上下文识别 + `t.attr` 属性成员查找。
 *
 * 由 completionProvider（括号内属性名补全）与 hoverProvider（括号内属性名提示）共用，
 * 避免两处各写一份 `t.attr` 查找逻辑导致口径漂移。
 *
 * 属性名是编译器级的**开放集合**，故清单 = `t.attr` 已声明的名字 ∪ 编译器 codegen
 * 支持但未声明的名字（见 VIPER_UNDECLARED_ATTRIBUTE_NAMES），不能只依赖存根声明。
 *
 * 为什么用文本扫描定位上下文：`__attribute__(...)` 在 parser 里会被脱糖
 * （装饰器 → `@c.Attribute(t.attr.X, ...)`；注解修饰器 → `t.attr.X | 内层类型`），
 * 原始调用节点不保留在 parse 树中，光标位置（尤其实参为空或拼写未完成时）
 * 没有可命中的节点。
 */

import { getScopeForNode } from '../analyzer/scopeUtils';
import { Symbol, SymbolTable } from '../analyzer/symbol';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ClassType, isFunctionOrOverloaded, isInstantiableClass, isModule, ModuleType } from '../analyzer/types';
import { ParseNode } from '../parser/parseNodes';

export interface ViperAttributeContext {
    /** `__attribute__` 名字的起始 offset（用于 hover 范围锚点）。 */
    nameStart: number;
    /** `__attribute__` 名字之后 `(` 的 offset（光标必须在其右侧才算在括号内）。 */
    openParen: number;
}

// 编译器（TransPyV）codegen 支持、但 `class attr` 里**未声明**的属性名。
//
// 属性名是编译器级的**开放集合**：TransPyV 的 codegen 映射里支持的名字不一定都
// 声明在 `t.attr`（TransPyC 的 `lib/includes/t.py` / LSP 存根 `t.vpi` 的
// `class attr` 两边一致，都没有 `stackrealign`）。补全/悬停若只枚举 `t.attr`，
// 这类名字就看不到，故在此显式补齐。
// 来源：TransPyC/TransPyV/App/lib/core/Gen/Func/FuncGenBase.vp（`attr_name ==
//   "stackrealign"` → LLVM `"stackrealign"` 属性）；
// 真实用例：ViperOS `VKernel/Kernel/main.vp`
//   `@__attribute__(section(".text.startup"), aligned(16), stackrealign)`。
export const VIPER_UNDECLARED_ATTRIBUTE_NAMES: readonly string[] = ['stackrealign'];

// 补全/悬停用的**属性名全集**：`t.attr` 已声明的名字 ∪ 上面补齐的未声明名字，
// 排序去重。属性名是开放集合，不能只依赖 `t.attr` 的声明。
export function getViperAttributeNames(attributeInfo: { symbolTable: SymbolTable }): string[] {
    const names = new Set<string>(attributeInfo.symbolTable.keys());
    VIPER_UNDECLARED_ATTRIBUTE_NAMES.forEach((name) => names.add(name));
    return Array.from(names).sort();
}

// `t.attr` 里**未声明**、只在编译器 codegen 里支持的属性名（补全时单独注入，
// 已声明的走符号表，避免重复）。
export function getViperUndeclaredAttributeNames(attributeInfo: { symbolTable: SymbolTable }): string[] {
    return VIPER_UNDECLARED_ATTRIBUTE_NAMES.filter((name) => !attributeInfo.symbolTable.has(name));
}

// 判断 `offset` 是否位于 `__attribute__(...)` 的实参括号内，是则返回上下文。
// 扫描方式：从光标向前找最近的未闭合 `(`（跳过已输入的属性名/实参），
// 该 `(` 左侧（允许空白分隔）的标识符必须是 `__attribute__`。
// 遇到行尾 / `;`（深度为 0 时）即停止，避免跨语句误判。
export function findViperAttributeContext(fileContents: string, offset: number): ViperAttributeContext | undefined {
    let depth = 0;
    let openParen = -1;

    for (let i = offset - 1; i >= 0; i--) {
        const curChar = fileContents[i];
        if (curChar === ')') {
            depth++;
        } else if (curChar === '(') {
            if (depth === 0) {
                openParen = i;
                break;
            }
            depth--;
        } else if ((curChar === '\n' || curChar === ';') && depth === 0) {
            break;
        }
    }

    if (openParen < 0) {
        return undefined;
    }

    // `(` 左侧（允许空白分隔）必须是 `__attribute__`。
    let nameEnd = openParen;
    while (nameEnd > 0 && /\s/.test(fileContents[nameEnd - 1])) {
        nameEnd--;
    }
    let nameStart = nameEnd;
    while (nameStart > 0 && /[\p{L}\p{N}_]/u.test(fileContents[nameStart - 1])) {
        nameStart--;
    }
    if (fileContents.slice(nameStart, nameEnd) !== '__attribute__') {
        return undefined;
    }

    return { nameStart, openParen };
}

// 取 `t.attr` 类**自身声明**的属性方法（只保留函数成员，排除嵌套的 llvm 描述符类等）。
// 返回 undefined 表示没有可用的 `t` 模块 / `attr` 类（如源码未 `import t`）。
// 只用 attr 类自身的符号表（不合并 MRO），避免把 CType/object 的继承成员
// （__init__ / __or__ 等）当成属性名。
export function getViperAttributeSymbols(
    evaluator: TypeEvaluator,
    scopeNode: ParseNode
): { symbolTable: SymbolTable; attrClass: ClassType } | undefined {
    // 取 `t` 模块：优先本文件的 `import t`，否则沿 scope 链回退到 builtins 作用域
    // （builtins.vpi 通过 `from t import ...` 绑定了 `t`）—— 与 `__attribute__`
    // 脱糖出的隐式 `t` 一致（源码不 import t 时属性名补全/悬停仍应可用）。
    let scope = getScopeForNode(scopeNode);
    let tSymbol: Symbol | undefined;
    while (scope && !tSymbol) {
        tSymbol = scope.lookUpSymbol('t');
        scope = scope.parent;
    }
    if (!tSymbol) {
        return undefined;
    }
    const tType = evaluator.getEffectiveTypeOfSymbol(tSymbol);
    if (!isModule(tType)) {
        return undefined;
    }

    const attrSymbol = ModuleType.getField(tType, 'attr');
    if (!attrSymbol) {
        return undefined;
    }
    const attrType = evaluator.getEffectiveTypeOfSymbol(attrSymbol);
    if (!isInstantiableClass(attrType)) {
        return undefined;
    }

    const symbolTable: SymbolTable = new Map<string, Symbol>();
    ClassType.getSymbolTable(attrType).forEach((symbol, name) => {
        if (isFunctionOrOverloaded(evaluator.getEffectiveTypeOfSymbol(symbol))) {
            symbolTable.set(name, symbol);
        }
    });

    return { symbolTable, attrClass: attrType };
}
