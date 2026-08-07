/*
 * vpjEditorProvider.ts
 * .vpj 文件的自定义 Webview 编辑器，提供表单化编辑界面。
 * 用户需要查看/编辑原始 JSON 时，使用 "Open With..." 切换到原生文本编辑器。
 */

import * as vscode from 'vscode';

/** Webview 与扩展之间的消息协议。 */
type VpjMessage =
    | { Kind: 'Ready' }
    | { Kind: 'Changed'; Content: string }
    | { Kind: 'Error'; Message: string }
    | { Kind: 'OpenAsJson' };

export class VpjEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly ViewType = 'viper.vpjEditor';

    public static Register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new VpjEditorProvider(context);
        try {
            return vscode.window.registerCustomEditorProvider(VpjEditorProvider.ViewType, provider, {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            });
        } catch (e) {
            // viper 核心扩展与合并了核心代码的 vscode-vipeye 同时激活时，
            // 后激活者会因 viewType 已注册而抛错，导致整个扩展激活失败。
            // 此处跳过重复注册，编辑器由先注册的扩展提供，功能等价。
            console.warn(`[viper] ${VpjEditorProvider.ViewType} already registered by another extension, skipping.`);
            return { dispose() {} };
        }
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const webview = panel.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };

        webview.html = this.BuildHtml(webview);

        // 跟踪最近从 webview 收到的内容，用于过滤 onDidChangeTextDocument 的回声。
        // applyEdit 是异步的，onDidChangeTextDocument 可能在用户已输入更多字符后才触发，
        // 此时 lastSentContent 已更新为更新值，简单的等值比较无法过滤。
        // 用 Set 保留最近 1 秒内的所有发送内容，彻底避免回声。
        const recentWebviewContents = new Set<string>();

        // 初始内容推送。
        const PushContent = () => {
            webview.postMessage({ Kind: 'Init', Content: document.getText() });
        };

        // 文档外部变更时同步到 webview（跳过 webview 自身发起的变更回声）。
        const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() === document.uri.toString()) {
                const currentContent = document.getText();
                // 如果当前文档内容与最近 webview 发送的内容一致，说明是回声，跳过。
                if (recentWebviewContents.has(currentContent)) {
                    return;
                }
                webview.postMessage({ Kind: 'ExternalChange', Content: currentContent });
            }
        });

        // 接收 webview 消息。
        const msgSub = webview.onDidReceiveMessage((msg: VpjMessage) => {
            switch (msg.Kind) {
                case 'Ready':
                    PushContent();
                    break;
                case 'Changed':
                    // 记录本次发送内容，1 秒后清理。
                    recentWebviewContents.add(msg.Content);
                    setTimeout(() => recentWebviewContents.delete(msg.Content), 1000);
                    this.UpdateDocument(document, msg.Content);
                    break;
                case 'Error':
                    vscode.window.showErrorMessage(`Viper Project: ${msg.Message}`);
                    break;
                case 'OpenAsJson':
                    this.OpenAsJson(document.uri);
                    break;
            }
        });

        panel.onDidDispose(() => {
            changeSub.dispose();
            msgSub.dispose();
        });

        PushContent();
    }

    /** 关闭自定义编辑器，用原生文本编辑器打开同一文件。 */
    private async OpenAsJson(uri: vscode.Uri): Promise<void> {
        // 先关闭当前 webview 编辑器，再用默认文本编辑器打开。
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await vscode.window.showTextDocument(uri, { preview: false });
    }

    /** 写回文档（仅当内容变化时）。 */
    private UpdateDocument(document: vscode.TextDocument, content: string): void {
        if (document.getText() === content) {
            return;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), content);
        vscode.workspace.applyEdit(edit);
    }

    /** 生成 Webview HTML。 */
    private BuildHtml(webview: vscode.Webview): string {
        const nonce = GetNonce();
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Viper Project Editor</title>
<style>${GetStyles()}</style>
</head>
<body>
<div id="root">
  <header class="toolbar">
    <div class="title">Viper Project</div>
    <button id="btn-open-json" class="toolbar-btn" type="button" title="Open as plain JSON text">Open as JSON</button>
  </header>

  <section class="view">
    <div id="error-banner" class="error-banner hidden"></div>
    <div id="form-container"></div>
  </section>
</div>
<script nonce="${nonce}">${GetScript()}</script>
</body>
</html>`;
    }
}

/** 生成随机 nonce 用于 CSP。 */
function GetNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/** Webview 样式。 */
function GetStyles(): string {
    return `
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground, #333);
            background-color: var(--vscode-editor-background, #fff);
        }
        #root { display: flex; flex-direction: column; height: 100vh; }
        .toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 16px;
            border-bottom: 1px solid var(--vscode-panel-border, #ddd);
        }
        .title { font-weight: 600; font-size: 14px; }
        .toolbar-btn {
            padding: 4px 12px;
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-secondaryBackground, #5a5d5e);
            color: var(--vscode-button-secondaryForeground, #fff);
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            max-width: 200px;
        }
        .toolbar-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #6c7071);
        }
        .view { flex: 1; overflow: auto; padding: 16px; max-width: 900px; margin: 0 auto; width: 100%; }
        .section {
            border: 1px solid var(--vscode-panel-border, #ddd);
            border-radius: 4px;
            margin-bottom: 12px;
        }
        .section-header {
            padding: 8px 12px;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
            border-bottom: 1px solid transparent;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .section.collapsed .section-header { border-bottom-color: transparent; }
        .section.expanded .section-header { border-bottom-color: var(--vscode-panel-border, #ddd); }
        .section-header::before {
            content: '▼';
            font-size: 10px;
            transition: transform 0.1s;
        }
        .section.collapsed .section-header::before { transform: rotate(-90deg); }
        .section-body { padding: 12px; display: block; }
        .section.collapsed .section-body { display: none; }
        .field { display: flex; align-items: center; margin-bottom: 8px; gap: 8px; }
        .field label {
            flex: 0 0 160px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #666);
        }
        .field input[type="text"],
        .field input[type="number"],
        .field select {
            flex: 1;
            max-width: 400px;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border, #ddd);
            background-color: var(--vscode-input-background, #fff);
            color: var(--vscode-input-foreground, #333);
            font-family: inherit;
            font-size: 12px;
            border-radius: 2px;
        }
        .field input:focus, .field select:focus {
            outline: 1px solid var(--vscode-focusBorder, #007acc);
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .field input[type="checkbox"] { width: 16px; height: 16px; flex: 0 0 16px; }
        .array-container { flex: 1; display: flex; flex-direction: column; gap: 4px; max-width: 400px; }
        .array-item {
            display: flex;
            gap: 4px;
            margin-bottom: 4px;
            align-items: center;
        }
        .array-item input { flex: 1; }
        .array-add {
            padding: 2px 10px;
            font-size: 11px;
            background: var(--vscode-button-background, #007acc);
            color: var(--vscode-button-foreground, #fff);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            align-self: flex-start;
            max-width: 100px;
        }
        .array-remove {
            padding: 2px 8px;
            font-size: 11px;
            background: var(--vscode-errorForeground, #f14c4c);
            color: #fff;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            flex: 0 0 auto;
        }
        .error-banner {
            padding: 8px 12px;
            margin-bottom: 12px;
            background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
            color: var(--vscode-inputValidation-errorForeground, #f48771);
            border: 1px solid var(--vscode-inputValidation-errorBorder, #f48771);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            white-space: pre-wrap;
        }
        .hidden { display: none !important; }
    `;
}

/** Webview 脚本：负责表单渲染、双向同步、Open as JSON。 */
function GetScript(): string {
    return `
        const vscode = acquireVsCodeApi();
        let currentData = null;
        let suppressChange = false;
        let lastSentContent = null;  // 跟踪最后发送的内容，避免回声循环

        // Open as JSON 按钮。
        document.getElementById('btn-open-json').addEventListener('click', () => {
            vscode.postMessage({ Kind: 'OpenAsJson' });
        });

        // 接收扩展消息。
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.Kind === 'Init') {
                try {
                    currentData = JSON.parse(msg.Content);
                    lastSentContent = msg.Content;
                    suppressChange = true;
                    RenderForm(currentData);
                    document.getElementById('error-banner').classList.add('hidden');
                } catch (e) {
                    ShowError('Failed to parse JSON: ' + e.message);
                }
                suppressChange = false;
            } else if (msg.Kind === 'ExternalChange') {
                // 跳过自己发出的回声，避免输入时表单重建导致失焦
                if (msg.Content === lastSentContent) {
                    return;
                }
                try {
                    currentData = JSON.parse(msg.Content);
                    suppressChange = true;
                    RenderForm(currentData);
                    document.getElementById('error-banner').classList.add('hidden');
                } catch (e) {
                    ShowError('Failed to parse JSON: ' + e.message);
                }
                suppressChange = false;
            }
        });

        // 通知扩展已就绪。
        vscode.postMessage({ Kind: 'Ready' });

        function ShowError(message) {
            const banner = document.getElementById('error-banner');
            banner.textContent = message;
            banner.classList.remove('hidden');
        }

        function EmitChange() {
            if (suppressChange) return;
            const content = JSON.stringify(currentData, null, 4);
            lastSentContent = content;  // 记录发送内容
            vscode.postMessage({ Kind: 'Changed', Content: content });
        }

        // 字段更新辅助函数。
        function SetField(path, value) {
            const parts = path.split('.');
            let obj = currentData;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!obj[parts[i]]) obj[parts[i]] = {};
                obj = obj[parts[i]];
            }
            obj[parts[parts.length - 1]] = value;
            EmitChange();
        }

        function GetField(path, fallback) {
            const parts = path.split('.');
            let obj = currentData;
            for (const p of parts) {
                if (obj == null) return fallback;
                obj = obj[p];
            }
            return obj == null ? fallback : obj;
        }

        // 渲染表单。
        function RenderForm(data) {
            const container = document.getElementById('form-container');
            container.innerHTML = '';
            container.appendChild(BuildSection('Project', [
                { Key: 'name', Label: 'Name', Type: 'text' },
                { Key: 'version', Label: 'Version', Type: 'text' },
                { Key: 'source_dir', Label: 'Source Directory', Type: 'text' },
                { Key: 'build_dir', Label: 'Build Directory', Type: 'text' },
            ]));
            container.appendChild(BuildSection('Includes', [
                { Key: 'includes', Label: 'Include Paths', Type: 'array' },
            ]));
            container.appendChild(BuildSection('Compiler', [
                { Key: 'compiler.cmd', Label: 'Command', Type: 'text' },
                { Key: 'compiler.flags', Label: 'Flags', Type: 'array' },
            ]));
            container.appendChild(BuildSection('Linker', [
                { Key: 'linker.cmd', Label: 'Command', Type: 'text' },
                { Key: 'linker.flags', Label: 'Flags', Type: 'array' },
                { Key: 'linker.output', Label: 'Output', Type: 'text' },
            ]));
            container.appendChild(BuildSection('Target', [
                { Key: 'target.triple', Label: 'Triple', Type: 'text' },
                { Key: 'target.datalayout', Label: 'Data Layout', Type: 'text' },
            ]));
            container.appendChild(BuildSection('Options', [
                { Key: 'options.slice_level', Label: 'Slice Level', Type: 'number' },
                { Key: 'options.sha1_slice_level', Label: 'SHA1 Slice Level', Type: 'number' },
                { Key: 'options.target', Label: 'Target', Type: 'select', Options: ['llvm', 'c', 'asm'] },
                { Key: 'options.strict_mode', Label: 'Strict Mode', Type: 'checkbox' },
            ]));
        }

        function BuildSection(title, fields) {
            const section = document.createElement('div');
            section.className = 'section expanded';
            const header = document.createElement('div');
            header.className = 'section-header';
            header.textContent = title;
            header.addEventListener('click', () => {
                section.classList.toggle('expanded');
                section.classList.toggle('collapsed');
            });
            const body = document.createElement('div');
            body.className = 'section-body';
            for (const f of fields) {
                body.appendChild(BuildField(f));
            }
            section.appendChild(header);
            section.appendChild(body);
            return section;
        }

        function BuildField(field) {
            const wrapper = document.createElement('div');
            wrapper.className = 'field';
            const label = document.createElement('label');
            label.textContent = field.Label;
            wrapper.appendChild(label);

            if (field.Type === 'array') {
                const container = document.createElement('div');
                container.className = 'array-container';
                const items = GetField(field.Key, []) || [];
                items.forEach((item, idx) => {
                    container.appendChild(BuildArrayItem(container, field.Key, idx, item));
                });
                const addBtn = document.createElement('button');
                addBtn.className = 'array-add';
                addBtn.textContent = '+ Add';
                addBtn.addEventListener('click', () => {
                    const arr = GetField(field.Key, []) || [];
                    arr.push('');
                    SetField(field.Key, arr);
                    container.insertBefore(BuildArrayItem(container, field.Key, arr.length - 1, ''), addBtn);
                });
                container.appendChild(addBtn);
                wrapper.appendChild(container);
            } else if (field.Type === 'checkbox') {
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = !!GetField(field.Key, false);
                input.addEventListener('change', () => SetField(field.Key, input.checked));
                wrapper.appendChild(input);
            } else if (field.Type === 'select') {
                const select = document.createElement('select');
                field.Options.forEach((opt) => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.textContent = opt;
                    if (GetField(field.Key, '') === opt) option.selected = true;
                    select.appendChild(option);
                });
                select.addEventListener('change', () => SetField(field.Key, select.value));
                wrapper.appendChild(select);
            } else {
                const input = document.createElement('input');
                input.type = field.Type;
                input.value = GetField(field.Key, '');
                input.addEventListener('input', () => {
                    const v = field.Type === 'number' ? Number(input.value) : input.value;
                    SetField(field.Key, v);
                });
                wrapper.appendChild(input);
            }
            return wrapper;
        }

        function BuildArrayItem(container, key, idx, value) {
            const item = document.createElement('div');
            item.className = 'array-item';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = value;
            input.addEventListener('input', () => {
                const arr = GetField(key, []) || [];
                arr[idx] = input.value;
                SetField(key, arr);
            });
            const removeBtn = document.createElement('button');
            removeBtn.className = 'array-remove';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', () => {
                const arr = GetField(key, []) || [];
                arr.splice(idx, 1);
                SetField(key, arr);
                item.remove();
            });
            item.appendChild(input);
            item.appendChild(removeBtn);
            return item;
        }
    `;
}
