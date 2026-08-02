/*
 * dialect.ts
 * 语言方言：Vipeye 已转型为 Viper 专属 LSP 客户端，仅支持 Viper 方言。
 *
 * Python 模式已彻底移除。代码库中不再存在 Python 语义分支，
 * 所有分析均按 Viper 语义执行。
 */

/** 支持的语言方言（仅 Viper） */
export type LanguageDialect = 'viper';

/** 默认方言：Vipeye 已转型为 Viper 专属 LSP 客户端，默认方言为 Viper。 */
export const DefaultDialect: LanguageDialect = 'viper';

/** 判断当前方言是否为 Viper（恒为 true，Vipeye 仅支持 Viper） */
export function IsViperDialect(dialect: LanguageDialect | undefined): boolean {
    return true;
}

/** 从字符串解析方言，仅接受 'viper' */
export function ParseDialect(value: string | undefined): LanguageDialect | undefined {
    if (value === 'viper') {
        return 'viper';
    }
    return undefined;
}
