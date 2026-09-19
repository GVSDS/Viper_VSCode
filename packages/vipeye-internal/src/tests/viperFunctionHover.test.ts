/*
 * viperFunctionHover.test.ts
 *
 * 验证 Viper 方言下 hover 函数时显示详尽调试信息：
 *   - 定义位置（文件:行:列）
 *   - 修饰符（extern/export/inline）
 *   - 泛型参数
 *   - 参数列表（名称、类型、默认值、*args/**kwargs 类别）
 *   - 返回类型
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

test('Viper hover 函数显示详尽调试信息', () => {
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
    // 调试信息标题
    assert(contents.includes('函数调试信息'), `should include debug heading: ${contents}`);
    // 定义位置（此文件:3:17 —— `add` 在 L3 第 17 列）
    assert(contents.includes('位置'), `should include 位置: ${contents}`);
    assert(contents.includes('此文件'), `should include 此文件: ${contents}`);
    // 修饰符
    assert(contents.includes('修饰符'), `should include 修饰符: ${contents}`);
    assert(contents.includes('export'), `should include export modifier: ${contents}`);
    // 泛型参数
    assert(contents.includes('泛型参数'), `should include 泛型参数: ${contents}`);
    assert(contents.includes('[T]'), `should include [T]: ${contents}`);
    // 参数（类型按源码书写的完整 module 路径展示：注解写的是 `t.CInt`）
    assert(contents.includes('参数'), `should include 参数: ${contents}`);
    assert(contents.includes('a: t.CInt'), `should include param a: ${contents}`);
    assert(contents.includes('b: t.CInt = 10'), `should include param b with default: ${contents}`);
    // 返回类型
    assert(contents.includes('返回类型'), `should include 返回类型: ${contents}`);
    assert(contents.includes('t.CInt'), `should include return type: ${contents}`);

    program.dispose();
    serviceProvider.dispose();
});
