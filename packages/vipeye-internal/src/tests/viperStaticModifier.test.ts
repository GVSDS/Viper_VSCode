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
 *   ⑤ 注解内前缀 `x: static T = v` **不支持**（TPC 只认语句起始形态）：报专用语法错误，
 *      且不再连带报「"static" 未定义」（见 parser._checkViperStaticInAnnotationPosition）。
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

// 语句起始形态是唯一合法写法（与 TPC `_IsStaticModifier` 同口径）：
// ViperOS 的真实写法是 `static memory_regions: memory_region* = None`，
// 注解内前缀 `memory_regions: static memory_region* = None` 不再接受。
test('语句起始 static（static x: T = v）合法，展示为 static 前缀且跨模块拦截', () => {
    const code = `import t

class memory_region:
    base: uint64
    size: uint64

static memory_regions: memory_region* = None

def touch() -> uint64:
    return memory_regions[0].base
`;
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({ 'lib.vp': code });

    try {
        const libDiags = getDiagnostics(program, configOptions, uris['lib.vp']);
        console.log('=== static 语句起始形态诊断 ===');
        libDiags.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        assert.strictEqual(
            libDiags.filter((d) => d.category === 0 || d.category === 1).length,
            0,
            `static memory_regions: memory_region* = None 不应报错：${JSON.stringify(libDiags)}`
        );

        const types = collectAnnotatedVarTypes(program, uris['lib.vp']);
        console.log('=== 注解变量类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));
        assert(
            types.get('memory_regions')!.includes('static') &&
                types.get('memory_regions')!.includes('memory_region'),
            `memory_regions 应展示为 static rawptr[memory_region]，实际: ${types.get('memory_regions')}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('注解内 static 前缀（x: static T = v）报专用错误，不连带报 static 未定义', () => {
    const code = `import t

class memory_region:
    base: uint64
    size: uint64

memory_regions: static memory_region* = None

def touch() -> uint64:
    return memory_regions[0].base
`;
    const { program, configOptions, uris, testRoot, serviceProvider } = buildProgram({ 'lib.vp': code });

    try {
        const diagnostics = getDiagnostics(program, configOptions, uris['lib.vp']);
        console.log('=== 注解内 static 诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const dedicated = diagnostics.filter((d) => d.message.includes('static 修饰符不支持写在类型注解里'));
        assert.strictEqual(
            dedicated.length,
            1,
            `应报 1 条「注解内 static 不支持」：${JSON.stringify(diagnostics)}`
        );
        assert.strictEqual(dedicated[0].category, 0, `应为 error：${JSON.stringify(dedicated[0])}`);
        assert.strictEqual(dedicated[0].line, 7, `报错应落在第 7 行：${JSON.stringify(dedicated[0])}`);

        // 不再连带报「"static" is not defined」（旧行为），也不应报其它 error。
        const otherErrors = diagnostics.filter(
            (d) => d.category === 0 && !d.message.includes('static 修饰符不支持写在类型注解里')
        );
        assert.strictEqual(
            otherErrors.length,
            0,
            `除专用错误外不应有其它 error：${JSON.stringify(otherErrors)}`
        );

        // 剩余类型仍解析出元素类型（错误恢复：跳过 static 继续解析 memory_region*）。
        const types = collectAnnotatedVarTypes(program, uris['lib.vp']);
        console.log('=== 注解变量类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));
        assert(
            types.get('memory_regions')!.includes('memory_region'),
            `错误恢复后仍应解析出 memory_region*，实际: ${types.get('memory_regions')}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});
