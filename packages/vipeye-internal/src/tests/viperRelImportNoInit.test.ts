/*
 * viperRelImportNoInit.test.ts
 *
 * 验证 Viper 相对导入在目录无 __init__.vp 时的行为：
 *   - `from . import X` 且目录中存在 X.vp → 正常解析，不报"命名空间包不完整"警告
 *   - `from . import 不存在` → 仍报"命名空间包不完整"警告
 *   - `import 空目录`（无 __init__.vp）→ 仍报"命名空间包不完整"警告
 *
 * 运行：npx jest src/tests/viperRelImportNoInit.test.ts --runInBand
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
    const testRoot = path.join(__dirname, '__rel_import__');
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

    return { program, configOptions, uris, urisMap, testRoot, serviceProvider };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag) => {
        const line = diag.range ? diag.range.start.line + 1 : -1;
        return `[category=${diag.category}][line=${line}] ${diag.message}`;
    });
}

test('目录无 __init__.vp 时，from . import X（X.vp 存在）不报命名空间包警告', () => {
    const { program, configOptions, urisMap, testRoot, serviceProvider } = buildProgram({
        'Call/CallGenBase.vp': `def base_helper():
    return 0
`,
        'Call/CallGenCBuiltin.vp': `from . import CallGenBase

def use_it() -> int:
    return CallGenBase.base_helper()
`,
        'Call/other.vp': `from . import Nonexistent

def f():
    return Nonexistent
`,
        'EmptyDir/.keep': ``,
        'main.vp': `import EmptyDir

def main():
    return 0
`,
    });

    // 1. from . import CallGenBase（CallGenBase.vp 存在）→ 不应报"命名空间包不完整"
    const callGenDiags = getDiagnostics(program, configOptions, urisMap['Call/CallGenCBuiltin.vp']);
    assert(
        !callGenDiags.some((d) => d.includes('缺少 __init__.vp')),
        `from . import CallGenBase 不应报命名空间包警告，实际: ${JSON.stringify(callGenDiags)}`
    );

    // 2. from . import Nonexistent（文件不存在）→ 解析为"未找到"（非命名空间包），
    //    不产生命名空间包警告；Nonexistent 使用处报未定义（证明导入确实失败）
    const otherDiags = getDiagnostics(program, configOptions, urisMap['Call/other.vp']);
    assert(
        !otherDiags.some((d) => d.includes('缺少 __init__.vp')),
        `from . import Nonexistent 不应报命名空间包警告，实际: ${JSON.stringify(otherDiags)}`
    );
    assert(
        otherDiags.length > 0,
        `from . import Nonexistent 应产生未定义/类型错误，实际: ${JSON.stringify(otherDiags)}`
    );

    // 3. import EmptyDir（目录无 __init__.vp）→ 仍报"命名空间包不完整"
    const mainDiags = getDiagnostics(program, configOptions, urisMap['main.vp']);
    assert(
        mainDiags.some((d) => d.includes('缺少 __init__.vp')),
        `import EmptyDir 应报命名空间包警告，实际: ${JSON.stringify(mainDiags)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(testRoot, { recursive: true, force: true });
});
