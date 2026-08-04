/*
 * viperIfElseRedecl.test.ts
 *
 * 验证 Viper 扩展：if/else 互斥分支中的同名变量声明不应被判定为遮蔽
 * （reportRedeclaration 误报），与 socket.vp 中 accept 方法的场景一致。
 *
 * 场景（用户反馈）：
 *   def accept(...):
 *       if platmacro.IS_WINDOWS:
 *           client_fd: u64 = w32.winsock2.accept(...)
 *           ...
 *       client_fd: INT = accept(...)   # ← 339 行，被报 "obscured by a declaration of the same name"
 *
 * 运行：npx jest src/tests/viperIfElseRedecl.test.ts --runInBand
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

test('socket.vp accept 方法中 if/else 分支同名 client_fd 不报遮蔽', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(SOCKET_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== socket.vp client_fd diagnostics ===');
    const clientFdDiags = diagnostics.filter(
        (d) => d.includes('client_fd') || d.includes('obscured')
    );
    clientFdDiags.forEach((d) => console.log(`  ${d}`));

    // 不应有 "obscured" 遮蔽错误（if/else 互斥分支的同名变量声明是合法的）
    const obscuredErrors = clientFdDiags.filter((d) => d.includes('obscured'));
    assert.strictEqual(
        obscuredErrors.length,
        0,
        `unexpected obscured errors: ${JSON.stringify(clientFdDiags)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('简单 if/else 互斥分支同名变量不同型不报遮蔽', () => {
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

    const code = `import t\n\ndef test(x: t.CInt):\n    if x > 0:\n        client_fd: t.CUInt64T = t.CUInt64T(1)\n        return client_fd\n    client_fd: t.CInt = t.CInt(2)\n    return client_fd\n`;
    const testDir = path.join(TRANSPYC_INCLUDES, '__ifelse_redecl_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'ifelse.vp');
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
        console.log('=== ifelse.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        const obscuredErrors = diagnostics.filter((d) => d.includes('obscured'));
        assert.strictEqual(
            obscuredErrors.length,
            0,
            `unexpected obscured errors: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});
