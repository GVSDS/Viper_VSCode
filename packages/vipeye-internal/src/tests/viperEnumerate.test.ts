/*
 * viperEnumerate.test.ts
 *
 * 验证 Viper 方言下内置 enumerate 的语义：
 *   - enumerate(str) 调用类型为 enumerate[t.CChar]（_T 按 for 原迭代逻辑绑定元素类型）
 *   - `for i, ch in enumerate(str)` 中 i 为 t.CSizeT（size_t 索引）、ch 为迭代元素 t.CChar
 *   - 与 Python 声明（Iterable[_T] 协议、tuple[int, _T]）的差异由 Viper 特判覆盖
 *
 * 运行：npx jest src/tests/viperEnumerate.test.ts --runInBand
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
import { ForNode, CallNode, ExpressionNode, ParseNodeType } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__enumerate__');
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

// 收集所有 for 循环：iterable 表达式类型 + target 解包变量类型
function collectForTargets(
    program: Program,
    parseResults: any
): { iterableTypes: string[]; targets: Map<string, string[]> } {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    const ev = evaluator;
    const iterableTypes: string[] = [];
    const targets = new Map<string, string[]>();

    class ForCollector extends ParseTreeWalker {
        override visitFor(node: ForNode) {
            const iterableType = ev.getType(node.d.iterableExpr as any);
            if (iterableType) {
                iterableTypes.push(program.printType(iterableType));
            }
            const targetExpr = node.d.targetExpr;
            if (targetExpr.nodeType === ParseNodeType.Tuple) {
                for (const item of (targetExpr as any).d.items as ExpressionNode[]) {
                    if (item.nodeType === ParseNodeType.Name) {
                        const name = (item as any).d.value as string;
                        const t = ev.getType(item as any);
                        const list = targets.get(name) ?? [];
                        list.push(t ? program.printType(t) : '(undefined)');
                        targets.set(name, list);
                    }
                }
            }
            return true;
        }
    }
    new ForCollector().walk(parseResults.parserOutput.parseTree);

    return { iterableTypes, targets };
}

test('for i, ch in enumerate(kw_arg)：i 为 t.CSizeT、ch 为 t.CChar', () => {
    const source = `import t

def f(kw_arg: str) -> int:
    for i, ch in enumerate(kw_arg):
        pass
    return 0
`;
    const { program, parseResults, serviceProvider } = buildProgram(source);

    const { iterableTypes, targets } = collectForTargets(program, parseResults!);

    // 1. enumerate 调用类型：元素类型按 for 原迭代逻辑（str → t.CChar）
    assert(iterableTypes.some((t) => t === 'enumerate[CChar]'), `实际: ${JSON.stringify(iterableTypes)}`);

    // 2. 索引 i 为 t.CSizeT（size_t）
    const iTypes = targets.get('i');
    assert(iTypes && iTypes.some((t) => t === 'CSizeT'), `i 应为 CSizeT，实际: ${JSON.stringify(iTypes)}`);

    // 3. 元素 ch 为 t.CChar
    const chTypes = targets.get('ch');
    assert(chTypes && chTypes.some((t) => t === 'CChar'), `ch 应为 CChar，实际: ${JSON.stringify(chTypes)}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__enumerate__'), { recursive: true, force: true });
});

test('enumerate 迭代 CPtr 元素时 ch 为元素类型 T', () => {
    const source = `import t

def f(items: t.CPtr[int]) -> int:
    for i, item in enumerate(items):
        pass
    return i
`;
    const { program, parseResults, serviceProvider } = buildProgram(source);

    const { iterableTypes, targets } = collectForTargets(program, parseResults!);

    // 1. CPtr[int] 迭代 → 元素类型 int，enumerate 特化为 enumerate[int]
    assert(iterableTypes.some((t) => t === 'enumerate[int]'), `实际: ${JSON.stringify(iterableTypes)}`);

    // 2. 索引 i 仍为 t.CSizeT
    const iTypes = targets.get('i');
    assert(iTypes && iTypes.some((t) => t === 'CSizeT'), `i 应为 CSizeT，实际: ${JSON.stringify(iTypes)}`);

    // 3. 元素 item 为 int
    const itemTypes = targets.get('item');
    assert(itemTypes && itemTypes.some((t) => t === 'int'), `item 应为 int，实际: ${JSON.stringify(itemTypes)}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__enumerate__'), { recursive: true, force: true });
});
