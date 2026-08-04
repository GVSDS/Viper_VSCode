/*
 * viperExternReturn.test.ts
 *
 * 验证 Viper 扩展：声明性函数（返回类型含 t.CExtern/t.CExport/t.State 等
 * C 修饰符标记，函数体为 pass）不应报 reportReturnType "must return value"。
 *
 * 场景（用户反馈）：socket.vp 85 行
 *   def socket(family: INT, type: INT, protocol: INT) -> u64 | t.CExtern | t.CExport: pass
 *
 * 运行：npx jest src/tests/viperExternReturn.test.ts --runInBand
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
const SOCKET_PATH = path.join(TRANSPYC_INCLUDES, 'socket.vp');

function buildProgram(targetPath: string) {
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

test('socket.vp 中声明性函数 socket() 返回类型含 CExtern/CExport 不报 returnMissing', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(SOCKET_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== socket.vp return diagnostics ===');
    const returnDiags = diagnostics.filter((d) => d.includes('must return value') || d.includes('return') || d.includes('返回'));
    returnDiags.forEach((d) => console.log(`  ${d}`));

    // socket.vp 85 行 def socket() -> u64 | t.CExtern | t.CExport: pass
    const missingReturn = diagnostics.filter((d) => d.includes('must return value') || d.includes('所有代码路径'));
    assert.strictEqual(
        missingReturn.length,
        0,
        `unexpected returnMissing errors: ${JSON.stringify(returnDiags)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('最小复现：u64 | t.CExtern | t.CExport 声明性函数不报 returnMissing', () => {
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

def socket(family: t.CInt, type: t.CInt, protocol: t.CInt) -> t.CUInt64T | t.CExtern | t.CExport: pass
`;
    const testDir = path.join(TRANSPYC_INCLUDES, '__extern_return_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'extern.vp');
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
        console.log('=== extern.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        const missingReturn = diagnostics.filter(
            (d) => d.includes('must return value') || d.includes('所有代码路径')
        );
        assert.strictEqual(
            missingReturn.length,
            0,
            `unexpected returnMissing errors: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});
