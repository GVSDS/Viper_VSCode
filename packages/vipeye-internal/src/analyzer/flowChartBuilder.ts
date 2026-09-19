/*
 * flowChartBuilder.ts
 *
 * Viper 扩展：把函数的 AST 转成「语句级控制流图（流程图）」，输出 Mermaid `flowchart TD` 文本，
 * 供 Webview（停靠面板）渲染函数跳转图。
 *
 * 覆盖的语句结构：
 *   - if / elif / else（elif 串成连续的菱形判断）
 *   - for / for-else、while / while-else（含回流边；else 只在「非 break 结束」时进入）
 *   - match / case（每个 case 一个菱形，支持 guard 与不可反驳模式）
 *   - try / except / else / finally（try 画成「正常/异常」菱形，异常链逐个 except，
 *     未匹配的异常画成「异常向上传播」终止节点，finally 汇聚所有路径）
 *   - break / continue / return / raise（终止节点；break/continue 绑定最内层循环）
 *   - with：透明展开（只加一个标题块，内部语句顺序展开）
 *   - 嵌套 def / class：折叠成单个节点，不展开其内部（避免图暴涨）
 *
 * 粒度：连续的无分支语句合并为一个基本块节点（矩形）；分支条件为菱形。
 *
 * 说明：本模块是纯语法层（AST）的图构建，不做类型分析，因此图是「语法跳转图」而非类型收窄图。
 */

import { convertOffsetToPosition } from '../common/positionUtils';
import { TextRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import {
    ForNode,
    FunctionNode,
    IfNode,
    MatchNode,
    ParseNode,
    ParseNodeType,
    StatementNode,
    TryNode,
    WhileNode,
    WithNode,
} from '../parser/parseNodes';
import { Token } from '../parser/tokenizerTypes';

/** 节点 id → 源码起始行号（1 起），供 Webview 点击节点跳转到源码用。 */
export interface FlowChartNodeLines {
    [nodeId: string]: number;
}

export interface FlowChartResult {
    /** 函数名（用于面板标题）。 */
    functionName: string;
    /** 完整的 Mermaid 文本。 */
    mermaidText: string;
    /** 节点 id → 源码行号。 */
    nodeLines: FlowChartNodeLines;
}

export function buildFlowChartForFunction(
    functionNode: FunctionNode,
    sourceText: string,
    lines: TextRangeCollection<TextRange>
): FlowChartResult {
    return new FlowChartBuilder(sourceText, lines).build(functionNode);
}

const enum ChartShape {
    /** 入口节点（胶囊）。 */
    Entry,
    /** 正常结束节点（胶囊）。 */
    Exit,
    /** 基本块（矩形）。 */
    Block,
    /** 分支条件（菱形）。 */
    Decision,
    /** 终止语句：return / raise / break / continue（圆角矩形）。 */
    Terminator,
}

interface ChartNode {
    id: string;
    shape: ChartShape;
    /** 节点上逐行显示的文本（未转义）。 */
    lines: string[];
}

interface ChartEdge {
    from: string;
    to: string;
    label: string | undefined;
}

// 循环作用域。break / continue 只绑定最内层循环，故每个循环一个实例并向下传递。
interface LoopScope {
    /** break 语句产生的出口，绕过 else 直接成为「循环之后」的入口。 */
    breakExits: string[];
    /** continue 语句节点，最后统一回连到循环条件。 */
    continueTargets: string[];
}

// try-finally 作用域。return/raise/break/continue 必须「穿过」finally 才能继续，
// 故这些出口的边要先连到 finally 入口，再由 finally 入口连出去（见 _routeThroughFinally）。
interface FinallyScope {
    /** 本层 finally 体的入口节点 id。 */
    entryId: string;
}

/** 单个节点最多展示的源码行数（超出截断，避免个别节点撑爆图）。 */
const MaxLinesPerNode = 12;
/** 单行最多展示的字符数。 */
const MaxCharsPerLine = 96;

class FlowChartBuilder {
    private _nodes: ChartNode[] = [];
    private _edges: ChartEdge[] = [];
    private _nodeMap = new Map<string, ChartNode>();
    private _nodeLines: FlowChartNodeLines = {};
    private _nextNodeId = 1;

    // 「待消费的边标签」：下次从该节点连出的边会带上这个标签。
    // 用于给分支出口（True/False、匹配/不匹配）打标签，而无需让 _buildStatements 感知标签。
    private _pendingEdgeLabels = new Map<string, string>();

    // try-finally 作用域栈（外层在前、内层在后）。为空表示当前不在任何 finally 内。
    private _finallyStack: FinallyScope[] = [];

    // 已连接过的边（from|to|label），避免「多条出口穿过同一个 finally」时产生重复边。
    private _edgeKeys = new Set<string>();

    // 函数结束节点，按需创建（正常落到末尾、或终止语句穿过 finally 之后都汇到它）。
    private _endNodeId: string | undefined;
    private _endNodeOffset = 0;

    constructor(private _sourceText: string, private _lines: TextRangeCollection<TextRange>) {}

    build(functionNode: FunctionNode): FlowChartResult {
        this._endNodeOffset = functionNode.start;

        const entryId = this._addNode(ChartShape.Entry, [this._getFunctionHeader(functionNode)], functionNode.start);
        const bodyExits = this._buildStatements(functionNode.d.suite.d.statements, [entryId], undefined);

        // 只有存在「正常落到函数末尾」的路径时才画结束节点（全 return 的函数就没有）。
        if (bodyExits.length > 0) {
            this._link(bodyExits, this._getEndNodeId());
        }

        return {
            functionName: functionNode.d.name.d.value,
            mermaidText: this._render(),
            nodeLines: this._nodeLines,
        };
    }

    private _getFunctionHeader(functionNode: FunctionNode): string {
        const params = functionNode.d.params
            .map((param) => (param.d.name ? this._getNodeText(param.d.name) : '...'))
            .join(', ');
        return `def ${functionNode.d.name.d.value}(${params})`;
    }

    // ===== 图元操作 =====

    private _addNode(shape: ChartShape, lines: string[], offset: number, mergeWithNodeId?: string): string {
        if (mergeWithNodeId !== undefined) {
            const existing = this._nodeMap.get(mergeWithNodeId)!;
            existing.lines.push(...lines);
            return mergeWithNodeId;
        }

        const id = `n${this._nextNodeId++}`;
        const node: ChartNode = { id, shape, lines: [] };
        this._appendNodeLines(node, lines);

        this._nodes.push(node);
        this._nodeMap.set(id, node);
        this._nodeLines[id] = convertOffsetToPosition(offset, this._lines).line + 1;
        return id;
    }

    private _appendNodeLines(node: ChartNode, lines: string[]): void {
        node.lines.push(...lines);

        // 超长基本块只保留前若干行，末尾换成省略提示（避免单个节点撑爆整张图）。
        if (node.lines.length > MaxLinesPerNode) {
            const hiddenCount = node.lines.length - MaxLinesPerNode;
            node.lines = node.lines.slice(0, MaxLinesPerNode);
            node.lines.push(`…（还有 ${hiddenCount} 行）`);
        }
    }

    private _link(fromIds: string[], toId: string, label?: string): void {
        for (const fromId of fromIds) {
            let edgeLabel = label;
            if (edgeLabel === undefined) {
                const pending = this._pendingEdgeLabels.get(fromId);
                if (pending !== undefined) {
                    edgeLabel = pending;
                    this._pendingEdgeLabels.delete(fromId);
                }
            }

            // 去重：多条出口穿过同一个 finally 时会产生同一条边，重复画出来只会让图变脏。
            const edgeKey = `${fromId}|${toId}|${edgeLabel ?? ''}`;
            if (this._edgeKeys.has(edgeKey)) {
                continue;
            }
            this._edgeKeys.add(edgeKey);

            this._edges.push({ from: fromId, to: toId, label: edgeLabel });
        }
    }

    /** 函数结束节点的 id（按需创建）。 */
    private _getEndNodeId(): string {
        if (!this._endNodeId) {
            this._endNodeId = this._addNode(ChartShape.Exit, ['结束'], this._endNodeOffset);
        }
        return this._endNodeId;
    }

    /**
     * 让「必须等 finally 执行完才能继续」的出口穿过 finally 链。
     * 例如 `try: return x finally: f()` 的真实顺序是 return x → f() → 函数返回，
     * 因此 return 的边要先连到 finally 入口，再由 finally 入口连到它原本的目标。
     *
     * @returns 调用方应该继续连出的节点 id：不在 finally 内就是原节点，否则是最外层 finally 入口。
     */
    private _routeThroughFinally(sourceId: string): string {
        let currentId = sourceId;

        for (let i = this._finallyStack.length - 1; i >= 0; i--) {
            const finallyEntryId = this._finallyStack[i].entryId;
            this._link([currentId], finallyEntryId);
            currentId = finallyEntryId;
        }

        return currentId;
    }

    /** 给「下一个从 nodeId 连出的边」预设标签（用于分支出口）。 */
    private _queueEdgeLabel(nodeId: string, label: string): void {
        this._pendingEdgeLabels.set(nodeId, label);
    }

    private _clearEdgeLabel(nodeId: string): void {
        this._pendingEdgeLabels.delete(nodeId);
    }

    // ===== 语句序列 =====

    /**
     * 顺序构建一批语句。
     * @param incoming 进入本批语句的「悬空出口」节点 id（尚未连出边）
     * @param openBlockId 可选的、允许继续追加语句的当前基本块（如 with 的标题块）
     * @returns 本批语句执行完后仍悬空的出口节点 id（终止语句不会产生出口）
     */
    private _buildStatements(
        statements: StatementNode[],
        incoming: string[],
        loopScope: LoopScope | undefined,
        openBlockId?: string
    ): string[] {
        let current = incoming;

        for (const statement of statements) {
            if (this._isCompoundStatement(statement)) {
                openBlockId = undefined;
                current = this._buildCompoundStatement(statement, current, loopScope);
                continue;
            }

            const nodeText = this._getNodeText(statement);
            if (this._isTerminatorStatement(statement)) {
                openBlockId = undefined;
                current = this._buildTerminatorStatement(statement, nodeText, current, loopScope);
                continue;
            }

            // 简单语句：能并入当前基本块就并入，否则新建块。
            if (openBlockId !== undefined && current.length === 1 && current[0] === openBlockId) {
                this._addNode(ChartShape.Block, [nodeText], statement.start, openBlockId);
                continue;
            }

            const blockId = this._addNode(ChartShape.Block, [nodeText], statement.start);
            this._link(current, blockId);
            current = [blockId];
            openBlockId = blockId;
        }

        return current;
    }

    private _isCompoundStatement(statement: StatementNode): boolean {
        switch (statement.nodeType) {
            case ParseNodeType.If:
            case ParseNodeType.While:
            case ParseNodeType.For:
            case ParseNodeType.Try:
            case ParseNodeType.With:
            case ParseNodeType.Match:
            case ParseNodeType.Function:
            case ParseNodeType.Class:
                return true;

            default:
                return false;
        }
    }

    /** 是否为终止语句（return / raise / break / continue）。它们位于 StatementList 内部。 */
    private _isTerminatorStatement(statement: StatementNode): boolean {
        if (statement.nodeType !== ParseNodeType.StatementList) {
            return false;
        }

        return statement.d.statements.some((smallStatement) => this._isTerminatorSmallStatement(smallStatement.nodeType));
    }

    private _isTerminatorSmallStatement(nodeType: ParseNodeType): boolean {
        return (
            nodeType === ParseNodeType.Return ||
            nodeType === ParseNodeType.Raise ||
            nodeType === ParseNodeType.Break ||
            nodeType === ParseNodeType.Continue
        );
    }

    private _buildTerminatorStatement(
        statement: StatementNode,
        nodeText: string,
        incoming: string[],
        loopScope: LoopScope | undefined
    ): string[] {
        const nodeId = this._addNode(ChartShape.Terminator, [nodeText], statement.start);
        this._link(incoming, nodeId);

        // 终止语句位于 finally 内时，真实顺序是「终止 → finally → 原去向」，
        // 因此出口节点换成最外层 finally 入口（不在 finally 内则仍是自身）。
        const exitId = this._routeThroughFinally(nodeId);

        if (statement.nodeType === ParseNodeType.StatementList) {
            for (const smallStatement of statement.d.statements) {
                if (
                    (smallStatement.nodeType === ParseNodeType.Break ||
                        smallStatement.nodeType === ParseNodeType.Continue) &&
                    loopScope
                ) {
                    // break / continue 的去向由循环收口，这里只登记它的最终出口。
                    if (smallStatement.nodeType === ParseNodeType.Break) {
                        loopScope.breakExits.push(exitId);
                    } else {
                        loopScope.continueTargets.push(exitId);
                    }
                    continue;
                }

                // return / raise 要等 finally 执行完才真正离开函数。
                if (
                    exitId !== nodeId &&
                    (smallStatement.nodeType === ParseNodeType.Return ||
                        smallStatement.nodeType === ParseNodeType.Raise)
                ) {
                    this._link([exitId], this._getEndNodeId());
                }
            }
        }

        // 终止语句之后不再有后继（return/raise 直接结束；break/continue 由循环收口）。
        return [];
    }

    private _buildCompoundStatement(
        statement: StatementNode,
        incoming: string[],
        loopScope: LoopScope | undefined
    ): string[] {
        switch (statement.nodeType) {
            case ParseNodeType.If:
                return this._buildIf(statement, incoming, loopScope);

            case ParseNodeType.While:
            case ParseNodeType.For:
                return this._buildLoop(statement, incoming, loopScope);

            case ParseNodeType.Match:
                return this._buildMatch(statement, incoming, loopScope);

            case ParseNodeType.Try:
                return this._buildTry(statement, incoming, loopScope);

            case ParseNodeType.With:
                return this._buildWith(statement, incoming, loopScope);

            case ParseNodeType.Function:
            case ParseNodeType.Class:
                return this._buildNestedDefinition(statement, incoming);

            default:
                return incoming;
        }
    }

    // ===== if / elif / else =====

    private _buildIf(node: IfNode, incoming: string[], loopScope: LoopScope | undefined): string[] {
        // firstToken 区分首分支（if）与后续分支（elif），标签据此显示。
        const condId = this._addNode(
            ChartShape.Decision,
            [`${this._getTokenText(node.d.firstToken)} ${this._getNodeText(node.d.testExpr)}`],
            node.start
        );
        this._link(incoming, condId);

        this._queueEdgeLabel(condId, 'True');
        const thenExits = this._buildStatements(node.d.ifSuite.d.statements, [condId], loopScope);
        this._clearEdgeLabel(condId);

        const elseSuite = node.d.elseSuite;
        if (!elseSuite) {
            // 无 else：条件为假的出口直接悬空，由后继语句（或结束节点）接走。
            this._queueEdgeLabel(condId, 'False');
            return thenExits.concat(condId);
        }

        if (elseSuite.nodeType === ParseNodeType.If) {
            // elif：串成下一个菱形，保证「False」标签落在连向 elif 条件的边上。
            this._queueEdgeLabel(condId, 'False');
            const elifExits = this._buildIf(elseSuite, [condId], loopScope);
            this._clearEdgeLabel(condId);
            return thenExits.concat(elifExits);
        }

        this._queueEdgeLabel(condId, 'False');
        const elseExits = this._buildStatements(elseSuite.d.statements, [condId], loopScope);
        this._clearEdgeLabel(condId);
        return thenExits.concat(elseExits);
    }

    // ===== for / while（含 else）=====

    private _buildLoop(
        node: WhileNode | ForNode,
        incoming: string[],
        loopScope: LoopScope | undefined
    ): string[] {
        const isWhile = node.nodeType === ParseNodeType.While;
        const conditionText = isWhile
            ? `while ${this._getNodeText(node.d.testExpr)}`
            : `for ${this._getNodeText(node.d.targetExpr)} in ${this._getNodeText(node.d.iterableExpr)}`;
        const trueLabel = isWhile ? 'True' : '还有元素';
        const falseLabel = isWhile ? 'False' : '迭代结束';

        const condId = this._addNode(ChartShape.Decision, [conditionText], node.start);
        this._link(incoming, condId);

        const bodySuite = isWhile ? node.d.whileSuite : node.d.forSuite;
        const scope: LoopScope = { breakExits: [], continueTargets: [] };

        this._queueEdgeLabel(condId, trueLabel);
        const bodyExits = this._buildStatements(bodySuite.d.statements, [condId], scope);
        this._clearEdgeLabel(condId);

        // 回流：循环体正常结束 + continue 都回到条件判断。
        this._link(bodyExits.concat(scope.continueTargets), condId);

        let normalExits: string[];
        if (node.d.elseSuite) {
            // for-else / while-else：只有「非 break 结束」才会进入 else。
            this._queueEdgeLabel(condId, falseLabel);
            normalExits = this._buildStatements(node.d.elseSuite.d.statements, [condId], scope);
            this._clearEdgeLabel(condId);
        } else {
            this._queueEdgeLabel(condId, falseLabel);
            normalExits = [condId];
        }

        // break 出口绕过 else，直接成为整个循环结构的出口。
        return normalExits.concat(scope.breakExits);
    }

    // ===== match / case =====

    private _buildMatch(node: MatchNode, incoming: string[], loopScope: LoopScope | undefined): string[] {
        const matchId = this._addNode(ChartShape.Block, [`match ${this._getNodeText(node.d.expr)}`], node.start);
        this._link(incoming, matchId);

        if (node.d.cases.length === 0) {
            return [matchId];
        }

        const exits: string[] = [];
        let fromId = matchId;

        for (const caseNode of node.d.cases) {
            const guardText = caseNode.d.guardExpr ? ` if ${this._getNodeText(caseNode.d.guardExpr)}` : '';
            const condId = this._addNode(
                ChartShape.Decision,
                [`case ${this._getNodeText(caseNode.d.pattern)}${guardText}`],
                caseNode.start
            );
            this._queueEdgeLabel(fromId, fromId === matchId ? '开始匹配' : '不匹配');
            this._link([fromId], condId);

            this._queueEdgeLabel(condId, '匹配');
            exits.push(...this._buildStatements(caseNode.d.suite.d.statements, [condId], loopScope));
            this._clearEdgeLabel(condId);

            fromId = condId;
        }

        // 最后一个 case 若不是「无条件匹配」，则「都不匹配」的出口悬空给后继语句。
        const lastCase = node.d.cases[node.d.cases.length - 1];
        if (!lastCase.d.isIrrefutable) {
            this._queueEdgeLabel(fromId, '都不匹配');
            exits.push(fromId);
        }

        return exits;
    }

    // ===== try / except / else / finally =====

    private _buildTry(node: TryNode, incoming: string[], loopScope: LoopScope | undefined): string[] {
        const tryId = this._addNode(ChartShape.Decision, ['try'], node.start);
        this._link(incoming, tryId);

        // finally 入口必须先建：try 体与各 handler 里的 return/raise/break/continue
        // 都要穿过它，_routeThroughFinally 才能拿到入口 id。
        const finallySuite = node.d.finallySuite;
        const finallyEntryId = finallySuite
            ? this._addNode(ChartShape.Block, ['finally'], finallySuite.start)
            : undefined;
        if (finallyEntryId) {
            this._finallyStack.push({ entryId: finallyEntryId });
        }

        // 正常路径：try 体 →（可选 else）。
        this._queueEdgeLabel(tryId, '正常');
        let normalExits = this._buildStatements(node.d.trySuite.d.statements, [tryId], loopScope);
        this._clearEdgeLabel(tryId);

        if (node.d.elseSuite) {
            normalExits = this._buildStatements(node.d.elseSuite.d.statements, normalExits, loopScope);
        }

        // 异常路径：逐个 except 连成链。
        const handlerExits: string[] = [];
        let handlerIncomingId = tryId;
        let handlerIncomingIsTry = true;

        for (const exceptNode of node.d.exceptClauses) {
            const typeText = exceptNode.d.typeExpr ? this._getNodeText(exceptNode.d.typeExpr) : '';
            const nameText = exceptNode.d.name ? ` as ${exceptNode.d.name.d.value}` : '';
            const condId = this._addNode(
                ChartShape.Decision,
                [`except ${typeText}${nameText}`.trim()],
                exceptNode.start
            );
            this._queueEdgeLabel(handlerIncomingId, handlerIncomingIsTry ? '异常' : '未匹配');
            this._link([handlerIncomingId], condId);

            this._queueEdgeLabel(condId, '匹配');
            handlerExits.push(
                ...this._buildStatements(exceptNode.d.exceptSuite.d.statements, [condId], loopScope)
            );
            this._clearEdgeLabel(condId);

            handlerIncomingId = condId;
            handlerIncomingIsTry = false;
        }

        // 没有任何 handler 匹配（或无 handler）时异常继续向上传播。
        const lastExcept = node.d.exceptClauses[node.d.exceptClauses.length - 1];
        const propagationSources: string[] = [];
        if (!lastExcept) {
            this._queueEdgeLabel(tryId, '异常');
            propagationSources.push(tryId);
        } else if (lastExcept.d.typeExpr) {
            // 裸 except（无类型）能兜住所有异常，故不再有传播路径。
            this._queueEdgeLabel(handlerIncomingId, '未匹配');
            propagationSources.push(handlerIncomingId);
        }

        // try 体 / else / handler 都已构建完，最后才轮到 finally 体，
        // 故从这里开始不再把出口穿过 finally（否则 finally 自己会被串进去）。
        if (finallyEntryId) {
            this._finallyStack.pop();
        }

        // 未匹配的异常也要先执行 finally，再向上传播。
        if (propagationSources.length > 0) {
            if (finallyEntryId) {
                this._link(propagationSources, finallyEntryId);
            }
            const propagationId = this._addNode(ChartShape.Terminator, ['raise（异常向上传播）'], node.start);
            this._link(finallyEntryId ? [finallyEntryId] : propagationSources, propagationId);
        }

        let exits = normalExits.concat(handlerExits);

        // finally：正常路径与各 handler 的出口都汇聚进来，执行完再继续向下。
        if (finallySuite && finallyEntryId) {
            this._link(exits, finallyEntryId);
            exits = this._buildStatements(finallySuite.d.statements, [finallyEntryId], loopScope, finallyEntryId);
        }

        return exits;
    }

    // ===== with =====

    private _buildWith(node: WithNode, incoming: string[], loopScope: LoopScope | undefined): string[] {
        const itemText = node.d.withItems
            .map((item) => {
                const exprText = this._getNodeText(item.d.expr);
                return item.d.target ? `${exprText} as ${this._getNodeText(item.d.target)}` : exprText;
            })
            .join(', ');
        const headerId = this._addNode(ChartShape.Block, [`with ${itemText}`], node.start);
        this._link(incoming, headerId);

        // with 是透明容器：内部语句顺序展开，并允许首条简单语句并入标题块。
        return this._buildStatements(node.d.suite.d.statements, [headerId], loopScope, headerId);
    }

    // ===== 嵌套 def / class =====

    private _buildNestedDefinition(statement: StatementNode, incoming: string[]): string[] {
        const headerText = this._getNodeText(statement).split('\n')[0];
        const nodeId = this._addNode(ChartShape.Block, [`${headerText.trim()} …（未展开）`], statement.start);
        this._link(incoming, nodeId);

        // 嵌套定义本身是声明语句，执行流继续向下。
        return [nodeId];
    }

    // ===== 文本与渲染 =====

    private _getNodeText(node: ParseNode): string {
        const text = this._sourceText.slice(node.start, TextRange.getEnd(node));
        return text.replace(/\s+/g, ' ').trim().slice(0, MaxCharsPerLine);
    }

    private _getTokenText(token: Token): string {
        return this._sourceText.slice(token.start, token.start + token.length);
    }

    private _render(): string {
        const output: string[] = ['flowchart TD'];

        for (const node of this._nodes) {
            const label = node.lines.map((line) => escapeMermaidLabel(line)).join('<br/>');
            output.push(`    ${node.id}${renderNodeShape(node.shape, label)}`);
        }

        for (const edge of this._edges) {
            const labelText = edge.label ? `|"${escapeMermaidLabel(edge.label)}"| ` : '';
            output.push(`    ${edge.from} -->${labelText ? ' ' + labelText : ' '}${edge.to}`);
        }

        output.push('');
        output.push('    classDef entry fill:none,stroke:#16a34a,stroke-width:2px');
        output.push('    classDef exitNode fill:none,stroke:#dc2626,stroke-width:2px');
        output.push('    classDef terminator fill:none,stroke:#dc2626,stroke-width:2px');
        output.push('    classDef decision fill:none,stroke:#d97706,stroke-width:2px');

        for (const node of this._nodes) {
            const className = getClassName(node.shape);
            output.push(`    class ${node.id} ${className}`);
        }

        return output.join('\n');
    }
}

function renderNodeShape(shape: ChartShape, label: string): string {
    switch (shape) {
        case ChartShape.Decision:
            return `{"${label}"}`;
        case ChartShape.Terminator:
            return `(["${label}"])`;
        case ChartShape.Entry:
        case ChartShape.Exit:
            return `(["${label}"])`;
        default:
            return `["${label}"]`;
    }
}

function getClassName(shape: ChartShape): string {
    switch (shape) {
        case ChartShape.Entry:
            return 'entry';
        case ChartShape.Exit:
            return 'exitNode';
        case ChartShape.Terminator:
            return 'terminator';
        case ChartShape.Decision:
            return 'decision';
        default:
            return 'block';
    }
}

/**
 * 转义 Mermaid 标签。
 * Mermaid 在带引号的标签里用 HTML 实体，且 `#` 是实体前缀，故先转义 `#`。
 */
function escapeMermaidLabel(text: string): string {
    return text
        .replace(/#/g, '#35;')
        .replace(/&/g, '#38;')
        .replace(/"/g, '#quot;')
        .replace(/</g, '#60;')
        .replace(/>/g, '#62;');
}
