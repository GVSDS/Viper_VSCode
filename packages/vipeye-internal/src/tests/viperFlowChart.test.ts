/*
 * viperFlowChart.test.ts
 *
 * 验证函数跳转图（AST → Mermaid 控制流图）在各类语句结构下的产出：
 *   - if / elif / else
 *   - for / for-else、while / while-else（break 绕过 else、continue 回流条件）
 *   - match / case（含不可反驳的 `case _`）
 *   - try / except / finally（异常未匹配时的向上传播）
 *   - 节点 id 与「节点 → 行号」映射一一对应（点击跳转依赖该映射）
 *
 * 运行：npx jest src/tests/viperFlowChart.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { buildFlowChartForFunction } from '../analyzer/flowChartBuilder';
import { ImportResolver } from '../analyzer/importResolver';
import { FunctionNode } from '../parser/parseNodes';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { FullAccessHost } from '../common/fullAccessHost';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';

(global as any).__rootDirectory = path.resolve();

class FunctionCollector extends ParseTreeWalker {
    readonly functions: FunctionNode[] = [];

    override visitFunction(node: FunctionNode): boolean {
        this.functions.push(node);
        return true;
    }
}

function buildProgramForCode(code: string, fileName: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const projectRoot = UriEx.file(path.join(__dirname, '__flowchart__'));
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
    const testDir = path.join(__dirname, '__flowchart__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, fileName);
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环直到分析完成
    }

    return { program, uri };
}

/** 解析 code 并把名为 functionName 的函数的控制流图构建出来。 */
function buildChart(code: string, functionName: string) {
    const { program, uri } = buildProgramForCode(code, `${functionName}.vp`);
    const parseResults = program.getParseResults(uri);
    assert(parseResults, `parse results missing for ${functionName}`);

    const collector = new FunctionCollector();
    collector.walk(parseResults!.parserOutput.parseTree);

    const functionNode = collector.functions.find((func) => func.d.name.d.value === functionName);
    assert(functionNode, `function ${functionName} not found`);

    return buildFlowChartForFunction(functionNode!, parseResults!.text, parseResults!.parserOutput.lines);
}

interface ParsedEdge {
    from: string;
    label: string | undefined;
    to: string;
}

/** 还原 Mermaid 标签里的 HTML 实体（构建器会把 `#`/`&`/`"`/`<`/`>` 转义掉）。 */
function decodeMermaidLabel(text: string): string {
    return text
        .replace(/#quot;/g, '"')
        .replace(/#38;/g, '&')
        .replace(/#60;/g, '<')
        .replace(/#62;/g, '>')
        .replace(/#35;/g, '#');
}

/** 从 Mermaid 文本里解析出节点标签与边，便于做结构性断言。 */
function parseChart(mermaidText: string) {
    const nodeLabels = new Map<string, string>();
    const edges: ParsedEdge[] = [];

    for (const line of mermaidText.split('\n')) {
        const trimmed = line.trim();
        const nodeMatch = /^(n\d+)(?:\["(.+)"\]|\{"(.+)"\}|\(\["(.+)"\]\))$/.exec(trimmed);
        if (nodeMatch) {
            nodeLabels.set(nodeMatch[1], decodeMermaidLabel(nodeMatch[2] ?? nodeMatch[3] ?? nodeMatch[4] ?? ''));
            continue;
        }

        const edgeMatch = /^(n\d+)\s*-->\s*(?:\|"(.+?)"\|\s*)?(n\d+)$/.exec(trimmed);
        if (edgeMatch) {
            edges.push({ from: edgeMatch[1], label: edgeMatch[2], to: edgeMatch[3] });
        }
    }

    return {
        nodeLabels,
        edges,
        /** 按标签片段找节点 id（取第一个匹配）。 */
        findNode(labelPart: string): string {
            for (const [id, label] of nodeLabels) {
                if (label.includes(labelPart)) {
                    return id;
                }
            }
            throw new Error(`node containing "${labelPart}" not found in:\n${mermaidText}`);
        },
        hasEdge(from: string, to: string): boolean {
            return edges.some((edge) => edge.from === from && edge.to === to);
        },
    };
}

test('if / elif / else 串成连续菱形，True/False 分支齐全', () => {
    const code = `
def classify(n: int) -> int:
    result: int = 0
    if n > 0:
        result = 1
    elif n < 0:
        result = -1
    else:
        result = 0
    return result
`;
    const chart = buildChart(code, 'classify');
    console.log('=== if/elif/else 图 ===');
    console.log(chart.mermaidText);

    const parsed = parseChart(chart.mermaidText);
    assert(chart.mermaidText.startsWith('flowchart TD'), 'should be a mermaid flowchart');

    const ifNode = parsed.findNode('if n > 0');
    const elifNode = parsed.findNode('elif n < 0');
    const elseBody = parsed.findNode('result = 0');
    const thenBody = parsed.findNode('result = 1');
    const elifBody = parsed.findNode('result = -1');

    // if 的 True 进 then、False 进 elif；elif 的 True 进 elif 体、False 进 else。
    assert(parsed.hasEdge(ifNode, thenBody), 'if True 应连到 then 体');
    assert(parsed.hasEdge(ifNode, elifNode), 'if False 应连到 elif');
    assert(parsed.hasEdge(elifNode, elifBody), 'elif True 应连到 elif 体');
    assert(parsed.hasEdge(elifNode, elseBody), 'elif False 应连到 else 体');
    // 两条分支都汇入 return。
    const returnNode = parsed.findNode('return result');
    assert(parsed.hasEdge(thenBody, returnNode), 'then 出口应汇入 return');
    assert(parsed.hasEdge(elseBody, returnNode), 'else 出口应汇入 return');
});

test('for-else：break 绕过 else，continue 回流条件', () => {
    const code = `
def scan(n: int) -> int:
    total: int = 0
    for i in n:
        if i == 0:
            continue
        if i < 0:
            break
        total = total + i
    else:
        total = -1
    return total
`;
    const chart = buildChart(code, 'scan');
    console.log('=== for-else 图 ===');
    console.log(chart.mermaidText);

    const parsed = parseChart(chart.mermaidText);
    const loopCond = parsed.findNode('for i in n');
    const elseBody = parsed.findNode('total = -1');
    const breakNode = parsed.findNode('break');
    const continueNode = parsed.findNode('continue');
    const returnNode = parsed.findNode('return total');

    // 迭代结束才进 else；break 直接跳过 else。
    assert(parsed.hasEdge(loopCond, elseBody), '迭代结束应进入 else');
    assert(!parsed.hasEdge(breakNode, elseBody), 'break 不应进入 else');
    assert(parsed.hasEdge(breakNode, returnNode), 'break 应直接到 else 之后的语句');

    // continue 回流到循环条件；else 出口继续向下。
    assert(parsed.hasEdge(continueNode, loopCond), 'continue 应回流到循环条件');
    assert(parsed.hasEdge(elseBody, returnNode), 'else 出口应继续向下');
});

test('while-else：条件为假的出口进入 else', () => {
    const code = `
def countdown(n: int) -> int:
    while n > 0:
        n = n - 1
    else:
        n = 0
    return n
`;
    const chart = buildChart(code, 'countdown');
    console.log('=== while-else 图 ===');
    console.log(chart.mermaidText);

    const parsed = parseChart(chart.mermaidText);
    const condNode = parsed.findNode('while n > 0');
    const elseNode = parsed.findNode('n = 0');

    assert(parsed.hasEdge(condNode, elseNode), 'while 条件为假应进入 else');

    const falseEdge = parsed.edges.find((edge) => edge.from === condNode && edge.to === elseNode);
    assert.strictEqual(falseEdge?.label, 'False', 'while → else 的边应标记 False');
});

test('match-case：每个 case 一个菱形，不可反驳的 case 不再产生「都不匹配」出口', () => {
    const code = `
def route(n: int) -> int:
    match n:
        case 0:
            return 1
        case 1:
            return 2
        case _:
            return 3
`;
    const chart = buildChart(code, 'route');
    console.log('=== match-case 图 ===');
    console.log(chart.mermaidText);

    const parsed = parseChart(chart.mermaidText);
    const case0 = parsed.findNode('case 0');
    const case1 = parsed.findNode('case 1');
    const wildcard = parsed.findNode('case _');

    assert(parsed.hasEdge(case0, case1), 'case 0 不匹配应进入 case 1');
    assert(parsed.hasEdge(case1, wildcard), 'case 1 不匹配应进入 case _');
    assert(!chart.mermaidText.includes('都不匹配'), '最后一个 case 不可反驳时不应有「都不匹配」出口');
});

test('match-case：最后一个 case 可反驳时有「都不匹配」出口', () => {
    const code = `
def route2(n: int) -> int:
    match n:
        case 0:
            n = 1
    return n
`;
    const chart = buildChart(code, 'route2');
    const parsed = parseChart(chart.mermaidText);

    const case0 = parsed.findNode('case 0');
    const returnNode = parsed.findNode('return n');
    assert(chart.mermaidText.includes('都不匹配'), '可反驳的最后一个 case 应有「都不匹配」出口');
    assert(parsed.hasEdge(case0, returnNode), '「都不匹配」应连线到 match 之后的语句');
});

test('try / except / finally：异常向上传播与 finally 汇聚', () => {
    const code = `
def handle(n: int) -> int:
    try:
        n = n + 1
    except ValueError:
        n = 0
    finally:
        n = n * 2
    return n
`;
    const chart = buildChart(code, 'handle');
    console.log('=== try/except/finally 图 ===');
    console.log(chart.mermaidText);

    const parsed = parseChart(chart.mermaidText);
    const tryNode = parsed.findNode('try');
    const exceptNode = parsed.findNode('except ValueError');
    const finallyNode = parsed.findNode('finally');
    const propagateNode = parsed.findNode('异常向上传播');
    const exceptBody = parsed.findNode('n = 0');
    const returnNode = parsed.findNode('return n');

    assert(parsed.hasEdge(tryNode, exceptNode), 'try 异常应进入 except');
    // 未匹配的异常也要先执行 finally，再向上传播。
    assert(parsed.hasEdge(exceptNode, finallyNode), '未匹配的异常应先进入 finally');
    assert(parsed.hasEdge(finallyNode, propagateNode), 'finally 执行完异常才向上传播');
    // 正常路径与 handler 路径都要汇聚到 finally，再继续向下。
    assert(parsed.hasEdge(exceptBody, finallyNode), 'except 体应汇聚到 finally');
    assert(parsed.hasEdge(finallyNode, returnNode), 'finally 出口应继续向下');
});

test('try/finally：return 穿过 finally 之后才结束函数', () => {
    const code = `
def early(n: int) -> int:
    try:
        return n + 1
    finally:
        n = 0
`;
    const chart = buildChart(code, 'early');
    console.log('=== try/finally return 穿透图 ===');
    console.log(chart.mermaidText);

    const parsed = parseChart(chart.mermaidText);
    const returnNode = parsed.findNode('return n + 1');
    const finallyNode = parsed.findNode('finally');
    const endNode = parsed.findNode('结束');

    assert(parsed.hasEdge(returnNode, finallyNode), 'return 应先进入 finally');
    assert(parsed.hasEdge(finallyNode, endNode), 'finally 执行完才到函数结束');
});

test('try/finally：循环内 break 穿过 finally 之后才跳出循环', () => {
    const code = `
def scan2(n: int) -> int:
    for i in n:
        try:
            if i < 0:
                break
        finally:
            n = n * 2
    return n
`;
    const chart = buildChart(code, 'scan2');
    console.log('=== try/finally break 穿透图 ===');
    console.log(chart.mermaidText);

    const parsed = parseChart(chart.mermaidText);
    const breakNode = parsed.findNode('break');
    const finallyNode = parsed.findNode('finally');
    const returnNode = parsed.findNode('return n');

    assert(parsed.hasEdge(breakNode, finallyNode), 'break 应先进入 finally');
    assert(parsed.hasEdge(finallyNode, returnNode), 'finally 执行完才跳出循环到 return');
});

test('节点 id 与「节点 → 行号」映射一一对应，且行号在函数范围内', () => {
    const code = `
def mixed(n: int) -> int:
    total: int = 0
    for i in n:
        if i > 0:
            total = total + i
        else:
            total = total - i
    return total
`;
    const chart = buildChart(code, 'mixed');
    const parsed = parseChart(chart.mermaidText);

    const nodeIds = Array.from(parsed.nodeLabels.keys());
    assert(nodeIds.length > 0, '图中应有节点');

    for (const nodeId of nodeIds) {
        const line = chart.nodeLines[nodeId];
        assert(typeof line === 'number', `节点 ${nodeId} 缺少行号映射`);
        // mixed 从第 2 行开始，函数体结束在第 9 行。
        assert(line >= 2 && line <= 9, `节点 ${nodeId} 行号越界: ${line}`);
    }

    assert.strictEqual(chart.functionName, 'mixed');
});
