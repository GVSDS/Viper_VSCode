/*
 * locReportView.ts
 * 「统计项目 LOC」报告面板：统计进度条 + KPI + 语言筛选 + 行数构成图 + 明细表。
 *
 * 数据由 lineCounter.ts 计算，本文件只负责展示：
 *   - 面板单例复用（再次统计只刷新同一面板）；
 *   - 骨架 HTML 内联脚本（packages/viper 不在打包器的资源复制清单里，
 *     外部脚本要改 rspack 配置才能落地，故用 nonce 内联脚本）；
 *   - 数据经 postMessage 下发，Webview 脚本就绪（ready）前的数据先缓存。
 */

import { randomBytes } from 'crypto';

import { Disposable, ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode';

import { LocReport, LocScanProgress } from './lineCounter';

/** 报表头部信息（工程名 / 工程文件 / 源目录）。 */
export interface LocReportHeader {
    ProjectName: string;
    ProjectFile: string;
    SourceDir: string;
}

/** 下发给 Webview 的报表数据。 */
export type LocReportPayload = LocReport & LocReportHeader;

/** 宿主 → Webview 的消息。 */
type ReportMessage =
    | { type: 'header'; payload: LocReportHeader }
    | { type: 'progress'; payload: LocScanProgress }
    | { type: 'report'; payload: LocReportPayload }
    | { type: 'error'; payload: { message: string } };

/** 两次进度上报之间的最小间隔（毫秒）：文件多时不至于刷爆消息通道。 */
const ProgressPostIntervalMs = 40;

export class LocReportView implements Disposable {
    private static currentPanel: LocReportView | undefined;

    private readonly panel: WebviewPanel;
    private readonly listeners: Disposable[] = [];
    private scriptReady = false;
    private header: LocReportHeader | undefined;
    private progress: LocScanProgress | undefined;
    private payload: LocReportPayload | undefined;
    private lastProgressPostAt = 0;

    private constructor(panel: WebviewPanel) {
        this.panel = panel;
        panel.webview.options = { enableScripts: true };
        panel.webview.html = BuildLocReportHtml(CreateNonce());

        this.listeners.push(
            panel.webview.onDidReceiveMessage((message: { type?: string } | undefined) => {
                if (message?.type === 'ready') {
                    this.scriptReady = true;
                    // 脚本刚就绪：把已缓存的状态补齐，避免丢失 ready 之前的下发。
                    this.PostHeader();
                    this.PostProgressNow();
                    this.PostReport();
                }
            }),
            panel.onDidDispose(() => this.Dispose())
        );
    }

    /** 打开（或复用）报告面板。 */
    static Show(context: ExtensionContext): LocReportView {
        if (LocReportView.currentPanel) {
            LocReportView.currentPanel.panel.reveal();
            return LocReportView.currentPanel;
        }

        const panel = window.createWebviewPanel(
            'viper.locReport',
            'Viper LOC',
            ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        const view = new LocReportView(panel);
        LocReportView.currentPanel = view;
        context.subscriptions.push(view);
        return view;
    }

    /** 开始一轮统计：面板切回进度态并清空上一轮报表。 */
    StartRun(projectName: string, projectFile: string, sourceDir: string): void {
        this.header = { ProjectName: projectName, ProjectFile: projectFile, SourceDir: sourceDir };
        this.progress = { ProcessedFiles: 0, TotalFiles: 0, CurrentFile: '' };
        this.payload = undefined;
        this.panel.title = `Viper LOC · ${projectName}`;

        this.PostHeader();
        this.PostProgressNow();
    }

    /** 上报扫描进度（按间隔节流，但每轮最后一个文件必发）。 */
    ReportProgress(progress: LocScanProgress): void {
        this.progress = progress;
        const isLastFile = progress.TotalFiles > 0 && progress.ProcessedFiles >= progress.TotalFiles;
        if (!isLastFile && Date.now() - this.lastProgressPostAt < ProgressPostIntervalMs) {
            return;
        }
        this.PostProgressNow();
    }

    /** 下发报表。 */
    ReportResult(payload: LocReportPayload): void {
        this.payload = payload;
        this.PostReport();
    }

    /** 下发错误（源目录不存在等）。 */
    ReportError(message: string): void {
        this.Post({ type: 'error', payload: { message } });
    }

    dispose(): void {
        this.Dispose();
    }

    private Dispose(): void {
        if (LocReportView.currentPanel === this) {
            LocReportView.currentPanel = undefined;
        }
        for (const listener of this.listeners) {
            listener.dispose();
        }
        this.listeners.length = 0;
        this.scriptReady = false;
    }

    private PostHeader(): void {
        if (this.header) {
            this.Post({ type: 'header', payload: this.header });
        }
    }

    private PostProgressNow(): void {
        this.lastProgressPostAt = Date.now();
        if (this.progress) {
            this.Post({ type: 'progress', payload: this.progress });
        }
    }

    private PostReport(): void {
        if (this.payload) {
            this.Post({ type: 'report', payload: this.payload });
        }
    }

    private Post(message: ReportMessage): void {
        if (!this.scriptReady) {
            return;
        }
        void this.panel.webview.postMessage(message);
    }
}

/** 生成 Webview 脚本用的 nonce。 */
function CreateNonce(): string {
    return randomBytes(16).toString('hex');
}

/** 面板骨架：静态 HTML + 内联样式 + 内联脚本（数据随后经 postMessage 下发）。 */
function BuildLocReportHtml(nonce: string): string {
    const contentSecurityPolicy = [
        `default-src 'none'`,
        `style-src 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
    <title>Viper LOC</title>
    <style>
        :root {
            --seg-code: var(--vscode-charts-blue, #3794ff);
            --seg-comment: var(--vscode-charts-green, #89d185);
            --seg-blank: var(--vscode-charts-orange, #d18616);
            --line: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        }
        body {
            margin: 0;
            padding: 0 0 24px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        header {
            padding: 14px 16px 10px;
            border-bottom: 1px solid var(--line);
        }
        h1 {
            margin: 0 0 6px;
            font-size: 1.35em;
            font-weight: 600;
        }
        .meta {
            opacity: 0.75;
            line-height: 1.6;
            word-break: break-all;
        }
        section {
            padding: 14px 16px 0;
        }
        .card {
            border: 1px solid var(--line);
            border-radius: 6px;
            padding: 12px 14px;
            margin-bottom: 12px;
            background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.06));
        }
        .card-title {
            font-weight: 600;
            margin-bottom: 10px;
            display: flex;
            align-items: baseline;
            gap: 10px;
            flex-wrap: wrap;
        }
        .card-title .hint {
            font-weight: 400;
            opacity: 0.7;
        }
        /* 进度条 */
        .bar {
            height: 8px;
            border-radius: 4px;
            overflow: hidden;
            background: var(--vscode-input-background, rgba(128, 128, 128, 0.2));
        }
        #progress-fill {
            height: 100%;
            width: 0;
            background: var(--seg-code);
            transition: width 90ms linear;
        }
        #progress-text {
            margin-top: 8px;
            font-variant-numeric: tabular-nums;
        }
        #progress-file {
            margin-top: 4px;
            opacity: 0.6;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        /* KPI */
        #kpis {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
            gap: 10px;
        }
        .kpi {
            border: 1px solid var(--line);
            border-radius: 6px;
            padding: 8px 12px;
        }
        .kpi-value {
            font-size: 1.5em;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            line-height: 1.25;
        }
        .kpi-label {
            opacity: 0.7;
            margin-top: 2px;
        }
        /* 语言筛选 */
        #filters {
            display: flex;
            flex-wrap: wrap;
            gap: 8px 18px;
        }
        .filter {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
        }
        .legend {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            opacity: 0.85;
        }
        .swatch {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 2px;
        }
        .swatch-code { background: var(--seg-code); }
        .swatch-comment { background: var(--seg-comment); }
        .swatch-blank { background: var(--seg-blank); }
        /* 行数构成图 */
        .chart-row {
            display: grid;
            grid-template-columns: minmax(90px, 140px) 1fr minmax(140px, 200px);
            align-items: center;
            gap: 10px;
            padding: 3px 0;
        }
        .chart-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .chart-track {
            height: 16px;
            border-radius: 3px;
            background: var(--vscode-input-background, rgba(128, 128, 128, 0.16));
        }
        .chart-bar {
            display: flex;
            height: 100%;
            border-radius: 3px;
            overflow: hidden;
        }
        .seg { height: 100%; }
        .seg-code { background: var(--seg-code); }
        .seg-comment { background: var(--seg-comment); }
        .seg-blank { background: var(--seg-blank); }
        .chart-value {
            font-variant-numeric: tabular-nums;
            opacity: 0.85;
            text-align: right;
        }
        /* 明细表 */
        table {
            width: 100%;
            border-collapse: collapse;
            font-variant-numeric: tabular-nums;
        }
        th, td {
            padding: 5px 8px;
            text-align: left;
            border-bottom: 1px solid var(--line);
            white-space: nowrap;
        }
        th.num, td.num { text-align: right; }
        thead th {
            opacity: 0.8;
            font-weight: 600;
            border-bottom: 1px solid var(--line);
        }
        tbody tr:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12)); }
        tr.total-row { font-weight: 600; }
        tr.total-row th, tr.total-row td { border-top: 1px solid var(--line); border-bottom: none; }
        .empty-row {
            opacity: 0.7;
            padding: 6px 0;
        }
        #empty, #error {
            padding: 16px;
            line-height: 1.7;
        }
        #error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
        [hidden] { display: none !important; }
    </style>
</head>
<body>
    <header>
        <h1 id="title">Viper LOC 统计</h1>
        <div class="meta">
            <div id="meta-source"></div>
            <div id="meta-file"></div>
            <div id="meta-skipped"></div>
        </div>
    </header>

    <section id="progress-card">
        <div class="card">
            <div class="card-title">正在统计<span class="hint">按已知语言递归扫描源目录</span></div>
            <div class="bar"><div id="progress-fill"></div></div>
            <div id="progress-text">正在收集文件…</div>
            <div id="progress-file"></div>
        </div>
    </section>

    <section id="report" hidden>
        <div class="card">
            <div class="card-title">概览<span class="hint" id="kpi-scope"></span></div>
            <div id="kpis"></div>
        </div>
        <div class="card">
            <div class="card-title">语言筛选<span class="hint">勾选参与统计的语言（概览、图表与表格同步过滤）</span></div>
            <div id="filters"></div>
        </div>
        <div class="card">
            <div class="card-title">
                行数构成
                <span class="legend"><span class="swatch swatch-code"></span>代码</span>
                <span class="legend"><span class="swatch swatch-comment"></span>注释</span>
                <span class="legend"><span class="swatch swatch-blank"></span>空行</span>
            </div>
            <div id="chart"></div>
        </div>
        <div class="card">
            <div class="card-title">语言明细</div>
            <table>
                <thead>
                    <tr>
                        <th>语言</th>
                        <th class="num">文件数</th>
                        <th class="num">总行数</th>
                        <th class="num">代码行</th>
                        <th class="num">注释行</th>
                        <th class="num">空行</th>
                        <th class="num">注释率</th>
                        <th class="num">平均行长</th>
                        <th class="num">字符数</th>
                    </tr>
                </thead>
                <tbody id="table-body"></tbody>
            </table>
        </div>
    </section>

    <div id="empty" hidden>源目录下没有已知语言的文件。</div>
    <div id="error" hidden></div>

    <script nonce="${nonce}">
        (function () {
            'use strict';

            var vscode = acquireVsCodeApi();
            var state = { header: null, progress: null, report: null, selected: {} };

            function el(id) {
                return document.getElementById(id);
            }

            function setText(id, value) {
                el(id).textContent = value === undefined || value === null ? '' : String(value);
            }

            function num(value) {
                return Number(value || 0).toLocaleString('en-US');
            }

            function pct(value) {
                return (value * 100).toFixed(1) + '%';
            }

            /** 注释率 = 注释行 /（代码行 + 注释行）。 */
            function commentRate(count) {
                var nonBlank = count.CodeLines + count.CommentLines;
                return nonBlank > 0 ? count.CommentLines / nonBlank : 0;
            }

            /** 平均行字符数 = 字符数 / 总行数。 */
            function averageLineLength(count) {
                return count.TotalLines > 0 ? count.Chars / count.TotalLines : 0;
            }

            function emptyCount() {
                return { FileCount: 0, TotalLines: 0, CodeLines: 0, CommentLines: 0, BlankLines: 0, Chars: 0 };
            }

            function sumCounts(rows) {
                var total = emptyCount();
                rows.forEach(function (row) {
                    total.FileCount += row.FileCount;
                    total.TotalLines += row.TotalLines;
                    total.CodeLines += row.CodeLines;
                    total.CommentLines += row.CommentLines;
                    total.BlankLines += row.BlankLines;
                    total.Chars += row.Chars;
                });
                return total;
            }

            function makeNode(tag, className, text) {
                var node = document.createElement(tag);
                if (className) {
                    node.className = className;
                }
                if (text !== undefined) {
                    node.textContent = text;
                }
                return node;
            }

            function setHidden(id, hidden) {
                if (hidden) {
                    el(id).setAttribute('hidden', '');
                } else {
                    el(id).removeAttribute('hidden');
                }
            }

            function renderHeader() {
                var header = state.header;
                if (!header) {
                    return;
                }
                setText('title', 'LOC 统计 · ' + header.ProjectName);
                setText('meta-source', '项目 ' + header.ProjectName + ' · 源目录 ' + header.SourceDir);
                setText('meta-file', '工程文件 ' + header.ProjectFile);
            }

            function renderProgress() {
                var progress = state.progress || { ProcessedFiles: 0, TotalFiles: 0, CurrentFile: '' };
                var ratio = progress.TotalFiles > 0 ? progress.ProcessedFiles / progress.TotalFiles : 0;
                el('progress-fill').style.width = (ratio * 100).toFixed(2) + '%';
                setText(
                    'progress-text',
                    progress.TotalFiles > 0
                        ? '已统计 ' + num(progress.ProcessedFiles) + ' / ' + num(progress.TotalFiles) + ' 个文件（' + pct(ratio) + '）'
                        : '正在收集文件…'
                );
                setText('progress-file', progress.CurrentFile || '');
            }

            function renderKpi(rows) {
                var totals = sumCounts(rows);
                var cards = [
                    ['文件数', num(totals.FileCount)],
                    ['总行数', num(totals.TotalLines)],
                    ['代码行', num(totals.CodeLines)],
                    ['注释行', num(totals.CommentLines)],
                    ['空行', num(totals.BlankLines)],
                    ['注释率', pct(commentRate(totals))],
                    ['平均行字符数', averageLineLength(totals).toFixed(1)],
                    ['字符总数', num(totals.Chars)]
                ];

                var host = el('kpis');
                host.textContent = '';
                cards.forEach(function (card) {
                    var node = makeNode('div', 'kpi');
                    node.appendChild(makeNode('div', 'kpi-value', card[1]));
                    node.appendChild(makeNode('div', 'kpi-label', card[0]));
                    host.appendChild(node);
                });
            }

            function renderFilters(languages) {
                var host = el('filters');
                host.textContent = '';
                languages.forEach(function (row) {
                    var label = makeNode('label', 'filter');
                    var input = document.createElement('input');
                    input.type = 'checkbox';
                    input.checked = !!state.selected[row.Language];
                    input.addEventListener('change', function () {
                        state.selected[row.Language] = input.checked;
                        renderReport();
                    });
                    label.appendChild(input);
                    label.appendChild(document.createTextNode(row.Language + '（' + num(row.FileCount) + ' 个文件）'));
                    host.appendChild(label);
                });
            }

            function renderChart(rows) {
                var host = el('chart');
                host.textContent = '';
                if (rows.length === 0) {
                    host.appendChild(makeNode('div', 'empty-row', '未选择任何语言'));
                    return;
                }

                var maxTotal = 1;
                rows.forEach(function (row) {
                    maxTotal = Math.max(maxTotal, row.TotalLines);
                });

                rows.forEach(function (row) {
                    var line = makeNode('div', 'chart-row');
                    line.appendChild(makeNode('div', 'chart-label', row.Language));

                    var track = makeNode('div', 'chart-track');
                    var bar = makeNode('div', 'chart-bar');
                    bar.style.width = ((row.TotalLines / maxTotal) * 100).toFixed(2) + '%';
                    [
                        ['code', row.CodeLines],
                        ['comment', row.CommentLines],
                        ['blank', row.BlankLines]
                    ].forEach(function (part) {
                        var segment = makeNode('div', 'seg seg-' + part[0]);
                        segment.style.width =
                            row.TotalLines > 0 ? ((part[1] / row.TotalLines) * 100).toFixed(2) + '%' : '0%';
                        bar.appendChild(segment);
                    });
                    track.appendChild(bar);
                    line.appendChild(track);

                    line.appendChild(
                        makeNode('div', 'chart-value', num(row.CodeLines) + ' 代码 / ' + num(row.TotalLines) + ' 行')
                    );
                    host.appendChild(line);
                });
            }

            function renderTable(rows, totalRow) {
                var host = el('table-body');
                host.textContent = '';

                var appendRow = function (row, label, isTotal) {
                    var tr = document.createElement('tr');
                    if (isTotal) {
                        tr.className = 'total-row';
                    }
                    [
                        label,
                        num(row.FileCount),
                        num(row.TotalLines),
                        num(row.CodeLines),
                        num(row.CommentLines),
                        num(row.BlankLines),
                        pct(commentRate(row)),
                        averageLineLength(row).toFixed(1),
                        num(row.Chars)
                    ].forEach(function (value, index) {
                        var cell = document.createElement(index === 0 ? 'th' : 'td');
                        cell.textContent = value;
                        if (index > 0) {
                            cell.className = 'num';
                        }
                        tr.appendChild(cell);
                    });
                    host.appendChild(tr);
                };

                rows.forEach(function (row) {
                    appendRow(row, row.Language, false);
                });
                appendRow(totalRow, '合计', true);
            }

            function renderReport() {
                var report = state.report;
                if (!report) {
                    return;
                }

                report.Languages.forEach(function (row) {
                    if (state.selected[row.Language] === undefined) {
                        state.selected[row.Language] = true;
                    }
                });

                var selectedRows = report.Languages.filter(function (row) {
                    return state.selected[row.Language];
                });

                setText('meta-skipped', '跳过目录 ' + (report.SkippedDirectories.length > 0 ? report.SkippedDirectories.join('、') : '（无）'));
                setText('kpi-scope', selectedRows.length === report.Languages.length ? '全部语言' : '已选 ' + selectedRows.length + ' / ' + report.Languages.length + ' 种语言');

                renderKpi(selectedRows);
                renderFilters(report.Languages);
                renderChart(selectedRows);
                renderTable(selectedRows, Object.assign({ Language: 'Total' }, sumCounts(selectedRows)));

                setHidden('progress-card', true);
                setHidden('report', false);
                setHidden('empty', report.Languages.length > 0);
                setHidden('error', true);
            }

            window.addEventListener('message', function (event) {
                var message = event.data;
                if (!message || !message.type) {
                    return;
                }

                if (message.type === 'header') {
                    state.header = message.payload || null;
                    state.progress = { ProcessedFiles: 0, TotalFiles: 0, CurrentFile: '' };
                    state.report = null;
                    state.selected = {};
                    renderHeader();
                    setHidden('progress-card', false);
                    setHidden('report', true);
                    setHidden('empty', true);
                    setHidden('error', true);
                    renderProgress();
                    return;
                }

                if (message.type === 'progress') {
                    state.progress = message.payload;
                    renderProgress();
                    return;
                }

                if (message.type === 'report') {
                    state.report = message.payload;
                    state.selected = {};
                    renderReport();
                    return;
                }

                if (message.type === 'error') {
                    setText('error', message.payload && message.payload.message ? message.payload.message : '统计失败');
                    setHidden('progress-card', true);
                    setHidden('report', true);
                    setHidden('empty', true);
                    setHidden('error', false);
                }
            });

            vscode.postMessage({ type: 'ready' });
        })();
    </script>
</body>
</html>`;
}
