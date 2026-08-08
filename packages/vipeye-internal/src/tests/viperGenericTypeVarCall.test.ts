/*
 * viperGenericTypeVarCall.test.ts
 *
 * 验证 Viper 泛型类方法中 `T(v)`（用类型变量做 C 风格强转）不应报
 * "Object of type TypeVar is not callable" / "Attribute __call__ is unknown"。
 *
 * 场景：TransPyC/Test/GenericTest/App/main.vp
 *   class Box[T]():
 *       value: T
 *       def __init__(self, v: T):
 *           self.value = T(v)   # ← T(v) 类型变量调用
 *
 * 运行：npx jest src/tests/viperGenericTypeVarCall.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';

// 允许 vipershed-fallback（t.vpi/c.vpi 存根）被定位。
(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';
const GENERIC_TEST = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\Test\\GenericTest\\App\\main.vp';

function buildProgram(targetPath: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const projectRoot = UriEx.file(path.dirname(targetPath));
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

    const uri = UriEx.file(targetPath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环直到分析完成
    }

    return { program, serviceProvider, execEnv, uri, configOptions };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map(
        (diag) => `[category=${diag.category}] ${diag.message}`
    );
}

test('GenericTest 泛型类 Box 中 T(v) 类型变量调用不报 not callable', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(GENERIC_TEST);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== GenericTest not-callable diagnostics ===');
    const notCallable = diagnostics.filter(
        (d) => d.includes('not callable') || d.includes('not callable') || d.includes('不可调用')
    );
    notCallable.forEach((d) => console.log(`  ${d}`));

    assert.strictEqual(
        notCallable.length,
        0,
        `unexpected not-callable errors: ${JSON.stringify(notCallable)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('最小复现：泛型类方法中 T(v) 类型变量调用不报 not callable', () => {
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

    const code = `import t

class Box[T]():
    value: T

    def __init__(self, v: T):
        self.value = T(v)

    def get(self) -> T:
        return self.value

def make_box():
    b = Box(42)
    return b.get()
`;
    const testDir = path.join(__dirname, '__typevar_call_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'typevar.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    try {
        const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
        const program = new Program(importResolver, configOptions, serviceProvider);
        const uri = UriEx.file(testFile);
        program.setTrackedFiles([uri]);
        while (program.analyze()) {
            // 循环
        }

        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== typevar.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        const notCallable = diagnostics.filter(
            (d) => d.includes('not callable') || d.includes('不可调用') || d.includes('__call__')
        );
        assert.strictEqual(
            notCallable.length,
            0,
            `unexpected not-callable errors: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});



test('PEP 695 显式类型实参 double[t.CInt](21) 不报不可下标', () => {
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

    const code = `import t

def double[T](x: int) -> int:
    return x * 2

def test_explicit_type_arg():
    r: t.CInt = double[t.CInt](21)
`;
    const testDir = path.join(__dirname, '__typevar_call_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'explicit_type_arg.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    try {
        const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
        const program = new Program(importResolver, configOptions, serviceProvider);
        const uri = UriEx.file(testFile);
        program.setTrackedFiles([uri]);
        while (program.analyze()) {
            // 循环
        }

        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== explicit_type_arg.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        const notSubscriptable = diagnostics.filter(
            (d) => d.includes('not subscriptable') || d.includes('不可下标')
        );
        assert.strictEqual(
            notSubscriptable.length,
            0,
            `unexpected subscriptable errors: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});


test('c.Deref 对 IntPair | t.CPtr 联合返回结构体，成员访问解析为 CInt', () => {
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

    const code = `import t
import c

class IntPair:
    a: t.CInt
    b: t.CInt

def generic_swap[T](p: IntPair | t.CPtr):
    tmp: t.CInt = c.Deref(p).a
    c.Deref(p).a = c.Deref(p).b
    c.Deref(p).b = tmp
    bad: t.CInt = c.Deref(p).zzz
`;
    const testDir = path.join(__dirname, '__deref_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'deref.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    try {
        const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
        const program = new Program(importResolver, configOptions, serviceProvider);
        const uri = UriEx.file(testFile);
        program.setTrackedFiles([uri]);
        while (program.analyze()) {
            // 循环
        }

        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== deref.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望恰好 1 条"没有属性"：c.Deref(p).zzz 应报错（证明 Deref 结果是
        // 具体结构体 IntPair 而非 Unknown——Unknown 上访问任何成员都静默通过），
        // 而 c.Deref(p).a / .b 都不应报。
        const noAttr = diagnostics.filter(
            (d) =>
                d.includes('无法访问') ||
                d.includes('没有属性') ||
                d.includes('has no attribute') ||
                d.includes('未知的属性')
        );
        assert.strictEqual(
            noAttr.length,
            1,
            `expected exactly 1 no-attribute error, got: ${JSON.stringify(diagnostics)}`
        );
        assert.ok(noAttr[0].includes('zzz'), `expected zzz error: ${JSON.stringify(diagnostics)}`);

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});


test('Viper 关键字 inline/export/extern/state/enum/rnum/struct 解析与语义', () => {
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

    const code = `import t
import c

# 单独的 struct 关键字（等价 class）
struct IntPair:
    a: t.CInt
    b: t.CInt

# 修饰关键字 + def（等价 t.CInline / t.CExport / t.CExtern / t.State）
inline def double_inline(x: t.CInt) -> t.CInt:
    return x * 2

export def double_export(x: t.CInt) -> t.CInt:
    return x * 2

extern def double_extern(x: t.CInt) -> t.CInt:
    return x * 2

state def double_state(x: t.CInt) -> t.CInt:
    return x * 2

# enum / rnum + class（等价 t.CEnum / t.REnum）
enum class Color:
    RED: t.CInt = 0
    GREEN: t.CInt = 1

rnum class LLVMType:
    class Int:
        bits: t.CInt
    class Ptr:
        pointee: t.CPtr

def swap(p: IntPair | t.CPtr):
    tmp: t.CInt = c.Deref(p).a
    c.Deref(p).a = c.Deref(p).b
    c.Deref(p).b = tmp

def test_usage():
    r: t.CInt = double_export(21)
    g: t.CInt = Color.GREEN
`;
    const testDir = path.join(__dirname, '__viper_keywords_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'keywords.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    try {
        const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
        const program = new Program(importResolver, configOptions, serviceProvider);
        const uri = UriEx.file(testFile);
        program.setTrackedFiles([uri]);
        while (program.analyze()) {
            // 循环
        }

        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== keywords.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望没有任何错误级诊断（语法错误/类型错误都不允许）。
        const errors = diagnostics.filter((d) => d.startsWith('[category=0]'));
        assert.strictEqual(
            errors.length,
            0,
            `unexpected error diagnostics: ${JSON.stringify(errors)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});