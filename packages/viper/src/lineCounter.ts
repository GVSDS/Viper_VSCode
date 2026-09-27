/*
 * lineCounter.ts
 * 项目 LOC（代码行）统计：递归扫描工程源目录，按「已知语言」汇总文件数与行数。
 *
 * 只依赖 Node 的 fs/path，不引用 vscode，便于单独复用与测试；
 * 展示层（locReportView.ts）负责进度条、图表与报表渲染。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 一种已知语言：扩展名集合 + 注释语法。 */
export interface KnownLanguage {
    /** 语言显示名（报表中的一行）。 */
    Name: string;
    /** 归属该语言的扩展名（小写，含点）。 */
    Extensions: string[];
    /** 行注释前缀；无行注释时为空数组。 */
    LineCommentPrefixes: string[];
    /** 块注释定界符；无块注释时留空。 */
    BlockComments?: { Start: string; End: string }[];
}

/**
 * 已知语言表（统计范围）。
 * Viper 系列与 vscode-vipeye 的 languages 贡献点一致（.vp/.vpi/.vpnci，另有 .vpj 工程文件），
 * 并按用户要求支持 .def（定义文件）：既可能是 MODULE-DEFINITION 的 ';' 行注释，
 * 也可能是 C 风格的 '//' 行注释与块注释，故三者都识别。
 */
export const KnownLanguages: KnownLanguage[] = [
    { Name: 'Viper', Extensions: ['.vp'], LineCommentPrefixes: ['#'] },
    { Name: 'Viper Stub', Extensions: ['.vpi'], LineCommentPrefixes: ['#'] },
    { Name: 'Viper Annotation', Extensions: ['.vpnci'], LineCommentPrefixes: ['#'] },
    { Name: 'Viper Project', Extensions: ['.vpj'], LineCommentPrefixes: [] },
    {
        Name: 'Definition',
        Extensions: ['.def'],
        LineCommentPrefixes: [';', '//'],
        BlockComments: [{ Start: '/*', End: '*/' }],
    },
];

/** 扩展名 → 语言（由 KnownLanguages 展开）。 */
const ExtensionToLanguage = new Map<string, KnownLanguage>();
for (const language of KnownLanguages) {
    for (const extension of language.Extensions) {
        ExtensionToLanguage.set(extension, language);
    }
}

/** 固定跳过的目录名：依赖、版本库元数据、字节码缓存。 */
const SkippedDirectoryNames = new Set(['node_modules', '.git', '__pycache__']);

/** 单语言 / 汇总的行数统计。 */
export interface LineCount {
    FileCount: number;
    TotalLines: number;
    CodeLines: number;
    CommentLines: number;
    BlankLines: number;
    /** 字符数（不含换行符），用于算平均行字符数。 */
    Chars: number;
}

/** 派生指标。 */
export interface LocMetrics {
    /** 注释率 = 注释行 /（代码行 + 注释行）；无非空行时为 0。 */
    CommentRate: number;
    /** 平均行字符数 = 字符数 / 总行数。 */
    AverageLineLength: number;
}

/** 报表的一行（语言明细 / 合计）。 */
export interface LocReportRow extends LineCount, LocMetrics {
    Language: string;
}

/** 一次 LOC 统计的结果。 */
export interface LocReport {
    /** 被扫描的源目录（绝对路径）。 */
    SourceDir: string;
    /** 扫描时跳过的子目录（相对源目录的路径）。 */
    SkippedDirectories: string[];
    /** 按语言的汇总（代码行降序，只含确实存在文件的语言）。 */
    Languages: LocReportRow[];
    /** 全部已知语言的合计。 */
    Total: LocReportRow;
}

/** 扫描进度（用于进度条）。 */
export interface LocScanProgress {
    /** 已统计完成的文件数。 */
    ProcessedFiles: number;
    /** 待统计的已知语言文件总数。 */
    TotalFiles: number;
    /** 当前文件（相对源目录）。 */
    CurrentFile: string;
}

/** 行分类：代码 / 注释 / 空行。 */
type LineKind = 'code' | 'comment' | 'blank';

/** 逐行扫描的跨行状态（块注释未闭合时的结束定界符）。 */
interface ScanState {
    InBlockCommentEnd: string | undefined;
}

/** 待统计的文件。 */
interface ScannedFile {
    FilePath: string;
    Language: KnownLanguage;
}

/** 创建全 0 的行数计数。 */
export function CreateEmptyLineCount(): LineCount {
    return { FileCount: 0, TotalLines: 0, CodeLines: 0, CommentLines: 0, BlankLines: 0, Chars: 0 };
}

/** 把 source 累加进 target（原地）。 */
export function AccumulateLineCount(target: LineCount, source: LineCount): void {
    target.FileCount += source.FileCount;
    target.TotalLines += source.TotalLines;
    target.CodeLines += source.CodeLines;
    target.CommentLines += source.CommentLines;
    target.BlankLines += source.BlankLines;
    target.Chars += source.Chars;
}

/** 注释率 = 注释行 /（代码行 + 注释行）。 */
export function ComputeCommentRate(count: LineCount): number {
    const nonBlankLines = count.CodeLines + count.CommentLines;
    return nonBlankLines > 0 ? count.CommentLines / nonBlankLines : 0;
}

/** 平均行字符数 = 字符数 / 总行数。 */
export function ComputeAverageLineLength(count: LineCount): number {
    return count.TotalLines > 0 ? count.Chars / count.TotalLines : 0;
}

/** 取文件所属的已知语言；未登记（或没有扩展名）返回 undefined。 */
export function GetKnownLanguage(filePath: string): KnownLanguage | undefined {
    const extension = path.extname(filePath).toLowerCase();
    if (!extension) {
        return undefined;
    }
    return ExtensionToLanguage.get(extension);
}

/**
 * 统计一段文本的行数（纯函数，按语言的注释语法分类）。
 * 行尾的最后一个换行不算作额外空行；跨行的块注释正确归为注释。
 */
export function CountTextLines(content: string, language: KnownLanguage): LineCount {
    const count = CreateEmptyLineCount();
    count.FileCount = 1;

    const lines = content.split(/\r\n|\r|\n/);
    // "a\n" 切出 ['a', '']：结尾换行不产生额外空行。
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    const state: ScanState = { InBlockCommentEnd: undefined };
    for (const line of lines) {
        count.TotalLines += 1;
        count.Chars += line.length;
        switch (ClassifyLine(line, language, state)) {
            case 'code':
                count.CodeLines += 1;
                break;
            case 'comment':
                count.CommentLines += 1;
                break;
            default:
                count.BlankLines += 1;
                break;
        }
    }

    return count;
}

/** 读取并统计单个文件；读取失败按全 0 计（不中断整次统计）。 */
export async function CountFileLines(filePath: string, language: KnownLanguage): Promise<LineCount> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return CountTextLines(content, language);
    } catch {
        return CreateEmptyLineCount();
    }
}

/**
 * 统计工程源目录下所有已知语言的行数。
 * extraSkipDirectories 传工程构建目录（源目录内的构建产物不参与统计）。
 * onProgress 每读完一个文件回调一次（先回调一次 ProcessedFiles = 0 的总数播报）。
 */
export async function CountProjectLoc(
    sourceDir: string,
    extraSkipDirectories: string[] = [],
    onProgress?: (progress: LocScanProgress) => void
): Promise<LocReport> {
    const skippedDirectories: string[] = [];
    const files: ScannedFile[] = [];
    const extraSkipPaths = new Set(extraSkipDirectories.map((directory) => path.resolve(directory)));

    // 阶段一：先收集文件清单，得到总数（进度条的分母）。
    await CollectKnownFiles(sourceDir, sourceDir, extraSkipPaths, skippedDirectories, files);

    const totalFiles = files.length;
    onProgress?.({ ProcessedFiles: 0, TotalFiles: totalFiles, CurrentFile: '' });

    // 阶段二：逐个统计并汇报进度。
    const counts = new Map<string, LineCount>();
    for (const [index, file] of files.entries()) {
        const current = counts.get(file.Language.Name) ?? CreateEmptyLineCount();
        AccumulateLineCount(current, await CountFileLines(file.FilePath, file.Language));
        counts.set(file.Language.Name, current);

        onProgress?.({
            ProcessedFiles: index + 1,
            TotalFiles: totalFiles,
            CurrentFile: path.relative(sourceDir, file.FilePath),
        });
    }

    // 只保留确实存在文件的语言，按代码行降序。
    const languages: LocReportRow[] = [];
    for (const language of KnownLanguages) {
        const count = counts.get(language.Name);
        if (count && count.FileCount > 0) {
            languages.push(CreateReportRow(language.Name, count));
        }
    }
    languages.sort((left, right) => right.CodeLines - left.CodeLines);

    const total = CreateEmptyLineCount();
    for (const entry of languages) {
        AccumulateLineCount(total, entry);
    }

    return {
        SourceDir: sourceDir,
        SkippedDirectories: skippedDirectories,
        Languages: languages,
        Total: CreateReportRow('Total', total),
    };
}

/** 生成可读报表（等宽对齐，供输出通道展示）。 */
export function FormatLocReport(report: LocReport, projectName: string, projectFile: string): string {
    const columnWidth = 12;
    const nameWidth = Math.max(
        18,
        'Language'.length,
        'Total'.length,
        ...report.Languages.map((entry) => entry.Language.length)
    );
    const formatRow = (name: string, count: LineCount & LocMetrics): string =>
        name.padEnd(nameWidth) +
        String(count.FileCount).padStart(columnWidth) +
        String(count.TotalLines).padStart(columnWidth) +
        String(count.CodeLines).padStart(columnWidth) +
        String(count.CommentLines).padStart(columnWidth) +
        String(count.BlankLines).padStart(columnWidth) +
        `${(count.CommentRate * 100).toFixed(1)}%`.padStart(columnWidth) +
        count.AverageLineLength.toFixed(1).padStart(columnWidth);

    const header =
        'Language'.padEnd(nameWidth) +
        'Files'.padStart(columnWidth) +
        'Total'.padStart(columnWidth) +
        'Code'.padStart(columnWidth) +
        'Comment'.padStart(columnWidth) +
        'Blank'.padStart(columnWidth) +
        'Comment%'.padStart(columnWidth) +
        'AvgLen'.padStart(columnWidth);

    const lines: string[] = [
        'Viper LOC 统计',
        `项目:     ${projectName}`,
        `工程文件: ${projectFile}`,
        `源目录:   ${report.SourceDir}`,
        `跳过目录: ${report.SkippedDirectories.length > 0 ? report.SkippedDirectories.join(', ') : '(none)'}`,
        '',
        header,
        '-'.repeat(header.length),
        ...report.Languages.map((entry) => formatRow(entry.Language, entry)),
        '-'.repeat(header.length),
        formatRow('Total', report.Total),
    ];

    return lines.join('\n');
}

/** 由行数计数构造带派生指标的报表行。 */
function CreateReportRow(language: string, count: LineCount): LocReportRow {
    return {
        Language: language,
        ...count,
        CommentRate: ComputeCommentRate(count),
        AverageLineLength: ComputeAverageLineLength(count),
    };
}

/** 递归收集源目录下所有已知语言的文件（跳过目录与符号链接）。 */
async function CollectKnownFiles(
    directory: string,
    sourceDir: string,
    extraSkipPaths: Set<string>,
    skippedDirectories: string[],
    files: ScannedFile[]
): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
        // 无权限 / 被占用：跳过该目录，不中断整次统计。
        return;
    }

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            if (ShouldSkipDirectory(entry.name, entryPath, extraSkipPaths)) {
                skippedDirectories.push(path.relative(sourceDir, entryPath) || entry.name);
                continue;
            }
            await CollectKnownFiles(entryPath, sourceDir, extraSkipPaths, skippedDirectories, files);
            continue;
        }

        // 符号链接一律跳过：避免环与重复计数。
        if (!entry.isFile()) {
            continue;
        }

        const language = GetKnownLanguage(entryPath);
        if (language) {
            files.push({ FilePath: entryPath, Language: language });
        }
    }
}

/** 目录是否不参与统计：依赖/元数据目录、隐藏目录（含 .tpv_build 这类构建产物）、工程构建目录。 */
function ShouldSkipDirectory(name: string, entryPath: string, extraSkipPaths: Set<string>): boolean {
    return SkippedDirectoryNames.has(name) || name.startsWith('.') || extraSkipPaths.has(entryPath);
}

/** 判断单行的类别；块注释状态在 state 上跨行传递。 */
function ClassifyLine(text: string, language: KnownLanguage, state: ScanState): LineKind {
    let rest = text;
    let sawComment = false;

    for (;;) {
        if (state.InBlockCommentEnd !== undefined) {
            const endIndex = rest.indexOf(state.InBlockCommentEnd);
            if (endIndex < 0) {
                // 整行仍在块注释内。
                return 'comment';
            }
            rest = rest.slice(endIndex + state.InBlockCommentEnd.length);
            state.InBlockCommentEnd = undefined;
            sawComment = true;
            continue;
        }

        const trimmed = rest.trimStart();
        if (trimmed.length === 0) {
            return sawComment ? 'comment' : 'blank';
        }

        if (language.LineCommentPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
            return 'comment';
        }

        const blockComment = (language.BlockComments ?? []).find((block) => trimmed.startsWith(block.Start));
        if (blockComment) {
            state.InBlockCommentEnd = blockComment.End;
            rest = trimmed.slice(blockComment.Start.length);
            sawComment = true;
            continue;
        }

        return 'code';
    }
}
