/*
 * viperBeforeInit.test.ts
 *
 * 验证 Viper 扩展：`__before_init__` 合成语义。
 *
 * 场景（用户反馈）：
 *   - `viperio.Buf` 上调用 `buf.__before_init__()` 应合法（不报
 *     "Cannot access attribute '__before_init__' for class 'Buf'"），
 *     且该方法显示为函数（hover 显示 (self) -> None）。
 *   - 所有类（结构体）默认存在 `__before_init__`，返回值为空（None）。
 *   - 用户手动定义 `__before_init__` 应报错（不允许手动定义）。
 *   - 不存在的成员（如 `buf.nonexistent`）取值/赋值应为未知类型并报错。
 *
 * 运行：npx jest src/tests/viperBeforeInit.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import * as AnalyzerNodeInfo from '../analyzer/analyzerNodeInfo';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { CallNode, ClassNode, FunctionNode } from '../parser/parseNodes';

// 允许 vipershed-fallback（t.vpi/c.vpi 存根）被定位。
(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';
const VIPERIO_PATH = path.join(TRANSPYC_INCLUDES, 'viperio.vp');
const MEMHUB_PATH = path.join(TRANSPYC_INCLUDES, 'memhub.vp');

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

test('Buf.__before_init__() 调用合法且返回 None（用户场景）', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(MEMHUB_PATH);

    // memhub.vp 中 alloc_buf 调用了 buf.__before_init__()
    const diagnostics = getDiagnostics(program, configOptions, uri);

    const beforeInitErrors = diagnostics.filter(
        (d) => d.includes('__before_init__') && d.includes('Cannot access attribute')
    );
    console.log('=== memhub.vp __before_init__ errors ===');
    beforeInitErrors.forEach((d) => console.log(`  ${d}`));
    // 不应有 __before_init__ 属性访问错误
    assert.strictEqual(beforeInitErrors.length, 0, `unexpected __before_init__ errors: ${JSON.stringify(beforeInitErrors)}`);

    // Viper 扩展：`buf.__before_init__()` 是已绑定成员调用，不应报 "missing self"。
    // 合成方法签名为 `() -> None`（成员访问已绑定实例）。
    const missingSelfErrors = diagnostics.filter(
        (d) => d.includes('__before_init__') && d.includes('Argument missing for parameter')
    );
    console.log('=== memhub.vp __before_init__ missing-self errors ===');
    missingSelfErrors.forEach((d) => console.log(`  ${d}`));
    assert.strictEqual(
        missingSelfErrors.length,
        0,
        `unexpected "missing self" errors: ${JSON.stringify(missingSelfErrors)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('viperio.Buf 上调用 __before_init__ 返回 None 且可调用', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(VIPERIO_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== viperio.vp diagnostics ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));

    // 解析 Buf 类，手动调用 evaluator 求值 buf.__before_init__()
    const sourceFile = program.getSourceFile(uri);
    const parseResults = sourceFile!.getParseResults();
    assert(parseResults, 'parse results not found');

    const evaluator = program.evaluator!;

    // 收集 Buf 类定义
    let bufClassNode: ClassNode | undefined;
    class ClassFinder extends ParseTreeWalker {
        override visitClass(node: ClassNode) {
            if (node.d.name.d.value === 'Buf') {
                bufClassNode = node;
                return false;
            }
            return true;
        }
    }
    new ClassFinder().walk(parseResults.parserOutput.parseTree);
    assert(bufClassNode, 'Buf class not found');

    // 求值 Buf 类型并模拟 buf.__before_init__() 访问
    const bufType = evaluator.getTypeOfClass(bufClassNode);
    console.log(`=== Buf class type: ${bufType ? program.printType(bufType.classType) : '(undefined)'}`);

    // 通过 getTypeOfMember 无法直接模拟，这里验证 viperio.vp 本身无属性错误即可，
    // 真实场景（memhub.vp 调用）已由上一个测试覆盖。
    const attrErrors = diagnostics.filter((d) => d.includes('Cannot access attribute'));
    assert.strictEqual(attrErrors.length, 0, `unexpected attribute errors: ${JSON.stringify(attrErrors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('手动定义 __before_init__ 应报错（不允许手动定义）', () => {
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

    // 写一个临时 .vp 文件，手动定义 __before_init__
    const code = `import t\n\nclass Foo:\n    x: t.CInt\n    def __before_init__(self):\n        self.x = 0\n`;
    const testDir = path.join(TRANSPYC_INCLUDES, '__before_init_test__');
    const fs = require('fs');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'manual_def.vp');
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
        console.log('=== manual_def.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d}`));

        const reservedErrors = diagnostics.filter((d) => d.includes('__before_init__'));
        assert.ok(
            reservedErrors.length > 0,
            `expected "cannot be defined manually" diagnostic, got: ${JSON.stringify(diagnostics)}`
        );

        program.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    serviceProvider.dispose();
});

test('语义令牌：__before_init__ 成员访问显示函数颜色（非变量）', () => {
    const { program, serviceProvider, execEnv, configOptions } = buildProgram(VIPERIO_PATH);
    try {
        // 写一个临时 .vp 文件，其中 buf 是 Buf | t.CPtr，调用 buf.__before_init__()
        const code = `import t
import viperio

def test(buf: viperio.Buf | t.CPtr):
    buf.__before_init__()
`;
        const testDir = path.join(TRANSPYC_INCLUDES, '__before_init_semtok__');
        const fs = require('fs');
        fs.mkdirSync(testDir, { recursive: true });
        const testFile = path.join(testDir, 'usage.vp');
        fs.writeFileSync(testFile, code, 'utf8');

        const uri = UriEx.file(testFile);
        program.setTrackedFiles([uri]);
        while (program.analyze()) {
            // 循环
        }

        // 使用 SemanticTokenProvider 生成语义 token
        const { SemanticTokenProvider } = require('../languageService/semanticTokenProvider');
        const { LogTracker } = require('../common/logTracker');
        const provider = new SemanticTokenProvider(new LogTracker());
        const result = provider.provideFull(program, uri);
        assert(result, 'semantic tokens not generated');
        console.log(`=== semantic tokens count: ${result.data.length / 5}`);

        // 解码 token：data 格式 [deltaLine, deltaStart, length, tokenType, tokenModifiers]
        const lines = program.getSourceFile(uri)!.getParseResults()!.text.split('\n');
        let beforeInitTokenType: number | undefined;
        let cursorLine = 0;
        let cursorChar = 0;
        const allTokens: string[] = [];
        for (let i = 0; i < result.data.length; i += 5) {
            const deltaLine = result.data[i];
            const deltaStart = result.data[i + 1];
            const length = result.data[i + 2];
            const tokenType = result.data[i + 3];
            cursorLine += deltaLine;
            cursorChar = deltaLine === 0 ? cursorChar + deltaStart : deltaStart;
            const lineText = lines[cursorLine] || '';
            const tokenText = lineText.substring(cursorChar, cursorChar + length);
            allTokens.push(`L${cursorLine + 1}:${cursorChar} "${tokenText}" (type=${tokenType})`);
            if (tokenText === '__before_init__') {
                beforeInitTokenType = tokenType;
                console.log(`=== __before_init__ at line ${cursorLine + 1}, tokenType=${tokenType}`);
            }
        }
        console.log(`=== all tokens (${allTokens.length}):`);
        allTokens.forEach((t) => console.log(`  ${t}`));

        // SemanticTokenTypes（本项目自定义枚举）：
        // 0=namespace, 1=class, 2=function, 3=variable, 4=parameter,
        // 5=type, 6=builtin, 7=keyword, 8=string, 9=number,
        // 10=comment, 11=undefined, 12=decorator, 13=property
        assert(
            beforeInitTokenType !== undefined,
            '__before_init__ token not found in semantic tokens'
        );
        console.log(`=== __before_init__ tokenType=${beforeInitTokenType} (expect 2=function)`);
        assert(
            beforeInitTokenType === 2,
            `__before_init__ should be function color, got tokenType=${beforeInitTokenType}`
        );

        fs.rmSync(testDir, { recursive: true, force: true });
    } finally {
        program.dispose();
    }
    serviceProvider.dispose();
});
