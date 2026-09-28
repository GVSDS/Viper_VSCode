/*
 * viperFunctionHover.test.ts
 *
 * 验证 Viper 方言下 hover 函数时只显示**签名**（不再附加「函数调试信息」区块）：
 * 原实现会在签名后追加位置/修饰符/泛型参数/参数/返回类型等调试信息，现已移除。
 *
 * 运行：npx jest src/tests/viperFunctionHover.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';
import { CancellationToken, MarkupContent, MarkupKind, Position } from 'vscode-languageserver';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { HoverProvider } from '../languageService/hoverProvider';

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
    const testDir = path.join(__dirname, '__hover__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'hover.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    return { program, configOptions, uri, testDir, serviceProvider };
}

test('Viper hover 函数只显示签名（不再附加函数调试信息）', () => {
    const code = `import t, c

export def add[T](a: t.CInt, b: t.CInt = 10) -> t.CInt:
    return a + b

def use():
    add(1, 2)
`;
    const { program, uri, serviceProvider } = buildProgramForCode(code);

    // 悬停在调用点 `add(1, 2)` 的 `add` 上（L7，零基行 6，列 4）
    const position: Position = { line: 6, character: 4 };
    const provider = new HoverProvider(program as any, uri, position, MarkupKind.Markdown, CancellationToken.None);
    const hover = provider.getHover();
    assert(hover, 'hover result should not be null');
    const contents = (hover.contents as MarkupContent).value;
    console.log('=== hover 内容 ===');
    console.log(contents);

    // 签名部分：代码围栏语言为 `python`。hover 代码块由宿主 markdown 渲染器用 TM 语法着色，
    // `viper` 围栏虽能取到本扩展贡献的语法，但只有注释/字符串/控制流关键字/数字等通用 scope
    // 能命中主题规则（`def`/`class` 的 storage.type.*.viper 与主题里按 Python 精调的规则不匹配，
    // 裸类型名语法里没有规则），只部分着色；`python`（MagicPython）着色齐全，故用它。
    assert(contents.includes('```python'), `should use python code fence: ${contents}`);
    assert(!contents.includes('```viper'), `should not use viper code fence: ${contents}`);
    assert(contents.includes('(function)'), `should include signature: ${contents}`);

    // 已移除「函数调试信息」区块：标题与各字段均不应再出现。
    for (const removed of ['函数调试信息', '修饰符', '泛型参数', '返回类型']) {
        assert(
            !contents.includes(removed),
            `hover 不应再包含已移除的调试信息字段「${removed}」：${contents}`
        );
    }

    program.dispose();
    serviceProvider.dispose();
});
