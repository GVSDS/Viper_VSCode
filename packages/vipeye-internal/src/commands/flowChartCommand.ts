/*
 * flowChartCommand.ts
 *
 * Viper 扩展：为「函数跳转图」提供 LSP 服务端命令。
 *
 * 客户端（vscode-vipeye）把「文件 uri + 光标 offset」发过来，本命令：
 *   1) 按 offset 找到最内层节点；
 *   2) 从该节点向上找到最近的函数（方法优先于其所在类，故光标在方法内即取方法）；
 *   3) 用 AST 构建控制流图（见 analyzer/flowChartBuilder.ts），返回 Mermaid 文本与节点行号映射。
 *
 * 光标不在任何函数内时返回 undefined，由客户端提示用户。
 */

import { CancellationToken, ExecuteCommandParams } from 'vscode-languageserver';

import { buildFlowChartForFunction, FlowChartNodeLines } from '../analyzer/flowChartBuilder';
import { findNodeByOffset } from '../analyzer/parseTreeUtils';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { LanguageServerInterface } from '../common/languageServerInterface';
import { convertOffsetToPosition } from '../common/positionUtils';
import { Uri } from '../common/uri/uri';
import { FunctionNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import { ServerCommand } from './commandController';

/** 服务端返回给客户端的流程图数据（跨进程传输）。 */
export interface FlowChartResponse {
    /** 函数名（面板标题用）。 */
    functionName: string;
    /** 完整 Mermaid 文本。 */
    mermaidText: string;
    /** 图节点 id → 源码行号（1 起），供点击节点跳转。 */
    nodeLines: FlowChartNodeLines;
    /** 函数在文档中的起始 / 结束行号（1 起）。 */
    startLine: number;
    endLine: number;
}

export class FlowChartCommand implements ServerCommand {
    constructor(private _ls: LanguageServerInterface) {}

    async execute(params: ExecuteCommandParams, token: CancellationToken): Promise<FlowChartResponse | undefined> {
        throwIfCancellationRequested(token);

        if (!params.arguments || params.arguments.length < 2) {
            return undefined;
        }

        const fileUri = Uri.parse(params.arguments[0] as string, this._ls.serviceProvider);
        const offset = params.arguments[1] as number;
        const workspace = await this._ls.getWorkspaceForFile(fileUri);

        return workspace.service.run((_program) => {
            const parseResults = workspace.service.getParseResults(workspace.service.fs.realCasePath(fileUri));
            if (!parseResults || offset === undefined) {
                return undefined;
            }

            const node = findNodeByOffset(parseResults.parserOutput.parseTree, offset);
            if (!node) {
                return undefined;
            }

            const functionNode = findInnermostFunction(node);
            if (!functionNode) {
                return undefined;
            }

            const chart = buildFlowChartForFunction(functionNode, parseResults.text, parseResults.parserOutput.lines);
            const lines = parseResults.parserOutput.lines;

            return {
                functionName: chart.functionName,
                mermaidText: chart.mermaidText,
                nodeLines: chart.nodeLines,
                startLine: convertOffsetToPosition(functionNode.start, lines).line + 1,
                endLine: convertOffsetToPosition(functionNode.start + functionNode.length - 1, lines).line + 1,
            };
        }, token);
    }
}

/**
 * 从指定节点向上找最近的函数定义。
 * 注意不能用 parseTreeUtils 的 getEnclosingFunction：它从 parent 起找，节点本身是函数时取不到；
 * 且它在类体内直接返回 undefined，而 Viper 的方法都写在类体里，那会导致方法全都取不到。
 * 本函数遇到 Function 即返回，因此光标在方法内时取到的是方法而不是类。
 */
function findInnermostFunction(node: ParseNode): FunctionNode | undefined {
    let curNode: ParseNode | undefined = node;

    while (curNode) {
        if (curNode.nodeType === ParseNodeType.Function) {
            return curNode;
        }

        curNode = curNode.parent;
    }

    return undefined;
}
