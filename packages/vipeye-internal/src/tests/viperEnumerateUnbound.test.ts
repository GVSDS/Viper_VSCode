/*
 * viperForLoopVarAfter.test.ts（文件：viperEnumerateUnbound.test.ts）
 *
 * 验证 Viper 方言下 for 循环变量在循环后的语义：
 *   - `for i, ch in enumerate(kw_arg)` 后，i 保留迭代类型 t.CSizeT（C 风格），
 *     而非 Python 语义的 `Unbound | CSizeT`（循环可能零次执行）
 *   - 循环后 `param_name[start + i + 1]` 的加法不再报"未绑定/加法违法"
 *
 * 运行：npx jest src/tests/viperEnumerateUnbound.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { convertOffsetToPosition } from '../common/positionUtils';
import { BinaryOperationNode, ForNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__enumerate_unbound__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const filePath = path.join(testRoot, 'main.vp');
    fs.writeFileSync(filePath, source, 'utf8');

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

    const uri = UriEx.file(filePath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const sourceFile = program.getSourceFile(uri);
    const parseResults = sourceFile!.getParseResults();
    return { program, configOptions, parseResults, uri, serviceProvider };
}

test('for enumerate 后 i 的类型与诊断 dump', () => {
    const source = `import t

def f(kw_arg: str, param_name: str) -> int:
    start: t.CSizeT = 0
    if param_name[0] == '%':
        start = 1
    for i, ch in enumerate(kw_arg):
        c: t.CChar = param_name[start + i]
        if c == '\\0' or c != ch:
            return 0
    if param_name[start + i + 1] != '\\0':
        return 0
    return 1
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    assert(parseResults);
    const ev = evaluator;
    const lines = parseResults.parserOutput.lines;
    const out: string[] = [];
    const diags = (program.getSourceFile(uri)!.getDiagnostics(configOptions) || []).map((d) => d.message);

    class BinOpCollector extends ParseTreeWalker {
        override visitBinaryOperation(node: BinaryOperationNode) {
            const pos = convertOffsetToPosition(node.start, lines);
            const t = ev.getType(node as any);
            out.push(
                `  L${pos.line + 1} binop=${node.d.operator} type=${t ? program.printType(t) : '(undefined)'}`
            );
            return true;
        }
    }
    new BinOpCollector().walk(parseResults.parserOutput.parseTree);

    // Viper（C 风格）：for 循环变量在循环后仍视为已定义（保留迭代类型），
    // 循环体内与循环后的 start + i / start + i + 1 均应为纯 CSizeT（无 Unbound）。
    const addOps = out.filter((l) => l.includes('binop=0'));
    assert(addOps.length >= 3, `应存在 3 个加法运算（循环体内 1 + 循环后 2），实际: ${JSON.stringify(out)}`);
    assert(
        addOps.every((l) => l.includes('type=CSizeT') && !l.includes('Unbound') && !l.includes('Unknown')),
        `加法运算应均为纯 CSizeT，实际: ${JSON.stringify(addOps)}`
    );

    // 不应有诊断（循环后使用 i 不再报未绑定/加法违法）
    assert(diags.length === 0, `不应有诊断，实际: ${JSON.stringify(diags)}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__enumerate_unbound__'), { recursive: true, force: true });
});
