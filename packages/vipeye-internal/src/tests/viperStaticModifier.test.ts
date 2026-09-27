/*
 * viperStaticModifier.test.ts
 *
 * 验证 Viper 的 `static` 修饰符（仅 LSP 侧实现，TPC/TPV 不动）：
 *   ① `static def f(...)`   —— 与 virtual 同法，记到 FunctionNode.d.viperModifier；
 *   ② `static x: T = v`     —— 注解脱糖为 `t.CStatic | T`（与 TPC _parse_type_ann
 *                              把 t.CStatic 插到联合最左同形），并在声明节点打 isViperStatic；
 *   ③ 语义 = C 的 internal linkage：禁止跨模块取参。
 *      跨模块 `mod.name` / `mod.fn()` 由 typeEvaluator 的模块成员访问分支报错，
 *      `from mod import name` 由 checker 的 visitImportFromAs 报错；同模块自引用放行。
 *   ④ `static` 是软关键字：`static = 1` / `static: int` / `static(x)` 仍按普通标识符处理。
 *
 * 运行：npx jest src/tests/viperStaticModifier.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { ParseNodeType, TypeAnnotationNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

function buildProgram(files: Record<string, string>) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__viper_static__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    for (const [relPath, content] of Object.entries(files)) {
        const absPath = path.join(testRoot, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf8');
    }

    const projectRoot = UriEx.file(testRoot);
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

    const uris: Record<string, any> = {};
    for (const relPath of Object.keys(files)) {
        uris[relPath] = UriEx.file(path.join(testRoot, relPath));
    }
    program.setTrackedFiles(Object.values(uris));
    while (program.analyze()) {
        // 循环
    }

    return { program, configOptions, uris, parseResults: undefined as any, testRoot, serviceProvider };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any) {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag: any) => ({
        category: diag.category,
        line: diag.range ? diag.range.start.line + 1 : -1,
        message: diag.message as string,
    }));
}

/** 收集注解变量的展示类型（按变量名索引）。 */
function collectAnnotatedVarTypes(program: Program, uri: any): Map<string, string> {
    const parseResults = program.getParseResults(uri);
    assert(parseResults, 'parse results not found');
    const evaluator = program.evaluator;
    assert(evaluator, 'evaluator not available');
    const result = new Map<string, string>();

    class Collector extends ParseTreeWalker {
        override visitTypeAnnotation(node: TypeAnnotationNode) {
            const valueExpr: any = node.d.valueExpr;
            if (valueExpr.nodeType === ParseNodeType.Name) {
                const type = evaluator!.getType(valueExpr);
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

test('static def / static x: T 解析与脱糖；同模块自引用不报错', () => {
    const code = `static def helper() -> int:
    return 1

static SECRET: int = 42

def use() -> int:
    return helper() + SECRET
`;
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({ 'lib.vp': code });

    try {
        const diagnostics = getDiagnostics(program, configOptions, uris['lib.vp']);
        console.log('=== static 声明诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        assert.strictEqual(
            diagnostics.filter((d) => d.category === 0).length,
            0,
            `static 修饰符不应报语法错误：${JSON.stringify(diagnostics)}`
        );
        assert.strictEqual(
            diagnostics.filter((d) => d.message.includes('static 符号')).length,
            0,
            `同模块自引用 static 符号不应报错：${JSON.stringify(diagnostics)}`
        );

        // 变量注解脱糖为 `t.CStatic | int`，展示为 `static int`（修饰符前缀）。
        const types = collectAnnotatedVarTypes(program, uris['lib.vp']);
        console.log('=== 注解变量类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));
        assert(
            types.get('SECRET')!.includes('static') && types.get('SECRET')!.includes('int'),
            `static SECRET 应展示为 static int，实际: ${types.get('SECRET')}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('跨模块 mod.name / mod.fn() 取用 static 符号报错', () => {
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({
        'lib.vp': `static def helper() -> int:
    return 1

static SECRET: int = 42

def public_fn() -> int:
    return helper()
`,
        'main.vp': `import lib

def use() -> int:
    return lib.helper() + lib.SECRET
`,
    });

    try {
        const libDiags = getDiagnostics(program, configOptions, uris['lib.vp']);
        assert.strictEqual(
            libDiags.filter((d) => d.message.includes('static 符号')).length,
            0,
            `定义模块内部使用不应报错：${JSON.stringify(libDiags)}`
        );

        const mainDiags = getDiagnostics(program, configOptions, uris['main.vp']);
        console.log('=== 跨模块取参诊断 ===');
        mainDiags.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const staticDiags = mainDiags.filter((d) => d.message.includes('static 符号'));
        assert.strictEqual(
            staticDiags.length,
            2,
            `lib.helper / lib.SECRET 取用应各报一条 static 跨模块错误：${JSON.stringify(mainDiags)}`
        );
        assert(
            staticDiags.some((d) => d.message.includes('lib.helper')) &&
                staticDiags.some((d) => d.message.includes('lib.SECRET')),
            `诊断文案应含 lib.helper / lib.SECRET：${JSON.stringify(staticDiags)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('from mod import static 符号报错', () => {
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({
        'lib.vp': `static def helper() -> int:
    return 1

def public_fn() -> int:
    return 0
`,
        'main.vp': `from lib import helper, public_fn

def use() -> int:
    return helper() + public_fn()
`,
    });

    try {
        const mainDiags = getDiagnostics(program, configOptions, uris['main.vp']);
        console.log('=== from import static 诊断 ===');
        mainDiags.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const staticDiags = mainDiags.filter((d) => d.message.includes('static 符号'));
        assert.strictEqual(
            staticDiags.length,
            1,
            `from lib import helper 应报一条 static 跨模块错误（public_fn 不报）：${JSON.stringify(mainDiags)}`
        );
        assert(
            staticDiags[0].message.includes('lib.helper'),
            `诊断文案应含 lib.helper：${JSON.stringify(staticDiags)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('static 是软关键字：非修饰位置仍按普通标识符处理', () => {
    const code = `static: int = 0
static = 1

def f(static: int) -> int:
    return static
`;
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({ 'main.vp': code });

    try {
        const diagnostics = getDiagnostics(program, configOptions, uris['main.vp']);
        console.log('=== 软关键字诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        assert.strictEqual(
            diagnostics.filter((d) => d.category === 0).length,
            0,
            `static 作为普通标识符不应报语法错误：${JSON.stringify(diagnostics)}`
        );
        assert.strictEqual(
            diagnostics.filter((d) => d.message.includes('static 符号')).length,
            0,
            `同模块内不应报 static 跨模块错误：${JSON.stringify(diagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

// ViperOS 全仓实际写法是**注解内前缀**（`buf_head: static uint32 = 0`，
// 见 VKernel/Kernel/drivers/**），此前 LSP 只认语句起始形态 `static x: T`，
// 导致 `static` 在注解里被当普通名引用 → 误报「"static" is not defined」。
test('注解内 static 前缀（x: static T = v）解析、展示与跨模块拦截', () => {
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({
        'lib.vp': `buf_head: static int = 0

def touch() -> int:
    return buf_head
`,
        'main.vp': `import lib

def use() -> int:
    return lib.buf_head
`,
    });

    try {
        const libDiags = getDiagnostics(program, configOptions, uris['lib.vp']);
        console.log('=== 注解内 static 诊断 ===');
        libDiags.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        assert.strictEqual(
            libDiags.filter((d) => d.category === 0).length,
            0,
            `注解内 static 不应报语法/未定义错误：${JSON.stringify(libDiags)}`
        );
        assert.strictEqual(
            libDiags.filter((d) => d.message.includes('static 符号')).length,
            0,
            `同模块自引用不应报 static 跨模块错误：${JSON.stringify(libDiags)}`
        );

        // 注解脱糖为 `t.CStatic | int`，与语句起始形态一样展示为 `static int`。
        const types = collectAnnotatedVarTypes(program, uris['lib.vp']);
        console.log('=== 注解变量类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));
        assert(
            types.get('buf_head')!.includes('static') && types.get('buf_head')!.includes('int'),
            `buf_head 应展示为 static int，实际: ${types.get('buf_head')}`
        );

        // 跨模块取参仍须报错（与语句起始形态同判据）。
        const mainDiags = getDiagnostics(program, configOptions, uris['main.vp']);
        console.log('=== 跨模块取参诊断 ===');
        mainDiags.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));
        const staticDiags = mainDiags.filter((d) => d.message.includes('static 符号'));
        assert.strictEqual(
            staticDiags.length,
            1,
            `lib.buf_head 取用应报一条 static 跨模块错误：${JSON.stringify(mainDiags)}`
        );
        assert(
            staticDiags[0].message.includes('lib.buf_head'),
            `诊断文案应含 lib.buf_head：${JSON.stringify(staticDiags)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('注解内 static 仍受软关键字边界约束：static 单独作为注解名不变', () => {
    const code = `static: int = 0
static = 1
`;
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({ 'main.vp': code });

    try {
        const diagnostics = getDiagnostics(program, configOptions, uris['main.vp']);
        console.log('=== 注解内 static 边界诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        assert.strictEqual(
            diagnostics.filter((d) => d.category === 0).length,
            0,
            `static 作为普通标识符/变量名不应报语法错误：${JSON.stringify(diagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});
