/*
 * viperInlineLoop.test.ts
 *
 * 验证 Viper 的 `inline while cond:` / `inline for x in y:` 写法（内联循环标记）。
 *
 * 语义取舍：inline 只是代码生成期的内联提示，类型层无额外语义；
 * 解析器消费修饰关键字后按普通 while / for 语句解析，不报语法错误。
 * 语法高亮由 TextMate grammar（storage.modifier.viper）负责，不涉及语义 token。
 *
 * 运行：npx jest src/tests/viperInlineLoop.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { convertOffsetToPosition } from '../common/positionUtils';
import { ForNode, WhileNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__inline_loop__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const filePath = path.join(testRoot, 'main.vp');
    fs.writeFileSync(filePath, source, 'utf8');

    const projectRoot = UriEx.file(testRoot);
    const configOptions = new ConfigOptions(projectRoot);
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');
    configOptions.executionEnvironments = [
        new ExecutionEnvironment(
            'python',
            projectRoot,
            configOptions.diagnosticRuleSet,
            configOptions.defaultPythonVersion,
            configOptions.defaultPythonPlatform,
            [UriEx.file(TRANSPYC_INCLUDES)],
            /* skipNativeLibraries */ false,
            /* defaultDialect */ 'viper'
        ),
    ];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);
    const uri = UriEx.file(filePath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const parseResults = program.getSourceFile(uri)!.getParseResults();
    return { program, configOptions, parseResults, uri, serviceProvider };
}

test('inline while / inline for 可解析且不报语法错误', () => {
    const source = `def f() -> int:
    i: int = 0
    inline while i < 3:
        i += 1
    inline for j in range(3):
        i += j
    return i
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    // 诊断：不得出现 Error / Warning 类别
    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(errors.length, 0, `inline 循环不应产生错误/警告，实际: ${JSON.stringify(diagnostics)}`);

    // 形状：inline while → WhileNode；inline for → ForNode（修饰关键字被消费，不残留为表达式）
    const statements: { line: number; kind: 'while' | 'for' }[] = [];
    class LoopCollector extends ParseTreeWalker {
        override visitWhile(node: WhileNode) {
            statements.push({
                line: convertOffsetToPosition(node.start, parseResults!.parserOutput.lines).line + 1,
                kind: 'while',
            });
            return true;
        }
        override visitFor(node: ForNode) {
            statements.push({
                line: convertOffsetToPosition(node.start, parseResults!.parserOutput.lines).line + 1,
                kind: 'for',
            });
            return true;
        }
    }
    new LoopCollector().walk(parseResults!.parserOutput.parseTree);

    // 行号指向 while / for 关键字自身（inline 在上一列），L3 / L5
    const whileNode = statements.find((s) => s.kind === 'while');
    assert(whileNode, `inline while 未解析为 WhileNode，实际: ${JSON.stringify(statements)}`);
    const forNode = statements.find((s) => s.kind === 'for');
    assert(forNode, `inline for 未解析为 ForNode，实际: ${JSON.stringify(statements)}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__inline_loop__'), { recursive: true, force: true });
});

test('inline 用于 while / for 之外仍报「必须与 def 搭配使用」', () => {
    const source = `def f() -> int:
    i: int = 0
    inline if i:
        pass
    return i
`;
    const { program, configOptions, uri, serviceProvider } = buildProgram(source);

    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    assert(
        diagnostics.some((d) => d.includes('inline') && d.includes('def')),
        `inline if 应仍报修饰关键字错误，实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__inline_loop__'), { recursive: true, force: true });
});
