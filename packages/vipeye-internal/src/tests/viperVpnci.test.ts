/*
 * viperVpnci.test.ts
 *
 * 验证 Viper 不可编译注解文件 `.vpnci` 与 `.vpi` 配置完全一致：
 *   - `import MyModule` 可解析到 MyModule.vpnci（不报"导入失败/无法解析"）
 *   - .vpnci 文件被识别为 stub 文件（isStubFile）
 *   - from 导入其中的声明可正常引用
 *
 * 运行：npx jest src/tests/viperVpnci.test.ts --runInBand
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

(global as any).__rootDirectory = path.resolve();

function buildProgram(files: Record<string, string>) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__vpnci__');
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

    const uris = Object.keys(files).map((relPath) => UriEx.file(path.join(testRoot, relPath)));
    const urisMap: Record<string, any> = {};
    for (const relPath of Object.keys(files)) {
        urisMap[relPath] = UriEx.file(path.join(testRoot, relPath));
    }
    program.setTrackedFiles(uris);
    while (program.analyze()) {
        // 循环
    }

    return { program, configOptions, urisMap, testRoot, serviceProvider };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag) => {
        const line = diag.range ? diag.range.start.line + 1 : -1;
        return `[category=${diag.category}][line=${line}] ${diag.message}`;
    });
}

test('.vpnci 不可编译注解文件：import 解析成功、识别为 stub、声明可引用', () => {
    const { program, configOptions, urisMap, testRoot, serviceProvider } = buildProgram({
        'MyModule.vpnci': `def helper() -> int:
    ...
`,
        'main.vp': `from MyModule import helper
import MyModule

def main() -> int:
    return helper() + MyModule.helper()
`,
    });

    // 1. main.vp 中 import/from 均解析成功，无"无法解析"或未定义
    const mainDiags = getDiagnostics(program, configOptions, urisMap['main.vp']);
    assert(
        !mainDiags.some((d) => d.includes('无法解析') || d.includes('could not be resolved') || d.includes('未定义')),
        `import MyModule 应解析成功且 helper 可引用，实际: ${JSON.stringify(mainDiags)}`
    );

    // 2. .vpnci 文件被识别为 stub 文件（与 .vpi 一致）
    const stubFile = program.getSourceFile(urisMap['MyModule.vpnci']);
    assert(stubFile, 'MyModule.vpnci 应被程序索引');
    assert(stubFile.isStubFile(), 'MyModule.vpnci 应被识别为 stub 文件');

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(testRoot, { recursive: true, force: true });
});
