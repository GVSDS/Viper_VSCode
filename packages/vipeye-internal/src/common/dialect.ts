/*
 * dialect.ts
 * 语言方言开关：区分 Python 与 Viper 语义。
 *
 * Viper 是基于 CPython 语法但语义不同的 AOT 编译型语言。
 * 在 TPV --lsp 实现前，Pyright（Vipeye）作为姑息 LSP 充当分析器。
 * 通过 dialect 字段在 Python 语义与 Viper 语义之间切换。
 */

/** 支持的语言方言 */
export type LanguageDialect = 'python' | 'viper';

/** 默认方言：Vipeye 已转型为 Viper 专属 LSP 客户端，默认方言为 Viper。 */
export const DefaultDialect: LanguageDialect = 'viper';

/** 判断当前方言是否为 Viper */
export function IsViperDialect(dialect: LanguageDialect | undefined): boolean {
    return dialect === 'viper';
}

/** 判断当前方言是否为 Python */
export function IsPythonDialect(dialect: LanguageDialect | undefined): boolean {
    return dialect !== 'viper';
}

/** 从字符串解析方言，无效值返回 undefined */
export function ParseDialect(value: string | undefined): LanguageDialect | undefined {
    if (value === 'python' || value === 'viper') {
        return value;
    }
    return undefined;
}
