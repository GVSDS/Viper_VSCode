/*
 * semanticTokenTypes.ts
 *
 * Vipeye 语义高亮 token 类型与修饰符定义。
 * 参考 LSP 3.16 SemanticTokens 规范。
 *
 * tokenTypes 数组索引即 token type 编码（LSP 协议要求）。
 * tokenModifiers 数组索引即 bit 位（按位或组合）。
 */

/** 语义 token 类型（索引即编码） */
export const enum SemanticTokenTypes {
    /** 命名空间/模块 */
    namespace = 0,
    /** 类 */
    class = 1,
    /** 函数 */
    function = 2,
    /** 已定义变量 */
    variable = 3,
    /** 函数参数 */
    parameter = 4,
    /** 类型注解 */
    type = 5,
    /** 内置类型/函数 */
    builtin = 6,
    /** 关键字 */
    keyword = 7,
    /** 字符串 */
    string = 8,
    /** 数字 */
    number = 9,
    /** 注释 */
    comment = 10,
    /** 未定义符号（显示为主题默认前景色，通常白色） */
    undefined = 11,
    /** 装饰器 */
    decorator = 12,
    /** 属性 */
    property = 13,
}

/** 语义 token 修饰符（位掩码） */
export const enum SemanticTokenModifiers {
    /** 声明处 */
    declaration = 1 << 0,
    /** 定义处 */
    definition = 1 << 1,
    /** 只读 */
    readonly = 1 << 2,
    /** 静态 */
    static = 1 << 3,
    /** 弃用 */
    deprecated = 1 << 4,
}

/** LSP legend 中的 tokenTypes 字符串列表（顺序与枚举值对应） */
export const semanticTokenTypesLegend: string[] = [
    'namespace',
    'class',
    'function',
    'variable',
    'parameter',
    'type',
    'builtin',
    'keyword',
    'string',
    'number',
    'comment',
    'undefined',
    'decorator',
    'property',
];

/** LSP legend 中的 tokenModifiers 字符串列表（顺序与 bit 位对应） */
export const semanticTokenModifiersLegend: string[] = [
    'declaration',
    'definition',
    'readonly',
    'static',
    'deprecated',
];
