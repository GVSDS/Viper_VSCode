/*
 * flowChartView.ts
 *
 * 「函数流程图」停靠面板（WebviewView）的客户端实现。
 *
 * 职责边界：
 *   - 服务端（vipeye-internal 的 flowChartCommand）用 AST 算出 Mermaid 文本与「节点 → 行号」映射；
 *   - 本文件负责把数据通过 postMessage 下发给 Webview、把「点击节点」转成跳转源码行、
 *     并把 Webview 导出的 PNG 落盘。
 *
 * 面板形态：注册在底部/侧边的停靠面板容器 `viper-flowchart` 里（VS Code 没有公开 API 能在编辑器
 * 上层叠浮层，停靠面板是公开 API 中最接近 hover 嵌入感的形式）。
 *
 * 渲染脚本刻意放在 media/flowChartWebview.js（以 <script src> 外部文件加载，不用内联脚本 + nonce）：
 * 外部脚本只需要 CSP 允许 `webview.cspSource`，不依赖 nonce，也不会因 hash/nonce 不匹配而被静默拦掉。
 */

import * as path from 'path';

import {
    commands,
    ExtensionContext,
    Range,
    Selection,
    TextEditorRevealType,
    Uri,
    ViewColumn,
    WebviewView,
    WebviewViewProvider,
    window,
    workspace,
} from 'vscode';

// 仅用类型：type-only import 在打包时会被完全擦除，不会把服务端代码带进客户端。
import type { FlowChartResponse } from 'vipeye-internal/commands/flowChartCommand';

/** Webview → 扩展的消息：点击节点跳转。 */
interface JumpToLineMessage {
    type: 'jump';
    /** 目标行号（1 起）。 */
    line: number;
}

/** Webview → 扩展的消息：渲染脚本已加载完成，可以下发数据。 */
interface ReadyMessage {
    type: 'ready';
}

/** Webview → 扩展的消息：导出 PNG（dataUrl 形如 data:image/png;base64,...）。 */
interface ExportPngMessage {
    type: 'exportPng';
    dataUrl: string;
    suggestedName: string;
}

type WebviewMessage = JumpToLineMessage | ReadyMessage | ExportPngMessage;

export class FlowChartViewProvider implements WebviewViewProvider {
    static readonly viewType = 'viper.flowChartView';

    private _view: WebviewView | undefined;
    /** 最近一次生成图时所在文档；点击节点与导出 PNG 都以它为基准。 */
    private _documentUri: Uri | undefined;
    /** 最近一次的图数据。面板尚未创建时先存这里，等 ready 后立即下发。 */
    private _chart: FlowChartResponse | undefined;
    /** Webview 侧脚本是否已就绪（未就绪时先不下发数据，避免消息丢失）。 */
    private _scriptReady = false;

    constructor(private _extensionUri: Uri) {}

    resolveWebviewView(webviewView: WebviewView): void {
        this._view = webviewView;
        this._scriptReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [Uri.joinPath(this._extensionUri, 'dist')],
        };

        webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
            if (message?.type === 'ready') {
                this._scriptReady = true;
                void this._postPayload();
                return;
            }

            if (message?.type === 'jump' && typeof message.line === 'number') {
                void this._revealLine(message.line);
                return;
            }

            if (message?.type === 'exportPng') {
                void this._saveExportedPng(message);
            }
        });

        // 视图被销毁（隐藏后 VS Code 回收 webview）时清空引用，
        // 避免后续 showChart 往已销毁的 webview 上写 html。
        webviewView.onDidDispose(() => {
            if (this._view === webviewView) {
                this._view = undefined;
                this._scriptReady = false;
            }
        });

        this._render();
    }

    /**
     * 展示某函数的流程图。
     * 面板未创建时（首次按快捷键）先用 `.focus` 命令把面板显示出来，
     * 等 resolveWebviewView + ready 之后会自动下发已缓存的数据。
     */
    async showChart(chart: FlowChartResponse, documentUri: Uri): Promise<void> {
        this._chart = chart;
        this._documentUri = documentUri;

        if (!this._view) {
            // 面板还没创建：先把面板显示出来，resolveWebviewView + ready 后会收到数据。
            await commands.executeCommand(`${FlowChartViewProvider.viewType}.focus`);
            return;
        }

        await this._postPayload();

        // 刷新时保留编辑器焦点，避免连续看图时不停抢焦点。
        this._view.show?.(true);
    }

    /** 把当前图数据下发给 Webview（脚本未就绪时先不发，等 ready 消息回调）。 */
    private async _postPayload(): Promise<void> {
        if (!this._view || !this._scriptReady) {
            return;
        }

        await this._view.webview.postMessage({ type: 'render', payload: this._chart ?? null });
    }

    /** 点击图节点后跳转到源码行。 */
    private async _revealLine(line: number): Promise<void> {
        const uri = this._documentUri;
        if (!uri) {
            return;
        }

        const target = new Range(line - 1, 0, line - 1, 0);

        // 文档已打开时直接复用它的编辑器（含光标定位），不新开标签页。
        const openedEditor = window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === uri.toString()
        );
        if (openedEditor) {
            openedEditor.selection = new Selection(target.start, target.start);
            openedEditor.revealRange(target, TextEditorRevealType.InCenter);
            return;
        }

        const document = await workspace.openTextDocument(uri);
        await window.showTextDocument(document, { selection: target, viewColumn: ViewColumn.One });
    }

    /** 保存 Webview 导出的 PNG：弹保存对话框，默认落在当前 .vp 文档同目录、文件名用函数名。 */
    private async _saveExportedPng(message: ExportPngMessage): Promise<void> {
        const base64 = message.dataUrl.replace(/^data:image\/png;base64,/, '');
        const documentUri = this._documentUri;
        const defaultUri = documentUri
            ? Uri.file(path.join(path.dirname(documentUri.fsPath), message.suggestedName))
            : Uri.file(message.suggestedName);

        const target = await window.showSaveDialog({
            defaultUri,
            filters: { 'PNG 图片': ['png'] },
            saveLabel: '导出',
        });
        if (!target) {
            return;
        }

        await workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
        void window.showInformationMessage(`已导出流程图：${target.fsPath}`);
    }

    /** 写入 Webview 的静态骨架（数据随后用 postMessage 下发）。 */
    private _render(): void {
        if (!this._view) {
            return;
        }

        // 重写 html 会让 webview 重新加载脚本，故就绪标记要重置，等新的 ready 消息。
        this._scriptReady = false;
        this._view.webview.html = this._buildHtml(this._view.webview);
    }

    private _buildHtml(webview: WebviewView['webview']): string {
        const mermaidUri = webview.asWebviewUri(
            Uri.joinPath(this._extensionUri, 'dist', 'media', 'mermaid.min.js')
        );
        const scriptUri = webview.asWebviewUri(
            Uri.joinPath(this._extensionUri, 'dist', 'media', 'flowChartWebview.js')
        );

        // 脚本均为外部文件，故 script-src 只需允许 webview 资源域，无需 nonce。
        const contentSecurityPolicy = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data:`,
            `font-src ${webview.cspSource}`,
            // mermaid 渲染出的 SVG 带内联 style，必须允许 inline 样式。
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src ${webview.cspSource}`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
    <title>函数流程图</title>
    <style>
        html,
        body {
            height: 100%;
        }
        body {
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            color: var(--vscode-foreground);
            background: var(--vscode-panel-background, transparent);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        #toolbar {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        }
        #title {
            font-weight: 600;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #hint {
            opacity: 0.7;
            white-space: nowrap;
        }
        #zoom-label {
            min-width: 44px;
            text-align: center;
            opacity: 0.8;
            font-variant-numeric: tabular-nums;
        }
        button {
            background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.25));
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            border: none;
            border-radius: 3px;
            padding: 3px 8px;
            cursor: pointer;
            font-family: inherit;
            font-size: inherit;
        }
        button:hover {
            background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.4));
        }
        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 600;
        }
        button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button[disabled] {
            opacity: 0.5;
            cursor: default;
        }
        button.link {
            background: transparent;
            padding: 2px 4px;
            opacity: 0.8;
        }
        #export-panel {
            flex: 0 0 auto;
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px 10px 10px;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
            background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.06));
        }
        .exp-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .exp-title {
            font-weight: 600;
        }
        .exp-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
            gap: 6px 16px;
        }
        .exp-field {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .exp-estimate {
            opacity: 0.75;
        }
        input[type='number'] {
            width: 76px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.4));
            border-radius: 2px;
            padding: 2px 4px;
            font-family: inherit;
            font-size: inherit;
        }
        select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border, rgba(128, 128, 128, 0.4));
            border-radius: 2px;
            padding: 2px 4px;
            font-family: inherit;
            font-size: inherit;
        }
        #chart {
            flex: 1 1 auto;
            position: relative;
            overflow: hidden;
            cursor: grab;
        }
        #chart-inner {
            position: absolute;
            top: 0;
            left: 0;
            transform-origin: 0 0;
        }
        #empty {
            padding: 16px;
            opacity: 0.8;
            line-height: 1.7;
        }
        kbd {
            padding: 1px 5px;
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.5));
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        #error {
            padding: 16px;
            color: var(--vscode-errorForeground);
            white-space: pre-wrap;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <span id="title"></span>
        <span id="hint" style="display: none;">点击节点可跳转到源码</span>
        <button id="btn-zoom-out" title="缩小">−</button>
        <span id="zoom-label">100%</span>
        <button id="btn-zoom-in" title="放大">＋</button>
        <button id="btn-fit" title="缩放到适应宽度">适应宽度</button>
        <button id="btn-reset" title="恢复 100% 并回到原点">重置</button>
        <button id="btn-export-toggle" title="展开导出设置">导出 PNG</button>
    </div>
    <div id="export-panel" style="display: none;">
        <div class="exp-row">
            <span class="exp-title">导出设置</span>
            <button id="btn-export-close" class="link" title="收起设置">收起 ▲</button>
        </div>
        <div class="exp-grid">
            <label class="exp-field">
                缩放倍率
                <select id="exp-scale">
                    <option value="1">1x</option>
                    <option value="2" selected>2x</option>
                    <option value="3">3x</option>
                    <option value="4">4x</option>
                </select>
            </label>
            <label class="exp-field">宽度 <input id="exp-width" type="number" min="1" placeholder="自动" /> px</label>
            <label class="exp-field">高度 <input id="exp-height" type="number" min="1" placeholder="自动" /> px</label>
            <label class="exp-field"><input id="exp-crop" type="checkbox" checked /> 裁掉空白边距</label>
            <label class="exp-field">
                <input id="exp-bg-transparent" type="radio" name="exp-bg" value="transparent" checked /> 透明背景
            </label>
            <label class="exp-field">
                <input id="exp-bg-white" type="radio" name="exp-bg" value="white" /> 白色背景
            </label>
        </div>
        <div class="exp-row">
            <span id="exp-estimate" class="exp-estimate">预计导出尺寸：—</span>
            <button id="btn-export-run" class="primary">导出文件…</button>
        </div>
    </div>
    <div id="chart">
        <div id="chart-inner"></div>
        <div id="empty">
            把光标放到函数内，按 <kbd>Ctrl+Alt+G</kbd>（macOS: <kbd>Cmd+Alt+G</kbd>）生成该函数的跳转图。<br />
            支持 if / elif / else、for / for-else、while / while-else、match-case、try / except / finally。<br />
            图内可拖拽平移（指针锁定，可无限拖）、滚轮缩放；点击节点跳转到对应源码行。
        </div>
        <div id="error" style="display: none;"></div>
    </div>
    <script src="${mermaidUri}"></script>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}

/** 注册面板 provider（供 extension.ts 调用）。 */
export function registerFlowChartView(context: ExtensionContext, extensionUri: Uri): FlowChartViewProvider {
    const provider = new FlowChartViewProvider(extensionUri);
    context.subscriptions.push(window.registerWebviewViewProvider(FlowChartViewProvider.viewType, provider));
    return provider;
}
