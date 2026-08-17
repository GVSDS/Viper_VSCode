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

# 修饰关键字 + def（等价 t.CInline / t.CExport / t.CExtern）
inline def double_inline(x: t.CInt) -> t.CInt:
    return x * 2

export def double_export(x: t.CInt) -> t.CInt:
    return x * 2

extern def double_extern(x: t.CInt) -> t.CInt:
    pass

# state 不是关键字，仍可作字段名/成员名
state: t.CInt = 0

# enum / rnum + class（等价 t.CEnum / t.REnum）
enum class Color:
    RED: t.CInt = 0
    GREEN: t.CInt = 1

rnum class LLVMType:
    class Int:
        bits: t.CInt
    class Ptr:
        pointee: t.CPtr

# enum / rnum 单独使用（等价 class）
enum A:
    k: t.State

rnum B:
    class Inner:
        x: t.CInt

# union + class（等价 t.CUnion 风格）
union class Value:
    i: t.CInt
    f: t.CFloat

# union 单独使用（等价 class）
union D:
    x: t.CInt

def swap(p: IntPair | t.CPtr):
    tmp: t.CInt = c.Deref(p).a
    c.Deref(p).a = c.Deref(p).b
    c.Deref(p).b = tmp

def test_usage():
    r: t.CInt = double_export(21)
    g: t.CInt = Color.GREEN
    u: t.CFloat = Value.f
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

test('Viper 修饰关键字 inline/export/extern 单独使用报错', () => {
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

inline
export = 5
extern + 1

inline def ok(x: t.CInt) -> t.CInt:
    return x
`;
    const testDir = path.join(__dirname, '__viper_modifier_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'modifier.vp');
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
        console.log('=== modifier.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望：3 个"必须与 def 搭配"错误（inline / export / extern 单独使用），
        // 而 `inline def ok(...)` 不报错。
        const modifierErrors = diagnostics.filter(
            (d) => d.includes('必须与 def 搭配') || d.includes('must be used with')
        );
        assert.strictEqual(
            modifierErrors.length,
            3,
            `expected 3 modifier errors, got: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});

test('Viper def 别名 fn/fun/func/function 与 extern 函数体校验', () => {
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

# def 别名
fn f1(x: t.CInt) -> t.CInt:
    return x

fun f2(x: t.CInt) -> t.CInt:
    return x

func f3(x: t.CInt) -> t.CInt:
    return x

function f4(x: t.CInt) -> t.CInt:
    return x

# extern：函数体必须为 pass 或 None
extern def e_ok1(x: t.CInt) -> t.CInt:
    pass

extern def e_ok2(x: t.CInt) -> t.CInt:
    None

extern def e_bad(x: t.CInt) -> t.CInt:
    return x

# extern 声明可以省略函数体（无冒号、无 pass），": pass" 方式保留
extern def e_no_body(x: t.CInt) -> t.CInt

# extern + fn 别名，同样可以省略函数体
extern fn e_fn_no_body(x: t.CInt) -> t.CInt

def use():
    a: t.CInt = f1(1) + f2(2) + f3(3) + f4(4)
`;
    const testDir = path.join(__dirname, '__viper_alias_extern_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'alias_extern.vp');
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
        console.log('=== alias_extern.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望恰好 1 个 extern 函数体错误（e_bad），fn/fun/func/function 别名与
        // extern pass/None 函数体都不应报错。
        const externErrors = diagnostics.filter(
            (d) => d.includes('必须为 pass 或 None') || d.includes("body of only 'pass' or 'None'")
        );
        assert.strictEqual(
            externErrors.length,
            1,
            `expected 1 extern body error, got: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});

test('Viper fn/fun/func/function 单独使用报错，后跟 :/=/ 保持标识符', () => {
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

# fn 行尾单独使用 → 视为 def，报缺函数名
fn

# fun 后跟 '=' → 保持标识符（赋值，不是关键字）
fun = 5

# func 后跟 '(' → 保持标识符（调用，不是关键字）
func(1)

# function 后跟 ':' → 保持标识符（注解声明，不是关键字）
function: t.CInt = 0

# 正常用法不受影响
fn ok(x: t.CInt) -> t.CInt:
    return x
`;
    const testDir = path.join(__dirname, '__viper_fn_keyword_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'fn_keyword.vp');
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
        console.log('=== fn_keyword.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望恰好 1 个错误级诊断：fn 行尾单独使用报"缺函数名"；
        // fun=/func(/function: 保持标识符不应产生语法/类型错误。
        const errors = diagnostics.filter((d) => d.startsWith('[category=0]'));
        assert.strictEqual(
            errors.length,
            1,
            `expected exactly 1 error (fn alone), got: ${JSON.stringify(diagnostics)}`
        );
        assert.ok(
            errors[0].includes('函数名') || errors[0].includes('function name'),
            `expected missing-function-name error: ${JSON.stringify(errors)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});

test('builtins.vp 中 Asm/LLVMIR/AsmInp/AsmOut/LInp/LOut 签名可用且不报未定义', () => {
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

def test_builtins_asm_llvmir():
    r: t.CInt = 0
    # Asm：基础 + 输出/输入操作数 + 破坏列表
    Asm("nop")
    Asm(f"mov {AsmOut(r, t.ASM_DESCR.OUTPUT_REG)}, rdi", op=[t.ASM_DESCR.CLOBBER_MEMORY])
    Asm(f"mov eax, {AsmInp(r, t.ASM_DESCR.REG_ANY)}")
    # LLVMIR：LInp/LOut 标记操作数
    LLVMIR(f"{LOut(r)} = add i32 {LInp(r)}, {LInp(r)}")
`;
    const testDir = path.join(__dirname, '__viper_builtins_asm_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'builtins_asm.vp');
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
        console.log('=== builtins_asm.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望没有任何错误级诊断：Asm/LLVMIR/AsmInp/AsmOut/LInp/LOut 由隐式
        // builtins（builtins.vpi）提供，无需 import 即可直接使用。
        const errors = diagnostics.filter((d) => d.startsWith('[category=0]'));
        assert.strictEqual(
            errors.length,
            0,
            `unexpected error diagnostics: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});

test('Viper len 接受任意值并返回 t.SizeT', () => {
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

class Vec3:
    def __init__(self, x: t.CInt, y: t.CInt, z: t.CInt):
        self.x = x
        self.y = y
        self.z = z

    def __len__(self) -> t.CInt:
        return 3

class NoLen:
    a: t.CInt = 0

def test_len_any():
    n: t.CInt = 5
    f: t.CFloat = 3.5
    p: t.CPtr = None
    s: str = "hello"
    v = Vec3(1, 2, 3)
    nl = NoLen()
    # len 对 t.CType 原生类型（int/float/指针/str）：返回 t.SizeT，不报错
    a: t.CSizeT = len(n)
    b: t.CSizeT = len(f)
    c: t.CSizeT = len(p)
    d: t.CSizeT = len(s)
    # len 优先调用 __len__：有 __len__ 的结构体返回其返回类型
    e: t.CSizeT = len(v)
    # 无 __len__ 的结构体：报错
    bad = len(nl)
`;
    const testDir = path.join(__dirname, '__viper_len_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'len_any.vp');
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
        console.log('=== len_any.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望恰好 1 个错误级诊断：无 __len__ 的结构体 NoLen 使用 len() 报错；
        // t.CType 原生类型（int/float/指针/str）豁免；有 __len__ 的 Vec3 返回其返回类型。
        const errors = diagnostics.filter((d) => d.startsWith('[category=0]'));
        assert.strictEqual(
            errors.length,
            1,
            `expected exactly 1 error (NoLen without __len__), got: ${JSON.stringify(diagnostics)}`
        );
        assert.ok(
            errors[0].includes('__len__'),
            `expected __len__ error message: ${JSON.stringify(errors)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});

test('extern/export 支持直接声明形式 extern A(...)（无 def）', () => {
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

# extern/export 直接声明形式（无 def）
extern E1(x: t.CInt) -> t.CInt
extern E2(x: t.CInt) -> t.CInt: pass
export X1(x: t.CInt) -> t.CInt
export X2(x: t.CInt) -> t.CInt: pass
# def 形式保留
extern def E3(x: t.CInt) -> t.CInt
export def X3(x: t.CInt) -> t.CInt
# extern + fn 别名（无函数体）仍可用
extern fn E4(x: t.CInt) -> t.CInt

def use():
    a: t.CInt = E1(1) + X1(2) + E3(3) + X3(4)
`;
    const testDir = path.join(__dirname, '__viper_extern_direct_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'extern_direct.vp');
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
        console.log('=== extern_direct.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        // 期望没有任何错误级诊断：extern/export 直接声明形式与 def 形式均可。
        const errors = diagnostics.filter((d) => d.startsWith('[category=0]'));
        assert.strictEqual(
            errors.length,
            0,
            `unexpected error diagnostics: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});
