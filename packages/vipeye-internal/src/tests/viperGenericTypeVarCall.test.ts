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
    const testDir = path.join(TRANSPYC_INCLUDES, '__typevar_call_test__');
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
