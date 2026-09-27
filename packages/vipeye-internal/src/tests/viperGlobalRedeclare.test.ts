/*
 * viperGlobalRedeclare.test.ts
 *
 * 验证 Viper 的「重复声明」规则（与 TPV AssignGenMixin 同口径）：
 * 模块级已有同名**运行期变量**时，函数内用**类型注解**声明同名变量无条件失败
 * （TypeError，判据不含类型是否一致）：
 *   ① 无 global/nonlocal → 会把全局遮蔽成局部 → 重复声明
 *   ② 有 global/nonlocal → 注解与既有全局声明重复 → 重复声明
 * 合法写法：函数内 `global x` + 无注解赋值 `x = v`；或换不重名的局部名。
 * 不检查：模块级自身的重复注解、类体成员、CDefine 宏常量、CTypedef 别名、同名函数。
 *
 * 运行：npx jest src/tests/viperGlobalRedeclare.test.ts --runInBand
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

function buildProgramForCode(code: string) {
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
    const testDir = path.join(__dirname, '__global_redeclare__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'global_redeclare.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');

    return { program, configOptions, uri, serviceProvider, sourceFile };
}

function getDiagnostics(sourceFile: any, configOptions: ConfigOptions): { category: number; line: number; message: string }[] {
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag: any) => ({
        category: diag.category,
        line: diag.range ? diag.range.start.line + 1 : -1,
        message: diag.message,
    }));
}

test('Viper 重复声明：函数内同名注解声明无条件失败（有/无 global 均报）', () => {
    const code = `import t

Counter: int = 0
Macro: t.CDefine = 16
Alias: t.CTypedef = uint32

def helper() -> int:
    return 0

def without_global() -> int:
    Counter: int = 1
    return 0

def with_global() -> int:
    global Counter
    Counter: int = 1
    return 0

def bare_annotation() -> int:
    Counter: int
    return 0

def ok_plain_assign() -> int:
    global Counter
    Counter = 1
    return 0

def ok_local() -> int:
    Other: int = 1
    return 0

def ok_macro() -> int:
    Macro: int = 1
    return 0

def ok_alias() -> int:
    Alias: int = 1
    return 0

def ok_func_name() -> int:
    helper: int = 1
    return 0

def ok_read() -> int:
    return Counter

class Holder:
    Counter: int = 2
`;
    const { program, configOptions, uri, serviceProvider, sourceFile } = buildProgramForCode(code);

    const diagnostics = getDiagnostics(sourceFile, configOptions);
    console.log('=== 重复声明诊断 ===');
    diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

    // 三处重复声明：L11（无 global）、L16（有 global）、L20（裸注解）
    const redeclarations = diagnostics.filter((d) => d.message.includes('Counter') && d.message.includes('global'));
    assert.strictEqual(
        redeclarations.length,
        3,
        `应报 3 处重复声明（L11/L16/L20）: ${JSON.stringify(redeclarations)}`
    );
    assert.deepStrictEqual(
        redeclarations.map((d) => d.line).sort((a, b) => a - b),
        [11, 16, 20],
        `重复声明应落在 L11/L16/L20: ${JSON.stringify(redeclarations)}`
    );
    for (const diag of redeclarations) {
        assert.strictEqual(diag.category, 0, `重复声明应为 error（category=0）: ${JSON.stringify(diag)}`);
    }

    // 合法的两种写法与例外（CDefine 宏、CTypedef 别名、同名函数、类体成员、仅读取）不得报错
    const unexpectedErrors = diagnostics.filter((d) => d.category === 0 || d.category === 1);
    assert.strictEqual(
        unexpectedErrors.length,
        redeclarations.length,
        `除 3 处重复声明外不应有其它错误/警告: ${JSON.stringify(unexpectedErrors)}`
    );

    program.dispose();
    serviceProvider.dispose();
});
