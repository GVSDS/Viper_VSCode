/*
 * viperBuiltinsVpTypedef.test.ts
 *
 * 验证 Viper 方言下注解名解析对内置 typedef 的兜底搜索：
 *   - `rawptr[int]` 注解 → rawptr 为 builtins.vpi 中的编译器内置 typedef，可解析为 CPtr[int]
 *   - `size_t` 注解 → 解析为 t.CSizeT（来自 includes/builtins.vp 的 t.CTypedef 别名）
 *   - `int8` 注解 → 解析为 t.CInt8T（来自 includes/builtins.vp 的 t.CTypedef 别名）
 *   - 均无需显式 import builtins（builtins 不在用户文件 import 闭包内）
 *   - 不报"未定义 rawptr/size_t/int8"
 *
 * 运行：npx jest src/tests/viperBuiltinsVpTypedef.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { FunctionNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__builtins_vp_typedef__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const filePath = path.join(testRoot, 'main.vp');
    fs.writeFileSync(filePath, source, 'utf8');

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
        [UriEx.file(TRANSPYC_INCLUDES)],
        /* skipNativeLibraries */ false,
        /* defaultDialect */ 'viper'
    );
    configOptions.executionEnvironments = [execEnv];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    const uri = UriEx.file(filePath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const sourceFile = program.getSourceFile(uri);
    const parseResults = sourceFile!.getParseResults();
    return { program, configOptions, parseResults, uri, serviceProvider };
}

// 收集函数参数注解类型（打印名，expandTypeAlias 展开别名）
function collectParamAnnotationTypes(
    program: Program,
    parseResults: any
): Map<string, string[]> {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    const ev = evaluator;
    const result = new Map<string, string[]>();

    class ParamCollector extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            const funcName = node.d.name.d.value;
            for (const param of node.d.params) {
                const ann = (param as any).d?.annotation;
                if (ann) {
                    const t = ev.getType(ann as any);
                    const list = result.get(funcName) ?? [];
                    list.push(t ? program.printType(t, { expandTypeAlias: true }) : '(undefined)');
                    result.set(funcName, list);
                }
            }
            return true;
        }
    }
    new ParamCollector().walk(parseResults.parserOutput.parseTree);

    return result;
}

test('builtins.vp（includes 版本）typedef 在注解中可直接解析', () => {
    const source = `import t

def f(x: rawptr[int]) -> int:
    return 0

def g() -> size_t:
    return 0

def h(a: int8) -> int:
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    // 1. 无未定义诊断
    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    const undefinedDiags = diagnostics.filter((d) => d.includes('未定义') || d.includes('undefined'));
    assert.strictEqual(
        undefinedDiags.length,
        0,
        `builtins.vp typedef 不应报未定义，实际: ${JSON.stringify(undefinedDiags)}`
    );

    // 2. 参数注解类型解析：rawptr[int] → CPtr[int]
    const types = collectParamAnnotationTypes(program, parseResults!);
    const fTypes = types.get('f');
    assert(fTypes && fTypes.some((t) => t.includes('rawptr') && t.includes('int')), `f(x) 应为 rawptr[int]，实际: ${JSON.stringify(fTypes)}`);

    // 3. 返回注解 size_t → CSizeT
    const gReturn = (() => {
        const evaluator = program.evaluator as TypeEvaluator | undefined;
        assert(evaluator);
        const ev = evaluator;
        let retType: string | undefined;
        class RetCollector extends ParseTreeWalker {
            override visitFunction(node: FunctionNode) {
                if (node.d.name.d.value === 'g' && node.d.returnAnnotation) {
                    const t = ev.getType(node.d.returnAnnotation as any);
                    retType = t ? program.printType(t, { expandTypeAlias: true }) : '(undefined)';
                }
                return true;
            }
        }
        new RetCollector().walk(parseResults!.parserOutput.parseTree);
        return retType;
    })();
    assert(
        gReturn && (gReturn === 'CSizeT' || gReturn.includes('CSizeT')),
        `g() 返回注解 size_t 应为 CSizeT，实际: ${gReturn}`
    );

    // 4. 参数注解 int8 → CInt8T
    const hTypes = types.get('h');
    assert(hTypes && hTypes.some((t) => t.includes('CInt8T')), `h(a) 应为 CInt8T，实际: ${JSON.stringify(hTypes)}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__builtins_vp_typedef__'), { recursive: true, force: true });
});

test('builtins.vp typedef 与 builtins.vpi 内建并存（int/str 等不被破坏）', () => {
    const source = `import t

def f(x: rawptr[int]) -> str:
    s: str = "ok"
    return s
`;
    const { program, configOptions, uri, serviceProvider } = buildProgram(source);

    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(
        errors.length,
        0,
        `builtins.vpi 内建（str 等）应与 builtins.vp typedef 并存，实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__builtins_vp_typedef__'), { recursive: true, force: true });
});

// 回归：builtins.vp 的 typedef 合并不能以"第一个绑定文件的环境"为准。
// 若 Program 里先绑定了别处一个找不到 includes/builtins.vp 的文件（工程外的
// 散落文件、多根工作区的另一个根、`.tpv_build` 下的生成物等），后续正规工程
// 里的文件仍须能解析 uint32/int8/sizet 等 typedef，不得报"未定义"。
// （同一工程在 VSCode 与 Trae 因打开的文件集合/顺序不同而结果不同，即此因。）
test('其它环境的文件先被绑定时，本工程 builtins.vp typedef 仍可解析（不报未定义）', () => {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(
        createFromRealFileSystem(tempFile),
        new NullConsole(),
        tempFile
    );
    const fs = require('fs');
    const base = path.join(__dirname, '__builtins_vp_env_order__');
    fs.rmSync(base, { recursive: true, force: true });

    // 环境 1：普通目录（无 includes/builtins.vp，无 extraPaths）
    const plainRoot = path.join(base, 'Plain');
    fs.mkdirSync(plainRoot, { recursive: true });
    const plainFilePath = path.join(plainRoot, 'plain.vp');
    fs.writeFileSync(plainFilePath, 'import t\n\nx: int = 0\n', 'utf8');

    // 环境 2：正规工程（含 includes/builtins.vp）
    const projRoot = path.join(base, 'Proj');
    fs.mkdirSync(path.join(projRoot, 'includes'), { recursive: true });
    fs.writeFileSync(
        path.join(projRoot, 'includes', 'builtins.vp'),
        'import t\n\nuint32: t.CTypedef = t.CUInt32T\n',
        'utf8'
    );
    fs.mkdirSync(path.join(projRoot, 'App'), { recursive: true });
    const projFilePath = path.join(projRoot, 'App', 'main.vp');
    fs.writeFileSync(projFilePath, 'import t\n\nv: uint32 = 0\n', 'utf8');

    const configOptions = new ConfigOptions(UriEx.file(projRoot));
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');
    const makeEnv = (root: string) =>
        new ExecutionEnvironment(
            'python',
            UriEx.file(root),
            configOptions.diagnosticRuleSet,
            configOptions.defaultPythonVersion,
            configOptions.defaultPythonPlatform,
            [],
            /* skipNativeLibraries */ false,
            /* defaultDialect */ 'viper'
        );
    configOptions.executionEnvironments = [makeEnv(plainRoot), makeEnv(projRoot)];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    // 绑定顺序：先 plain.vp（环境 1，找不到 builtins.vp），再 main.vp（环境 2）
    const plainUri = UriEx.file(plainFilePath);
    const projUri = UriEx.file(projFilePath);
    program.setTrackedFiles([plainUri, projUri]);
    while (program.analyze()) {
        // 循环
    }

    const diagnostics = (program.getSourceFile(projUri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    const undefinedDiags = diagnostics.filter((d) => d.includes('未定义') || d.includes('undefined'));
    assert.strictEqual(
        undefinedDiags.length,
        0,
        `main.vp 不应报未定义（合并不得以第一个文件的环境为准），实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    fs.rmSync(base, { recursive: true, force: true });
});

test('builtins.vp 同名声明优先覆盖 builtins.vpi（ord 参数为 t.CChar）', () => {
    const source = `import t

def f() -> int:
    c: t.CChar = ord("a")
    return c
`;
    const { program, parseResults, serviceProvider } = buildProgram(source);

    // ord 在 builtins.vp 中声明为 ord(s: t.CChar) -> int，
    // 覆盖 builtins.vpi 的 ord(c: str | bytes | bytearray, /) -> int。
    // 通过 main 文件作用域链（含 builtin 作用域）解析 ord 符号。
    const AnalyzerNodeInfo = require('../analyzer/analyzerNodeInfo');
    const mainScope = AnalyzerNodeInfo.getScope(parseResults!.parserOutput.parseTree);
    const ordSymbol = mainScope?.lookUpSymbolRecursive?.('ord')?.symbol;
    assert(ordSymbol, 'ord 符号未找到（builtins.vp 覆盖未生效）');

    const ordType = program.getTypeOfSymbol(ordSymbol);
    const ordSignature = program.printType(ordType, { expandTypeAlias: true });
    assert(
        ordSignature.includes('CChar'),
        `ord 应使用 builtins.vp 的 t.CChar 签名，实际: ${ordSignature}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__builtins_vp_typedef__'), { recursive: true, force: true });
});

// 回归：完全不依赖工程 includes/builtins.vp —— C 定宽/最快/最小整型 typedef 已内建到
// typeshed-fallback/stdlib/builtins.vpi。用于修"uint32 报未定义"在找回 builtins.vp
// 失败的工程（如 Trae 中打开的文件集合/工作区根不同）里依然复现的问题。
test('无 includes/builtins.vp 时，内建 builtins.vpi 提供 uint32/sizet/int8', () => {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(
        createFromRealFileSystem(tempFile),
        new NullConsole(),
        tempFile
    );
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__builtins_vpi_only__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const filePath = path.join(testRoot, 'main.vp');
    // 该目录没有 includes/，也没有 extraPaths，builtins.vp 必然找不到。
    fs.writeFileSync(
        filePath,
        `import t

def f(a: uint32, b: sizet, c: int8, d: uint64) -> uint32:
    return a

def g(e: long, h: longlong, i: short, j: ushort, k: ulong, l: ulonglong) -> long:
    return e
`,
        'utf8'
    );

    const projectRoot = UriEx.file(testRoot);
    const configOptions = new ConfigOptions(projectRoot);
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');
    configOptions.executionEnvironments = [
        new ExecutionEnvironment(
            'python',
            projectRoot,
            configOptions.diagnosticRuleSet,
            configOptions.defaultPythonVersion,
            configOptions.defaultPythonPlatform,
            [],
            /* skipNativeLibraries */ false,
            /* defaultDialect */ 'viper'
        ),
    ];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    const uri = UriEx.file(filePath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    const undefinedDiags = diagnostics.filter((d) => d.includes('未定义') || d.includes('undefined'));
    assert.strictEqual(
        undefinedDiags.length,
        0,
        `内建 builtins.vpi 应提供 uint32/sizet/int8/uint64，实际: ${JSON.stringify(diagnostics)}`
    );

    // 注解类型：uint32 → CUInt32T，sizet → CSizeT，int8 → CInt8T，uint64 → CUInt64T
    const parseResults = program.getSourceFile(uri)!.getParseResults();
    const types = collectParamAnnotationTypes(program, parseResults!);
    const fTypes = types.get('f') ?? [];
    for (const expected of ['CUInt32T', 'CSizeT', 'CInt8T', 'CUInt64T']) {
        assert(
            fTypes.some((t) => t.includes(expected)),
            `f() 参数注解应包含 ${expected}，实际: ${JSON.stringify(fTypes)}`
        );
    }

    // C 基本类型名：long → CLong，longlong → CLongLong，short/ushort/ulong/ulonglong
    const gTypes = types.get('g') ?? [];
    for (const expected of ['CLong', 'CLongLong', 'CShort', 'CUnsignedShort', 'CUnsignedLong', 'CUnsignedLongLong']) {
        assert(
            gTypes.some((t) => t.includes(expected)),
            `g() 参数注解应包含 ${expected}，实际: ${JSON.stringify(gTypes)}`
        );
    }

    program.dispose();
    serviceProvider.dispose();
    fs.rmSync(testRoot, { recursive: true, force: true });
});
