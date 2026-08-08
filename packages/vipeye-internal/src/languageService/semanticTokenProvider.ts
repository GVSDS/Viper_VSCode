/*
 * semanticTokenProvider.ts
 *
 * Vipeye 语义高亮提供器。
 * 基于 LSP 3.16 SemanticTokens 协议，复用 Vipeye 的 TypeEvaluator 判断符号定义状态。
 *
 * 缓存策略（模仿 Pylance 闭源设计）：
 *  - 内存缓存：Map<uri, CacheEntry>，文档变更时失效
 *  - 磁盘缓存：序列化 token 列表到临时目录，按文件内容 hash 索引
 *  - 增量计算：仅当文档分析完成且 hash 变化时重新生成
 *
 * Phase A 实现目标：
 *  - 区分已定义变量（蓝色）和未定义变量（白色/undefined）
 *  - 基础类型分类：class/function/parameter/namespace
 */

import * as AnalyzerNodeInfo from '../analyzer/analyzerNodeInfo';
import { Declaration, DeclarationType, VariableDeclaration } from '../analyzer/declaration';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { isWithinTypeAnnotation } from '../analyzer/parseTreeUtils';
import { TypeCategory, isCDefineType } from '../analyzer/types';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { LogTracker } from '../common/logTracker';
import { ProgramView } from '../common/extensibility';
import { convertOffsetToPosition } from '../common/positionUtils';
import { TextRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import { Uri } from '../common/uri/uri';
import {
    AssignmentNode,
    ClassNode,
    DecoratorNode,
    FormatStringNode,
    FunctionNode,
    MemberAccessNode,
    ModuleNameNode,
    ModuleNode,
    NameNode,
    NumberNode,
    ParseNodeType,
    StringNode,
    TypeAnnotationNode,
} from '../parser/parseNodes';
import { Token } from '../parser/tokenizerTypes';
import { SemanticTokenModifiers, SemanticTokenTypes } from './semanticTokenTypes';

// Node.js 文件系统模块（用于磁盘缓存）
import * as fs from 'fs';
import * as path from 'path';

/** 磁盘缓存条目的最大存活时间（7 天，单位毫秒） */
const DISK_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Viper 内置类型名集合。
 * 当符号声明为 Class/Function 且名字在此集合中时，使用 `builtin` token 类型。
 * 包含 Viper 语义下的基本类型（int/str/bytes 等）和 Python 兼容内置。
 */
const BUILTIN_TYPE_NAMES = new Set<string>([
    // 基本类型（Viper 语义：int=i32, str=bytes=i8*, 等）
    // 注意：这些类型在 semantic token 中作为 class 处理（非 builtin），
    // 以便正确显示为 class 颜色而非 builtin 颜色。
    'int', 'str', 'bytes', 'bool', 'float', 'complex',
    'list', 'dict', 'set', 'tuple', 'frozenset', 'bytearray', 'memoryview',
    'type', 'object', 'None', 'True', 'False',
    // Viper 特有
    't', 'c',
]);

/** 内置类型类名（用于 semantic token 中作为 class 而非 builtin 处理） */
const BUILTIN_CLASS_NAMES = new Set<string>([
    'int', 'str', 'bytes', 'bool', 'float', 'complex',
    'list', 'dict', 'set', 'tuple', 'frozenset', 'bytearray', 'memoryview',
    'type', 'object',
]);

/** LSP SemanticTokens 相对编码格式：[deltaLine, deltaStart, length, tokenType, tokenModifiers] */
type SemanticTokenData = number[];

/** 单个 token 原始数据 */
interface RawToken {
    line: number;
    startChar: number;
    length: number;
    tokenType: number;
    tokenModifiers: number;
}

/** 文件缓存条目 */
interface CacheEntry {
    /** 文件内容 hash（用于缓存命中判断） */
    contentHash: string;
    /** 编码后的 token 数据 */
    data: SemanticTokenData;
    /** 生成时间戳 */
    timestamp: number;
}

/**
 * 语义 token 提供器。
 * 通过遍历 ParseTree 中的 NameNode，结合 TypeEvaluator 判断符号定义状态，
 * 生成 LSP SemanticTokens 数据。
 */
export class SemanticTokenProvider {
    /** 内存缓存：uri → 缓存条目 */
    private readonly _memoryCache = new Map<string, CacheEntry>();
    /** 日志跟踪器 */
    private readonly _log: LogTracker;
    /** 磁盘缓存目录（可选，Phase A 预留接口） */
    private readonly _cacheDir: string | undefined;

    constructor(log: LogTracker, cacheDir?: string) {
        this._log = log;
        this._cacheDir = cacheDir;
    }

    /**
     * 提供完整文档的语义 token。
     * @param program Vipeye ProgramView 实例
     * @param fileUri 文件 URI
     * @returns LSP SemanticTokens（相对编码），若无分析结果返回 undefined
     */
    provideFull(program: ProgramView, fileUri: Uri): { data: SemanticTokenData } | undefined {
        return this._log.log(`SemanticTokenProvider.provideFull ${fileUri}`, () => {
            const parseResults = program.getParseResults(fileUri);
            if (!parseResults) {
                return undefined;
            }

            const parserOutput = parseResults.parserOutput;
            if (!parserOutput) {
                return undefined;
            }

            // 计算文件内容 hash，用于缓存命中判断
            const contentHash = this._computeHash(parseResults.text);
            const cacheKey = fileUri.toString();

            // 内存缓存命中
            const cached = this._memoryCache.get(cacheKey);
            if (cached && cached.contentHash === contentHash) {
                return { data: cached.data };
            }

            // 磁盘缓存命中（若启用，Phase A 预留）
            if (this._cacheDir) {
                const diskCached = this._tryLoadFromDisk(cacheKey, contentHash);
                if (diskCached) {
                    this._memoryCache.set(cacheKey, diskCached);
                    return { data: diskCached.data };
                }
            }

            // 生成新 token
            const evaluator = program.evaluator;
            if (!evaluator) {
                return undefined;
            }

            const tokens = this._collectTokens(
                parserOutput.parseTree,
                parserOutput.lines,
                evaluator,
                parseResults.tokenizerOutput
            );
            const data = this._encodeTokens(tokens);

            const entry: CacheEntry = {
                contentHash,
                data,
                timestamp: Date.now(),
            };
            this._memoryCache.set(cacheKey, entry);

            // 异步写入磁盘缓存（Phase A 预留）
            if (this._cacheDir) {
                this._trySaveToDisk(cacheKey, entry);
            }

            return { data };
        });
    }

    /**
     * 提供指定范围的语义 token。
     * 当前实现先生成完整 token 再过滤，后续可优化为仅遍历范围节点。
     */
    provideRange(
        program: ProgramView,
        fileUri: Uri,
        range: { startLine: number; endLine: number }
    ): { data: SemanticTokenData } | undefined {
        const full = this.provideFull(program, fileUri);
        if (!full) {
            return undefined;
        }

        // 解码后过滤范围，再重新编码
        const tokens = this._decodeTokens(full.data);
        const filtered = tokens.filter(
            (t) => t.line >= range.startLine && t.line <= range.endLine
        );
        return { data: this._encodeTokens(filtered) };
    }

    /** 使指定文件的缓存失效（文档变更时调用） */
    invalidate(uri: Uri): void {
        this._memoryCache.delete(uri.toString());
        // 同步删除磁盘缓存（避免下次加载到过期数据）
        if (this._cacheDir) {
            this._tryDeleteFromDisk(this._getCacheFilePath(uri.toString()));
        }
    }

    /** 清空所有缓存（内存 + 磁盘） */
    clear(): void {
        this._memoryCache.clear();
        if (this._cacheDir) {
            try {
                const entries = fs.readdirSync(this._cacheDir);
                for (const entry of entries) {
                    if (entry.endsWith('.json')) {
                        fs.unlinkSync(path.join(this._cacheDir, entry));
                    }
                }
            } catch {
                // 忽略清理失败
            }
        }
    }

    /**
     * 遍历 ParseTree 和 tokenizer token 流收集语义 token。
     * ParseTree 遍历：NameNode、MemberAccess、String、Number、Decorator 等。
     * Token 流遍历：关键字（KeywordToken）和注释（Comment）。
     * Viper 扩展：在 TextMate 规则被清空后，通过 LSP 语义高亮为关键字和注释着色。
     */
    private _collectTokens(
        parseTree: ModuleNode,
        lines: TextRangeCollection<TextRange>,
        evaluator: TypeEvaluator,
        tokenizerOutput?: { tokens: TextRangeCollection<Token> }
    ): RawToken[] {
        const tokens: RawToken[] = [];

        // 1. 遍历 tokenizer token 流，提取注释。
        //    注意：关键字（def/class/pass 等）不由 LSP semantic token 处理，
        //    而是由 TextMate 规则高亮（keyword.control.viper scope → 主题蓝色）。
        //    这样即使 semanticTokenScopes 配置未完全加载，关键字也能正确着色。
        if (tokenizerOutput) {
            const tokenStream = tokenizerOutput.tokens;
            const tokenCount = tokenStream.count;
            for (let i = 0; i < tokenCount; i++) {
                const tok = tokenStream.getItemAt(i);
                // 注释（每个 token 前可能附带注释）
                if (tok.comments) {
                    for (const comment of tok.comments) {
                        this._pushTokenFromRange(
                            tokens, lines, comment.start, comment.length,
                            SemanticTokenTypes.comment
                        );
                    }
                }
            }
        }

        // 2. 遍历 ParseTree，提取 NameNode、String、Number、Decorator 等
        const walker = new SemanticTokenWalker(evaluator, lines);
        walker.walk(parseTree);
        for (const token of walker.tokens) {
            tokens.push(token);
        }

        // 按位置排序（LSP 要求）
        tokens.sort((a, b) => {
            if (a.line !== b.line) return a.line - b.line;
            return a.startChar - b.startChar;
        });

        return tokens;
    }

    /** 辅助：从 offset/length 创建 RawToken 并推入列表 */
    private _pushTokenFromRange(
        tokens: RawToken[],
        lines: TextRangeCollection<TextRange>,
        start: number,
        length: number,
        tokenType: number
    ): void {
        if (length <= 0) {
            return;
        }
        const position = convertOffsetToPosition(start, lines);
        if (!position) {
            return;
        }
        tokens.push({
            line: position.line,
            startChar: position.character,
            length,
            tokenType,
            tokenModifiers: 0,
        });
    }

    /**
     * 将 RawToken 列表编码为 LSP 相对编码格式。
     * 每个 token 占 5 个数字：[deltaLine, deltaStart, length, tokenType, tokenModifiers]
     */
    private _encodeTokens(tokens: RawToken[]): SemanticTokenData {
        const data: SemanticTokenData = [];
        let prevLine = 0;
        let prevStartChar = 0;

        for (const token of tokens) {
            const deltaLine = token.line - prevLine;
            const deltaStart = deltaLine === 0 ? token.startChar - prevStartChar : token.startChar;

            data.push(deltaLine, deltaStart, token.length, token.tokenType, token.tokenModifiers);

            prevLine = token.line;
            prevStartChar = token.startChar;
        }

        return data;
    }

    /** 将 LSP 相对编码解码为 RawToken 列表（用于 range 过滤） */
    private _decodeTokens(data: SemanticTokenData): RawToken[] {
        const tokens: RawToken[] = [];
        let prevLine = 0;
        let prevStartChar = 0;

        for (let i = 0; i < data.length; i += 5) {
            const deltaLine = data[i];
            const deltaStart = data[i + 1];
            const length = data[i + 2];
            const tokenType = data[i + 3];
            const tokenModifiers = data[i + 4];

            const line = prevLine + deltaLine;
            const startChar = deltaLine === 0 ? prevStartChar + deltaStart : deltaStart;

            tokens.push({
                line,
                startChar,
                length,
                tokenType,
                tokenModifiers,
            });

            prevLine = line;
            prevStartChar = startChar;
        }

        return tokens;
    }

    /** 计算字符串 hash（简单 FNV-1a 变体，足够缓存命中判断） */
    private _computeHash(text: string): string {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    }

    /** 根据缓存 key（uri 字符串）计算磁盘缓存文件路径 */
    private _getCacheFilePath(key: string): string {
        const uriHash = this._computeHash(key);
        return path.join(this._cacheDir!, `${uriHash}.json`);
    }

    /**
     * 尝试从磁盘加载缓存。
     * 同步读取（在关键路径上），验证 contentHash 并检查过期时间。
     */
    private _tryLoadFromDisk(key: string, expectedHash: string): CacheEntry | undefined {
        if (!this._cacheDir) {
            return undefined;
        }

        const filePath = this._getCacheFilePath(key);
        try {
            if (!fs.existsSync(filePath)) {
                return undefined;
            }

            const stat = fs.statSync(filePath);
            const age = Date.now() - stat.mtimeMs;
            if (age > DISK_CACHE_MAX_AGE_MS) {
                // 过期：删除并返回未命中
                this._tryDeleteFromDisk(filePath);
                return undefined;
            }

            const content = fs.readFileSync(filePath, 'utf8');
            const entry = JSON.parse(content) as CacheEntry;

            // 验证 contentHash（确保文件内容未变）
            if (entry.contentHash !== expectedHash) {
                return undefined;
            }

            return entry;
        } catch {
            // 读取/解析失败：忽略，视为未命中
            return undefined;
        }
    }

    /**
     * 尝试保存缓存到磁盘。
     * 异步写入（不阻塞响应路径），失败时静默忽略。
     */
    private _trySaveToDisk(key: string, entry: CacheEntry): void {
        if (!this._cacheDir) {
            return;
        }

        const filePath = this._getCacheFilePath(key);
        // 序列化（含 contentHash 用于加载时验证）
        const content = JSON.stringify(entry);

        // 异步写入：fire-and-forget，错误时仅记录日志
        fs.promises
            .writeFile(filePath, content, 'utf8')
            .catch(() => {
                // 写入失败不影响功能，仅忽略
            });
    }

    /** 尝试删除磁盘缓存文件（忽略错误） */
    private _tryDeleteFromDisk(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch {
            // 删除失败不影响功能
        }
    }
}

/**
 * ParseTree 遍历器，访问所有 NameNode 并生成语义 token。
 */
class SemanticTokenWalker extends ParseTreeWalker {
    /** 收集到的 token 列表 */
    readonly tokens: RawToken[] = [];
    private readonly _evaluator: TypeEvaluator;
    /** 文件行集合（用于偏移转换） */
    private readonly _lines: TextRangeCollection<TextRange>;

    constructor(evaluator: TypeEvaluator, lines: TextRangeCollection<TextRange>) {
        super();
        this._evaluator = evaluator;
        this._lines = lines;
    }

    /** 访问 NameNode：核心语义分类逻辑 */
    override visitName(node: NameNode): boolean {
        const token = this._classifyNameNode(node);
        if (token) {
            this.tokens.push(token);
        }
        return true;
    }

    /** 访问 ModuleNameNode：import 语句中的模块名路径部分。
     *  解析成功的模块 → namespace（绿色）；未解析的模块（如不存在的
     *  `from .visitor import ...`）→ undefined（白色，与诊断一致）。
     *  返回 false 阻止遍历 nameParts（避免重复 token，因 visitName 也会处理） */
    override visitModuleName(node: ModuleNameNode): boolean {
        const importInfo = AnalyzerNodeInfo.getImportInfo(node);
        // 模块整体未解析：每个 namePart 都视为未定义（白色）
        const isUnresolved = !!importInfo && !importInfo.isImportFound && !importInfo.isNativeLib;
        for (const part of node.d.nameParts) {
            const position = convertOffsetToPosition(part.start, this._lines);
            if (position && part.length > 0) {
                this.tokens.push({
                    line: position.line,
                    startChar: position.character,
                    length: part.length,
                    tokenType: isUnresolved
                        ? SemanticTokenTypes.undefined
                        : SemanticTokenTypes.namespace,
                    tokenModifiers: 0,
                });
            }
        }
        return false;
    }

    /** 访问 MemberAccessNode：成员访问的 .name → 按 member 声明分类。
     *  返回 false 阻止遍历 member（避免 visitName 重复处理），手动遍历 leftExpr。
     *  使用 _classifyNameNode 复用声明信息查询逻辑，确保类型别名/类/函数等
     *  在成员访问位置（如 t.CInt）也能正确分类。 */
    override visitMemberAccess(node: MemberAccessNode): boolean {
        const member = node.d.member;
        // 复用 _classifyNameNode 逻辑（基于 getDeclInfoForNameNode + getType）
        const token = this._classifyNameNode(member);
        if (token) {
            this.tokens.push(token);
        }
        // 手动遍历左侧表达式（如 obj.prop 中的 obj）
        this.walk(node.d.leftExpr);
        return false;
    }

    /** 访问 StringNode：字符串字面量 → string。
     *  Viper 扩展：在类型注解上下文中的字符串（前向引用）不生成 string token，
     *  让 TextMate 语法规则处理高亮（显示为类型颜色而非字符串颜色）。 */
    override visitString(node: StringNode): boolean {
        if (isWithinTypeAnnotation(node, /* requireQuotedAnnotation */ false)) {
            return true;
        }
        this._pushLiteralToken(node.start, node.length, SemanticTokenTypes.string);
        return true;
    }

    /** 访问 DecoratorNode：@decoratorName → decorator 类型。
     *  返回 false 阻止默认遍历 expr，避免重复 token */
    override visitDecorator(node: DecoratorNode): boolean {
        const expr = node.d.expr;

        if (expr.nodeType === ParseNodeType.Name) {
            // 简单装饰器：@decoratorName
            const position = convertOffsetToPosition(expr.start, this._lines);
            if (position && expr.length > 0) {
                this.tokens.push({
                    line: position.line,
                    startChar: position.character,
                    length: expr.length,
                    tokenType: SemanticTokenTypes.decorator,
                    tokenModifiers: 0,
                });
            }
            return false;
        }

        // 复杂装饰器：@module.decoratorName 或 @decorator(args)
        // 手动遍历 expr，让内部节点按正常逻辑分类
        this.walk(expr);
        return false;
    }

    /** 访问 NumberNode：数字字面量 → number */
    override visitNumber(node: NumberNode): boolean {
        this._pushLiteralToken(node.start, node.length, SemanticTokenTypes.number);
        return true;
    }

    /** 辅助：推入字面量 token（string/number 等） */
    private _pushLiteralToken(start: number, length: number, tokenType: number): void {
        if (length <= 0) {
            return;
        }
        const position = convertOffsetToPosition(start, this._lines);
        if (!position) {
            return;
        }
        this.tokens.push({
            line: position.line,
            startChar: position.character,
            length,
            tokenType,
            tokenModifiers: 0,
        });
    }

    /**
     * 分类 NameNode 的语义类型。
     * 通过 getDeclInfoForNameNode 判断是否已定义，再根据 DeclarationType 和 TypeCategory 细分。
     *
     * 完善功能：
     *  - definition 修饰符：当 NameNode 处于声明位置时添加
     *  - self/cls 参数：特殊处理为 parameter + readonly
     *  - 常量识别：全大写名变量添加 readonly 修饰符
     */
    private _classifyNameNode(node: NameNode): RawToken | undefined {
        const length = node.length;
        if (length <= 0) {
            return undefined;
        }

        // 查询符号声明信息
        const declInfo = this._evaluator.getDeclInfoForNameNode(node);
        const type = this._evaluator.getType(node);

        let tokenType: number;
        let tokenModifiers = 0;
        const nameText = node.d.value;

        // 判断是否处于声明位置（定义点 vs 引用点）
        const isDefinition = this._isDefinitionSite(node);
        const defMod = isDefinition
            ? SemanticTokenModifiers.declaration | SemanticTokenModifiers.definition
            : 0;

        // Viper 扩展：`__before_init__` 由编译器自动生成，所有类隐式存在。
        // 成员访问 `obj.__before_init__()` 时应显示为方法（函数颜色）。
        // 注意：必须在 declInfo 查询之前优先处理，因为 CPtr 解引用转发
        // 可能让 getDeclInfoForNameNode 返回 CPtr.__getattr__ 的 variable
        // 声明（VariableDeclaration），导致误显示为变量颜色。
        if (nameText === '__before_init__' && this._isViperMemberAccess(node)) {
            tokenType = SemanticTokenTypes.function;
            tokenModifiers = 0;
        } else if (!declInfo || !declInfo.decls || declInfo.decls.length === 0) {
            // Viper 扩展：REnum 变体字段（如 x.Pointee，字段定义在嵌套类变体
            // class Ptr 内）常规声明查找找不到，且 getType 对成员裸名称返回 Unknown；
            // 改用成员访问表达式求值获取类型，可求值时显示为 property 而非未定义白色。
            if (this._isViperMemberAccess(node)) {
                const memberAccessType = this._evaluator.getTypeOfExpression(node.parent as MemberAccessNode).type;
                if (
                    memberAccessType !== undefined &&
                    memberAccessType.category !== TypeCategory.Unknown &&
                    memberAccessType.category !== TypeCategory.Unbound
                ) {
                    tokenType = SemanticTokenTypes.property;
                } else {
                    tokenType = SemanticTokenTypes.undefined;
                }
            } else {
                // 未定义符号 → 白色（默认前景）
                tokenType = SemanticTokenTypes.undefined;
            }
        } else {
            const decl: Declaration | undefined = declInfo.decls[0];
            const declType = decl?.type;

            // 根据声明类型分类
            switch (declType) {
                case DeclarationType.Class:
                case DeclarationType.SpecialBuiltInClass:
                    // 内置类型类（int/str/bytes 等）→ class（非 builtin）
                    // None/True/False/t/c 等非类型类 → builtin
                    if (BUILTIN_CLASS_NAMES.has(nameText)) {
                        tokenType = SemanticTokenTypes.class;
                    } else if (BUILTIN_TYPE_NAMES.has(nameText)) {
                        tokenType = SemanticTokenTypes.builtin;
                    } else {
                        tokenType = SemanticTokenTypes.class;
                    }
                    tokenModifiers |= defMod;
                    break;
                case DeclarationType.Function:
                    tokenType = SemanticTokenTypes.function;
                    tokenModifiers |= defMod;
                    break;
                case DeclarationType.Param:
                    tokenType = SemanticTokenTypes.parameter;
                    // self/cls 参数：添加 readonly 修饰符
                    if (nameText === 'self' || nameText === 'cls') {
                        tokenModifiers |= SemanticTokenModifiers.readonly;
                    }
                    break;
                case DeclarationType.Alias:
                    // import 的模块别名。按别名实际指向的类型分类：
                    // `from .base import AST` 中 AST 实际是类 → class；
                    // `import os.path` 中 os 是模块 → namespace。
                    // 避免"无论实际上是什么都显示成绿色（namespace）"。
                    if (type) {
                        if (type.category === TypeCategory.Unknown ||
                            type.category === TypeCategory.Any ||
                            type.category === TypeCategory.Unbound) {
                            // 未解析的导入（如 `from .visitor import ASTVisitor`，
                            // visitor 模块不存在）：标 undefined（白色），与诊断一致。
                            tokenType = SemanticTokenTypes.undefined;
                        } else if (isCDefineType(type)) {
                            // t.CDefine 常量（如 FLAG_IS_ASYNC: t.CDefine = 1）：
                            // 编译时元指令，按常量显示（variable + readonly）。
                            tokenType = SemanticTokenTypes.variable;
                            tokenModifiers |= SemanticTokenModifiers.readonly;
                        } else if (type.category === TypeCategory.Class) {
                            tokenType = BUILTIN_CLASS_NAMES.has(nameText)
                                ? SemanticTokenTypes.class
                                : (BUILTIN_TYPE_NAMES.has(nameText)
                                    ? SemanticTokenTypes.builtin
                                    : SemanticTokenTypes.class);
                        } else if (
                            type.category === TypeCategory.Function ||
                            type.category === TypeCategory.Overloaded
                        ) {
                            tokenType = SemanticTokenTypes.function;
                        } else if (type.category === TypeCategory.Module) {
                            tokenType = SemanticTokenTypes.namespace;
                        } else if (type.category === TypeCategory.TypeVar) {
                            tokenType = SemanticTokenTypes.type;
                        } else {
                            tokenType = SemanticTokenTypes.variable;
                        }
                    } else {
                        tokenType = SemanticTokenTypes.namespace;
                    }
                    tokenModifiers |= defMod;
                    break;
                case DeclarationType.TypeAlias:
                    tokenType = SemanticTokenTypes.type;
                    tokenModifiers |= defMod;
                    break;
                case DeclarationType.TypeParam:
                    tokenType = SemanticTokenTypes.type;
                    tokenModifiers |= defMod;
                    break;
                case DeclarationType.Intrinsic:
                    // 内置符号（None/True/False/__class__ 等）→ builtin + readonly
                    tokenType = SemanticTokenTypes.builtin;
                    tokenModifiers |= SemanticTokenModifiers.readonly;
                    break;
                case DeclarationType.Variable: {
                    // Viper 扩展：当声明被解析为 Variable 但实际类型为 Module 时，
                    // 在类型注解上下文中实际引用的是模块名而非字段。
                    // 覆盖场景：sheet: sheet.Sheet 中第二个 sheet 是模块名，
                    // 但因同名字段遮蔽返回 Variable 声明。getType 返回 Module 类型。
                    if (type && type.category === TypeCategory.Module) {
                        tokenType = SemanticTokenTypes.namespace;
                        tokenModifiers |= defMod;
                        break;
                    }
                    // 检查是否是类型别名声明（`Name: TypeAlias = type` 或 `Name: t.CTypedef = type`）
                    const varDecl = decl as VariableDeclaration;
                    if (varDecl.typeAliasName && varDecl.typeAnnotationNode) {
                        const annNode = varDecl.typeAnnotationNode as any;
                        // 标准 TypeAlias 注解
                        if (annNode.nodeType === ParseNodeType.Name && annNode.d?.value === 'TypeAlias') {
                            tokenType = SemanticTokenTypes.type;
                            tokenModifiers |= defMod;
                            break;
                        }
                        // Viper 扩展：t.CTypedef 注解（MemberAccess，成员名为 CTypedef）
                        if (
                            annNode.nodeType === ParseNodeType.MemberAccess &&
                            annNode.d?.member?.d?.value === 'CTypedef'
                        ) {
                            tokenType = SemanticTokenTypes.type;
                            tokenModifiers |= defMod;
                            break;
                        }
                    }
                    // Viper 扩展：即使没有 typeAliasName，也检查 typeAnnotationNode 是否为 t.CTypedef
                    // （CTypedef 声明可能不设置 typeAliasName，但仍是类型别名）
                    if (varDecl.typeAnnotationNode) {
                        const annNode = varDecl.typeAnnotationNode as any;
                        if (
                            annNode.nodeType === ParseNodeType.MemberAccess &&
                            annNode.d?.member?.d?.value === 'CTypedef'
                        ) {
                            tokenType = SemanticTokenTypes.type;
                            tokenModifiers |= defMod;
                            break;
                        }
                    }
                    // 普通变量 → variable（蓝色）
                    tokenType = SemanticTokenTypes.variable;
                    tokenModifiers |= defMod;
                    // 常量识别：全大写名（含下划线/数字）添加 readonly 修饰符
                    if (/^[A-Z][A-Z0-9_]*$/.test(nameText) && nameText.length > 1) {
                        tokenModifiers |= SemanticTokenModifiers.readonly;
                    }
                    break;
                }
                default:
                    // 根据推导类型进一步分类
                    if (type) {
                        if (type.category === TypeCategory.Class) {
                            tokenType = BUILTIN_CLASS_NAMES.has(nameText)
                                ? SemanticTokenTypes.class
                                : (BUILTIN_TYPE_NAMES.has(nameText)
                                    ? SemanticTokenTypes.builtin
                                    : SemanticTokenTypes.class);
                        } else if (type.category === TypeCategory.Function ||
                                   type.category === TypeCategory.Overloaded) {
                            tokenType = SemanticTokenTypes.function;
                        } else if (type.category === TypeCategory.Module) {
                            tokenType = SemanticTokenTypes.namespace;
                        } else if (type.category === TypeCategory.TypeVar) {
                            tokenType = SemanticTokenTypes.type;
                        } else {
                            tokenType = SemanticTokenTypes.variable;
                        }
                    } else {
                        tokenType = SemanticTokenTypes.variable;
                    }
                    tokenModifiers |= defMod;
                    break;
            }
        }

        // 转换偏移为 line/char
        const position = convertOffsetToPosition(node.start, this._lines);
        if (!position) {
            return undefined;
        }

        return {
            line: position.line,
            startChar: position.character,
            length,
            tokenType,
            tokenModifiers,
        };
    }

    /**
     * 判断 NameNode 是否处于声明位置（定义点而非引用点）。
     * 通过检查父节点类型和字段位置确定。
     *
     * 判定规则：
     *  - FunctionNode.d.name：函数定义名
     *  - ClassNode.d.name：类定义名
     *  - AssignmentNode.d.leftExpr（当 leftExpr 是 NameNode）：赋值左侧
     *  - TypeAnnotationNode.d.valueExpr（当 valueExpr 是 NameNode）：类型注解左侧
     */
    private _isDefinitionSite(node: NameNode): boolean {
        const parent = node.parent;
        if (!parent) {
            return false;
        }

        // 函数定义名：def foo() 中的 foo
        if (parent.nodeType === ParseNodeType.Function) {
            return (parent as FunctionNode).d.name === node;
        }

        // 类定义名：class Foo 中的 Foo
        if (parent.nodeType === ParseNodeType.Class) {
            return (parent as ClassNode).d.name === node;
        }

        // 赋值左侧：foo = 1 中的 foo
        if (parent.nodeType === ParseNodeType.Assignment) {
            return (parent as AssignmentNode).d.leftExpr === node;
        }

        // 类型注解左侧：foo: int 中的 foo
        if (parent.nodeType === ParseNodeType.TypeAnnotation) {
            return (parent as TypeAnnotationNode).d.valueExpr === node;
        }

        return false;
    }

    /**
     * 判断 NameNode 是否是 Viper 成员访问（obj.__before_init__）中的成员名。
     * `__before_init__` 是 Viper 编译器自动生成的方法，成员访问时无真实
     * symbol/declaration，但应显示为函数颜色而非未定义白色。
     */
    private _isViperMemberAccess(node: NameNode): boolean {
        const parent = node.parent;
        return (
            parent !== undefined &&
            parent.nodeType === ParseNodeType.MemberAccess &&
            (parent as MemberAccessNode).d.member === node
        );
    }
}
