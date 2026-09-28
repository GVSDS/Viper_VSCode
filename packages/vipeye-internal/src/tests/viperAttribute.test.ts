/*
 * viperAttribute.test.ts
 *
 * 验证 Viper 的 `__attribute__` 与值位置 `volatile` 前缀（仅 LSP 侧实现，
 * TPC/TPV 不处理）：
 *   ① `@__attribute__(section(".x"), always_inline)` 装饰器
 *      → 脱糖为 `@c.Attribute(t.attr.section(".x"), t.attr.always_inline)`（class/def 通用）
 *   ② `a: __attribute__(section(".x")) const int = 1` 注解修饰器
 *      → 脱糖为 `(t.attr.section(".x") | (CConst | int))`，与 const/volatile 同族
 *   ③ 注解联合里的属性标记 `T | t.attr.<name>` / `T | t.attr.llvm.<name>`
 *      求值为 t.CAttr（修饰符），不参与类型检查、展示不泄漏
 *   ④ 值位置 `volatile f()` / `volatile 结构体()`（标记调用为 volatile）
 *   ⑤ `__attribute__(` 括号内的属性名补全
 *   ⑥ 属性名是编译器级开放集合：未声明在 `t.attr` 的名字（如 `stackrealign`）
 *      也按 function 高亮，且不报「无法访问属性」
 * 负例：`volatile = 2` / `const = 1` / `volatile 1`（非调用）仍须报错。
 *
 * 运行：npx jest src/tests/viperAttribute.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { CancellationToken, MarkupKind, Position } from 'vscode-languageserver';

import { ImportResolver } from '../analyzer/importResolver';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { CompletionProvider } from '../languageService/completionProvider';
import { HoverProvider } from '../languageService/hoverProvider';
import { SemanticTokenTypes } from '../languageService/semanticTokenTypes';
import { ParseNodeType, TypeAnnotationNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgramForCode(code: string, dirName: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const projectRoot = UriEx.file(TRANSPYC_INCLUDES);
    const configOptions = new ConfigOptions(projectRoot);
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');

    const execEnv = new ExecutionEnvironment(
        'python',
        projectRoot,
        configOptions.diagnosticRuleSet,
        configOptions.defaultPythonVersion,
        configOptions.defaultPythonPlatform,
        [projectRoot],
        /* skipNativeLibraries */ false,
        /* defaultDialect */ 'viper'
    );
    configOptions.executionEnvironments = [execEnv];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    const fs = require('fs');
    const testDir = path.join(__dirname, dirName);
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'attribute.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const parseResults = program.getParseResults(uri);
    assert(parseResults, 'parse results not found');

    return { program, configOptions, uri, serviceProvider, testDir, parseResults };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): { category: number; line: number; message: string }[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag: any) => ({
        category: diag.category,
        line: diag.range ? diag.range.start.line + 1 : -1,
        message: diag.message,
    }));
}

/** 语义 token：解码相对编码，返回 Map<line(0-based), {text, tokenType}[]>。 */
function getSemanticTokens(program: Program, uri: any): Map<number, { text: string; tokenType: number }[]> {
    const { SemanticTokenProvider } = require('../languageService/semanticTokenProvider');
    const { LogTracker } = require('../common/logTracker');
    const provider = new SemanticTokenProvider(new LogTracker());
    const result = provider.provideFull(program, uri);
    assert(result, 'no semantic tokens produced');

    const lines = program.getSourceFile(uri)!.getParseResults()!.text.split('\n');
    const map = new Map<number, { text: string; tokenType: number }[]>();
    let cursorLine = 0;
    let cursorChar = 0;
    for (let i = 0; i < result.data.length; i += 5) {
        const deltaLine = result.data[i];
        cursorLine += deltaLine;
        cursorChar = deltaLine === 0 ? cursorChar + result.data[i + 1] : result.data[i + 1];
        const length = result.data[i + 2];
        const entry = {
            text: (lines[cursorLine] || '').substring(cursorChar, cursorChar + length),
            tokenType: result.data[i + 3],
        };
        if (!map.has(cursorLine)) {
            map.set(cursorLine, []);
        }
        map.get(cursorLine)!.push(entry);
    }
    return map;
}

/** 收集注解变量的展示类型（按变量名索引）。 */
function collectAnnotatedVarTypes(program: Program, parseResults: any): Map<string, string> {
    const evaluator = program.evaluator;
    assert(evaluator, 'evaluator not available');
    const result = new Map<string, string>();

    class Collector extends ParseTreeWalker {
        override visitTypeAnnotation(node: TypeAnnotationNode) {
            const valueExpr: any = node.d.valueExpr;
            if (valueExpr.nodeType === ParseNodeType.Name) {
                const type = evaluator!.getType(valueExpr);
                // 取第一个（顶层声明），避免函数内局部同名覆盖
                if (!result.has(valueExpr.d.value)) {
                    result.set(valueExpr.d.value, type ? program.printType(type) : '(undefined)');
                }
            }
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    return result;
}

test('__attribute__ 装饰器 / 修饰器 / 注解联合标记（LSP 侧）', () => {
    const code = `import t, c

@__attribute__(section(".text.wo"), always_inline)
def decorated(a: int) -> int:
    return a

@__attribute__(packed, aligned(16))
class Packed:
    x: t.CInt

AttrConst: __attribute__(section(".PRVERSN")) const int = 1

P: t.CInt | t.attr.llvm.nounwind | t.attr.llvm.nobuiltin = 0

def use_p(p: P) -> int:
    return p + 1

V: str | t.attr.weak = "x"

def use_v(v: V) -> int:
    return v[0]
`;
    const { program, configOptions, uri, serviceProvider, testDir, parseResults } = buildProgramForCode(
        code,
        '__viper_attribute__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== __attribute__ 诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        // ① `__attribute__` / `section` / `always_inline` 等不应报「未定义」
        const undefinedDiags = diagnostics.filter((d) => d.message.includes('未定义') || d.message.includes('undefined'));
        assert.strictEqual(
            undefinedDiags.length,
            0,
            `__attribute__ 及其属性名不应报未定义：${JSON.stringify(undefinedDiags)}`
        );

        // ② 属性标记不得触发运算/下标/类型注解调用等诊断
        const forbidden = diagnostics.filter(
            (d) =>
                d.message.includes('运算符') ||
                d.message.includes('下标') ||
                d.message.includes('调用表达式')
        );
        assert.strictEqual(forbidden.length, 0, `属性标记应被当作修饰符跳过：${JSON.stringify(forbidden)}`);

        // ③ 展示不泄漏 CAttr / nounwind / nobuiltin / weak
        const types = collectAnnotatedVarTypes(program, parseResults);
        console.log('=== 注解变量类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));

        assert(
            types.get('P')!.includes('CInt') && !types.get('P')!.includes('CAttr'),
            `P 应展示为基础类型（属性标记被丢弃），实际: ${types.get('P')}`
        );
        assert(
            !types.get('P')!.includes('nounwind') && !types.get('P')!.includes('nobuiltin'),
            `P 不应泄漏 llvm 属性标记，实际: ${types.get('P')}`
        );
        assert(
            types.get('AttrConst')!.includes('const') && !types.get('AttrConst')!.includes('CAttr'),
            `AttrConst 应展示为 const int，实际: ${types.get('AttrConst')}`
        );
        assert(
            !types.get('V')!.includes('CAttr') && !types.get('V')!.includes('weak'),
            `V 不应泄漏属性标记，实际: ${types.get('V')}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('值位置 volatile 前缀：volatile f() / volatile 结构体()', () => {
    const code = `import t

class Settings:
    x: int

def f() -> int:
    return 1

def use() -> int:
    a: int = volatile f()
    b: Settings = volatile Settings()
    return a
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(code, '__viper_volatile__');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== volatile 值前缀诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        // 只关心 error/warning；category=3 是「未存取」类 hint（未使用的 import/变量）
        const realDiagnostics = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(
            realDiagnostics.length,
            0,
            `volatile 值前缀不应产生错误/警告：${JSON.stringify(realDiagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('volatile / const 裸用与非调用前缀仍报错', () => {
    const code = `const = 1
volatile = 2

def use() -> int:
    x = volatile 1
    return 0
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(code, '__viper_volatile_bad__');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== volatile/const 裸用诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const syntaxErrors = diagnostics.filter((d) => d.category === 0);
        assert(
            syntaxErrors.length >= 2,
            `const/volatile 裸用与非调用前缀应报语法错误：${JSON.stringify(diagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('__attribute__(...) 括号内提示属性名', async () => {
    // 光标落在 `__attribute__(` 之后（第 2 行第 20 列，即 '(' 与 ')' 之间）。
    const code = `import t

Attr: __attribute__() int = 1
`;
    const { program, uri, serviceProvider, testDir } = buildProgramForCode(
        code,
        '__viper_attribute_completion__'
    );

    try {
        const provider = new CompletionProvider(
            program as any,
            uri,
            Position.create(2, 20),
            { format: MarkupKind.PlainText, snippet: false, lazyEdit: false },
            CancellationToken.None
        );
        const completions = await provider.getCompletions();
        assert(completions, '补全结果为空');

        const labels: string[] = completions.items.map((item) => item.label);
        console.log(`=== __attribute__ 补全项 ${labels.length} 项：${labels.slice(0, 20).join(', ')} ===`);

        for (const name of ['section', 'always_inline', 'aligned', 'packed', 'weak', 'noinline']) {
            assert(labels.indexOf(name) >= 0, `__attribute__ 补全缺少属性 ${name}：${JSON.stringify(labels)}`);
        }
        // llvm 描述符类不是 __attribute__ 的属性名（属注解联合用法），不应出现在此处
        assert(labels.indexOf('nounwind') < 0, `llvm 描述符类不应出现在 __attribute__ 补全里：${JSON.stringify(labels)}`);
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('键入 __a 时补全里能看到 __attribute__', async () => {
    // 装饰器位置（第 2 行第 4 列，`@__a` 之后）与注解位置（第 4 行第 10 列，`x: __a` 之后）。
    const code = `import t

@__a
def f() -> int:
    x: __a = 1
    return 0
`;
    const { program, uri, serviceProvider, testDir } = buildProgramForCode(code, '__viper_attribute_prefix__');

    try {
        for (const position of [Position.create(2, 4), Position.create(4, 10)]) {
            const provider = new CompletionProvider(
                program as any,
                uri,
                position,
                { format: MarkupKind.PlainText, snippet: false, lazyEdit: false },
                CancellationToken.None
            );
            const completions = await provider.getCompletions();
            assert(completions, '补全结果为空');

            const labels: string[] = completions.items.map((item) => item.label);
            assert(
                labels.indexOf('__attribute__') >= 0,
                `行 ${position.line} 键入 __a 应提示 __attribute__：${JSON.stringify(labels)}`
            );
        }
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('__attribute__ 不要求 import t / import c（隐式模块根）', () => {
    const code = `@__attribute__(section(".text.wo"), always_inline)
def decorated(a: int) -> int:
    return a

@__attribute__(packed, aligned(16))
class Packed:
    x: int

AttrConst: __attribute__(section(".PRVERSN")) const int = 1
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(code, '__viper_attribute_noimport__');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== __attribute__ 免 import 诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const realDiagnostics = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(
            realDiagnostics.length,
            0,
            `__attribute__ 脱糖出的 t / c 不应报未定义：${JSON.stringify(realDiagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('隐式模块根只作用于 __attribute__ 脱糖：手写裸 t / c 仍报未定义', () => {
    const code = `Bad: t.CInt = 1

def use_c() -> int:
    return c.SomeThing
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(
        code,
        '__viper_attribute_implicit_scope__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 手写裸 t / c 诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const undefinedT = diagnostics.filter((d) => d.message.includes('未定义') && d.message.includes('t'));
        const undefinedC = diagnostics.filter((d) => d.message.includes('未定义') && d.message.includes('c'));
        assert(undefinedT.length > 0, `手写裸 t 应仍报未定义：${JSON.stringify(diagnostics)}`);
        assert(undefinedC.length > 0, `手写裸 c 应仍报未定义：${JSON.stringify(diagnostics)}`);
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('hover 在 __attribute__(...) 括号内提示全部属性名', () => {
    // 第 2 行第 22 列落在实参 `section` 上。
    const code = `import t

Attr: __attribute__(section(".x")) const int = 1
`;
    const { program, uri, serviceProvider, testDir } = buildProgramForCode(code, '__viper_attribute_hover__');

    try {
        const provider = new HoverProvider(program as any, uri, Position.create(2, 22), MarkupKind.Markdown, CancellationToken.None);
        const hover = provider.getHover();
        assert(hover, 'hover 结果为空');

        const text = typeof hover.contents === 'string' ? hover.contents : (hover.contents as any).value;
        console.log(`=== hover 内容（前 200 字）===\n${text.slice(0, 200)}`);

        for (const name of ['section', 'always_inline', 'aligned', 'packed', 'weak']) {
            assert(text.includes(name), `hover 应列出属性 ${name}：${text.slice(0, 300)}`);
        }
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

/*
 * ⑥ 属性名是编译器级的**开放集合**，不一定声明在 `t.attr` 里：
 *    `stackrealign` 只在 TransPyV 的 codegen 映射里有（FuncGenBase.vp:181），
 *    真实 t.py 与 LSP 存根 t.vpi 的 `class attr` 都没有它，ViperOS
 *    `VKernel/Kernel/main.vp:347` 在用。修前 `t.attr.stackrealign` 解析不到 →
 *    语义 token undefined（白色、不高亮）+ 误报「无法访问类"type[attr]"的属性」。
 *    修后：解析不到也不报错，语义高亮直接按已声明属性同款（function）着色。
 */
test('未在 t.attr 声明的属性名（stackrealign）也高亮且不报「无法访问属性」', () => {
    const code = `import t

@__attribute__(section(".text.startup"), aligned(16), stackrealign)
def _start() -> None:
    pass

@__attribute__(naked)
def _naked() -> None:
    pass
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(code, '__viper_attribute_unknown__');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 未声明属性名诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        // ① 不再误报「无法访问类 attr 的属性 stackrealign」（编译器对未知属性是静默丢弃）。
        const attrDiags = diagnostics.filter(
            (d) => d.message.includes('无法访问') || d.message.includes('stackrealign')
        );
        assert.strictEqual(
            attrDiags.length,
            0,
            `未声明属性名不应报「无法访问属性」：${JSON.stringify(attrDiags)}`
        );

        // ② 语义高亮：section / aligned / stackrealign 都应为 function（与已声明属性同款）。
        const tokensByLine = getSemanticTokens(program, uri);
        const decoratorLine = tokensByLine.get(2) || [];
        console.log('=== 装饰器行语义 token ===');
        decoratorLine.forEach((t) => console.log(`  [${t.tokenType}] ${t.text}`));
        for (const name of ['section', 'aligned', 'stackrealign']) {
            const tok = decoratorLine.find((t) => t.text === name);
            assert(tok, `该行应有 ${name} 的语义 token：${JSON.stringify(decoratorLine)}`);
            assert.strictEqual(
                tok!.tokenType,
                SemanticTokenTypes.function,
                `${name} 应为 function 语义 token（未声明属性名原先落到 undefined），实际 ${tok!.tokenType}`
            );
        }
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
