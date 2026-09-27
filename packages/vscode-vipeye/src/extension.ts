/*
 * extension.ts
 *
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Provides client for Viper language server. This portion runs
 * in the context of the VS Code process and talks to the server, which
 * runs in another process.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    commands,
    ExtensionContext,
    ExtensionMode,
    extensions,
    Position,
    ProgressLocation,
    Range,
    StatusBarAlignment,
    StatusBarItem,
    TextEditor,
    TextEditorEdit,
    Uri,
    window,
    workspace,
    WorkspaceConfiguration,
} from 'vscode';
import {
    CancellationToken,
    ConfigurationParams,
    ConfigurationRequest,
    LanguageClient,
    LanguageClientOptions,
    ResponseError,
    ServerOptions,
    TextEdit,
    TransportKind,
} from 'vscode-languageclient/node';

import { Commands } from 'vipeye-internal/commands/commands';
import { isThenable } from 'vipeye-internal/common/core';
import { getSemanticTokenCacheDir } from 'vipeye-internal/common/pathUtils';

// 仅用类型：type-only import 打包时会被擦除，不会把服务端代码带进客户端。
import type { FlowChartResponse } from 'vipeye-internal/commands/flowChartCommand';

// Viper 核心（packages/viper）——侧边栏活动栏（Project/Toolchain/Settings）、
// .vpj 项目管理与工具链。源码单一，本包直接引用，构建时一并打包。
import { activate as activateViperCore } from '../../viper/src/extension';

import { FileBasedCancellationStrategy } from './cancellationUtils';
import { registerFlowChartView } from './flowChartView';

let cancellationStrategy: FileBasedCancellationStrategy | undefined;

let languageClient: LanguageClient | undefined;

// 「清理并临时关停」执行中标志：清理期间语言服务已停、订阅已释放，
// 重复触发只会产生误导性的报错，故直接忽略。
let isCleaningUp = false;

// Request a heap size of 3GB. This is reasonable for modern systems.
const defaultHeapSize = 3072;

// 扩展宿主中是否已加载"贡献了 viper.* 命令的开发版"（即 --extensionDevelopmentPath 的调试副本）。
// 判据用命令 ID 前缀而非扩展 ID：发布版与开发版的包名可能不同
// （已安装的 TermiNexus.vipeye 与开发中的 TermiNexus.vscode-vipeye），
// 但两者贡献的命令 ID 相同，这正是命令重复注册冲突的来源。
function isDevelopmentCopyLoaded(): boolean {
    return extensions.all.some((ext) => {
        if (ext.extensionMode !== ExtensionMode.Development) {
            return false;
        }
        const contributedCommands: unknown = ext.packageJSON?.contributes?.commands;
        return (
            Array.isArray(contributedCommands) &&
            contributedCommands.some(
                (command: any) => typeof command?.command === 'string' && command.command.startsWith('viper.')
            )
        );
    });
}

/**
 * 服务端 `viper/analysisStatus` 通知的载荷，对应 vipeye-internal 的
 * `AnalysisProgress`（依赖图构建 / import 分析阶段的逐文件进度）。
 */
interface AnalysisStatusNotification {
    /** 当前正在分析的文件路径（Windows 下形如 C:\xxx\1.vp）。 */
    currentFile: string | undefined;

    /** 已分析的用户文件数。 */
    analyzed: number;

    /** 需要分析的用户文件总数。 */
    total: number;

    /** 分析是否已结束（true 时收起状态栏进度项）。 */
    done: boolean;
}

/**
 * 左下角状态栏的分析进度项：显示 `C:\xxx\1.vp (4/90) 4.44% loading...`。
 * 依赖图构建 / import 分析期间没有其他可见反馈，用户无法区分「插件在忙」
 * 与「插件卡死」，故这里给出实时进度；分析结束后自动隐藏。
 */
function UpdateAnalysisStatusItem(item: StatusBarItem, progress: AnalysisStatusNotification): void {
    if (progress.done || progress.total <= 0) {
        item.hide();
        return;
    }

    const percent = Math.min(100, (progress.analyzed / progress.total) * 100).toFixed(2);
    item.text = `$(sync~spin) ${progress.currentFile ?? '...'} (${progress.analyzed}/${progress.total}) ${percent}% loading...`;
    item.tooltip = `Viper：正在分析 ${progress.total} 个文件（依赖图构建 / import 分析）`;
    item.show();
}

export async function activate(context: ExtensionContext) {
    // 调试宿主让路：launch.json 用 --extensionDevelopmentPath 加载开发版时，VS Code 不会
    // 自动停用已安装的发布版，两者在同一扩展宿主内同时激活并注册同名 'viper.*' 命令，
    // 后激活者会失败：
    //   Activating extension ... failed: command 'viper.organizeimports' already exists.
    // 因此发布版（ExtensionMode.Production）一旦发现宿主中存在"贡献了 viper.* 命令的开发版"
    // （ExtensionMode.Development），就直接返回，不注册任何命令/视图/语言客户端，
    // 把位置完整让给调试版。
    if (context.extensionMode === ExtensionMode.Production && isDevelopmentCopyLoaded()) {
        return;
    }

    // Pylance detection disabled for Viper — this extension handles .vp/.vpi files,
    // which Pylance does not recognize, so there is no functional overlap.

    // 激活 Viper 核心：注册侧边栏活动栏（Project/Toolchain/Settings 视图）、
    // .vpj 自定义编辑器、状态栏与 viper.* 命令。
    const viperApi = await activateViperCore(context);

    cancellationStrategy = new FileBasedCancellationStrategy();

    const bundlePath = context.asAbsolutePath(path.join('dist', 'server.js'));
    const runOptions = { execArgv: [`--max-old-space-size=${defaultHeapSize}`] };
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6600', `--max-old-space-size=${defaultHeapSize}`] };

    // If the extension is launched in debug mode, then the debug server options are used.
    const serverOptions: ServerOptions = {
        run: {
            module: bundlePath,
            transport: TransportKind.ipc,
            args: cancellationStrategy.getCommandLineArguments(),
            options: runOptions,
        },
        // In debug mode, use the non-bundled code if it's present. The production
        // build includes only the bundled package, so we don't want to crash if
        // someone starts the production extension in debug mode.
        debug: {
            module: bundlePath,
            transport: TransportKind.ipc,
            args: cancellationStrategy.getCommandLineArguments(),
            options: debugOptions,
        },
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for Viper source files.
        documentSelector: [
            { scheme: 'file', language: 'viper' },
            { scheme: 'untitled', language: 'viper' },
        ],
        synchronize: {
            // Synchronize the setting section to the server.
            configurationSection: ['viper', 'vipeye'],
        },
        connectionOptions: { cancellationStrategy: cancellationStrategy },
        middleware: {
            // Use the middleware hook to override the configuration call. This allows
            // us to handle stubPath default-value suppression for the Viper analysis section.
            workspace: {
                configuration: async (
                    params: ConfigurationParams,
                    token: CancellationToken,
                    next: ConfigurationRequest.HandlerSignature
                ) => {
                    let result = next(params, token);
                    if (isThenable(result)) {
                        result = await result;
                    }
                    if (result instanceof ResponseError) {
                        return result;
                    }

                    for (const [i, item] of params.items.entries()) {
                        if (item.section === 'viper.analysis') {
                            const analysisConfig = workspace.getConfiguration(
                                item.section,
                                item.scopeUri ? Uri.parse(item.scopeUri) : undefined
                            );

                            // If stubPath is not set, remove it rather than sending default value.
                            // This lets the server know that it's unset rather than explicitly
                            // set to the default value (typings) so it can behave differently.
                            if (!isConfigSettingSetByUser(analysisConfig, 'stubPath')) {
                                delete (result[i] as any).stubPath;
                            }
                        }
                    }

                    return result;
                },
            },
        },
        initializationOptions: {
            diagnosticMode: workspace.getConfiguration('viper.analysis').get('diagnosticMode'),
            disablePullDiagnostics: workspace.getConfiguration('vipeye').get('disablePullDiagnostics'),
        },
    };

    // Create the language client and start the client.
    const client = new LanguageClient('vipeye', 'Vipeye', serverOptions, clientOptions);
    languageClient = client;

    // 左下角状态栏的分析进度项：显示正在分析哪个文件（`... (4/90) 4.44% loading...`），
    // 让用户知道依赖图构建 / import 分析是否在进行，而不是卡死了。
    const analysisStatusItem = window.createStatusBarItem(StatusBarAlignment.Left, 100);
    context.subscriptions.push(analysisStatusItem);
    context.subscriptions.push(
        client.onNotification('viper/analysisStatus', (progress: AnalysisStatusNotification) => {
            UpdateAnalysisStatusItem(analysisStatusItem, progress);
        })
    );

    // Register our custom commands.
    const textEditorCommands = [Commands.orderImports];
    textEditorCommands.forEach((commandName) => {
        context.subscriptions.push(
            commands.registerTextEditorCommand(
                commandName,
                (editor: TextEditor, edit: TextEditorEdit, ...args: any[]) => {
                    const cmd = {
                        command: commandName,
                        arguments: [editor.document.uri.toString(), ...args],
                    };

                    client.sendRequest<TextEdit[] | undefined>('workspace/executeCommand', cmd).then((edits) => {
                        if (edits && edits.length > 0) {
                            editor.edit((editBuilder) => {
                                edits.forEach((edit) => {
                                    const startPos = new Position(edit.range.start.line, edit.range.start.character);
                                    const endPos = new Position(edit.range.end.line, edit.range.end.character);
                                    const range = new Range(startPos, endPos);
                                    editBuilder.replace(range, edit.newText);
                                });
                            });
                        }
                    });
                },
                () => {
                    // Error received. For now, do nothing.
                }
            )
        );
    });

    const genericCommands = [Commands.createTypeStub, Commands.restartServer];
    genericCommands.forEach((command) => {
        context.subscriptions.push(
            commands.registerCommand(command, (...args: any[]) => {
                client.sendRequest('workspace/executeCommand', { command, arguments: args });
            })
        );
    });

    // 「清理并临时关停」：Ctrl+Shift+P → Viper: 清理并临时关停。
    //
    // 用途（多窗口互不干扰）：语言服务进程启动时会 chdir 到扩展自身目录
    // （见 languageServerBase.ts），Windows 下该目录随即被进程占用而无法删除；
    // 同时语义高亮磁盘缓存位于 ~/.vipeye/cache（跨会话、跨窗口共享）。
    // 于是"在 A 窗口卸载扩展"时，B 窗口占着目录与缓存，卸载删不干净，
    // 后续窗口会读到半删残留。这个命令让用户主动把某窗口的 Viper 完整停掉：
    // 终结服务端进程 → 释放本窗口全部注册资源 →（可选）清除全局磁盘缓存，
    // 之后再卸载/更新就不会互相拖累。重新加载窗口即可恢复。
    context.subscriptions.push(
        commands.registerCommand(Commands.cleanupAndDeactivate, async () => {
            if (isCleaningUp) {
                return;
            }

            const clearCacheChoice = 'Cleanup and Deactivate + Purge Cache';
            const answer = await window.showWarningMessage(
                'Viper will stop the language server for this window and dispose all resources it registered ' +
                    '(commands, sidebar views, status bar, file watchers, flow chart panel).\n' +
                    'Viper features in this window will stay disabled until you reload the window.\n' +
                    `"${clearCacheChoice}" additionally deletes the global semantic token cache ` +
                    '(~/.vipeye/cache/semantic-tokens); use it before uninstalling or updating the extension.',
                { modal: true },
                'Cleanup and Deactivate',
                clearCacheChoice
            );

            if (!answer) {
                return;
            }

            isCleaningUp = true;
            try {
                await window.withProgress(
                    { location: ProgressLocation.Notification, title: 'Viper: cleaning up and shutting down...' },
                    async () => {
                        await stopLanguageServer();
                        disposeAllSubscriptions(context);

                        if (answer === clearCacheChoice) {
                            clearSemanticTokenDiskCache();
                        }
                    }
                );
            } finally {
                isCleaningUp = false;
            }

            void window.showInformationMessage(
                'Viper has been cleaned up and temporarily shut down. If other Viper windows are open on this ' +
                    'machine, run the same command there too before uninstalling or updating the extension.'
            );
        })
    );

    // Register the debug only commands when running under the debugger.
    if (context.extensionMode === ExtensionMode.Development) {
        // Create a 'when' context for development.
        commands.executeCommand('setContext', 'viper.development', true);

        // Register the commands that only work when in development mode.
        context.subscriptions.push(
            commands.registerCommand(Commands.dumpTokens, () => {
                const uri = window.activeTextEditor?.document.uri.toString();
                if (uri) {
                    client.sendRequest('workspace/executeCommand', {
                        command: Commands.dumpFileDebugInfo,
                        arguments: [uri, 'tokens'],
                    });
                }
            })
        );

        context.subscriptions.push(
            commands.registerCommand(Commands.dumpNodes, () => {
                const uri = window.activeTextEditor?.document.uri.toString();
                if (uri) {
                    client.sendRequest('workspace/executeCommand', {
                        command: Commands.dumpFileDebugInfo,
                        arguments: [uri, 'nodes'],
                    });
                }
            })
        );

        context.subscriptions.push(
            commands.registerCommand(Commands.dumpTypes, () => {
                const uri = window.activeTextEditor?.document.uri.toString();
                if (uri) {
                    const start = window.activeTextEditor!.selection.start;
                    const end = window.activeTextEditor!.selection.end;
                    const startOffset = window.activeTextEditor!.document.offsetAt(start);
                    const endOffset = window.activeTextEditor!.document.offsetAt(end);
                    client.sendRequest('workspace/executeCommand', {
                        command: Commands.dumpFileDebugInfo,
                        arguments: [uri, 'types', startOffset, endOffset],
                    });
                }
            })
        );
        context.subscriptions.push(
            commands.registerCommand(Commands.dumpCachedTypes, () => {
                const uri = window.activeTextEditor?.document.uri.toString();
                if (uri) {
                    const start = window.activeTextEditor!.selection.start;
                    const end = window.activeTextEditor!.selection.end;
                    const startOffset = window.activeTextEditor!.document.offsetAt(start);
                    const endOffset = window.activeTextEditor!.document.offsetAt(end);
                    client.sendRequest('workspace/executeCommand', {
                        command: Commands.dumpFileDebugInfo,
                        arguments: [uri, 'cachedtypes', startOffset, endOffset],
                    });
                }
            })
        );
        context.subscriptions.push(
            commands.registerCommand(Commands.dumpCodeFlowGraph, () => {
                const uri = window.activeTextEditor?.document.uri.toString();
                if (uri) {
                    const start = window.activeTextEditor!.selection.start;
                    const startOffset = window.activeTextEditor!.document.offsetAt(start);
                    client.sendRequest('workspace/executeCommand', {
                        command: Commands.dumpFileDebugInfo,
                        arguments: [uri, 'codeflowgraph', startOffset],
                    });
                }
            })
        );
    }

    // 「函数跳转图」停靠面板：服务端算 Mermaid（AST → 控制流图），这里只做展示与跳转。
    const flowChartProvider = registerFlowChartView(context, context.extensionUri);
    context.subscriptions.push(
        commands.registerTextEditorCommand(Commands.showFunctionFlowChart, async (editor) => {
            const documentUri = editor.document.uri;
            const offset = editor.document.offsetAt(editor.selection.active);

            try {
                const chart = await client.sendRequest<FlowChartResponse | undefined>('workspace/executeCommand', {
                    command: Commands.showFunctionFlowChart,
                    arguments: [documentUri.toString(), offset],
                });

                if (!chart) {
                    void window.showWarningMessage('Viper：当前光标不在任何函数内，无法生成跳转图。');
                    return;
                }

                await flowChartProvider.showChart(chart, documentUri);
            } catch (err) {
                void window.showErrorMessage(
                    `Viper：生成函数跳转图失败 —— ${err instanceof Error ? err.message : String(err)}`
                );
            }
        })
    );

    await client.start();

    // 导出 Viper 核心 API（合并后随本扩展一起提供）。
    return { viperApi };
}

export function deactivate() {
    if (cancellationStrategy) {
        cancellationStrategy.dispose();
        cancellationStrategy = undefined;
    }

    const client = languageClient;
    languageClient = undefined;

    return client?.stop();
}

/**
 * 停语言服务：先释放文件型取消策略（含其注册的文件与监听器），
 * 再请求客户端 `stop()` 让服务端进程正常退出，最后 `dispose()` 注销客户端
 * 注册的语言特性（语义高亮、悬停、诊断、文件监视等）。
 * 服务端进程退出后，扩展目录不再被其 CWD 占用（Windows 下才能删除）。
 */
async function stopLanguageServer(): Promise<void> {
    if (cancellationStrategy) {
        cancellationStrategy.dispose();
        cancellationStrategy = undefined;
    }

    const client = languageClient;
    languageClient = undefined;
    if (!client) {
        return;
    }

    try {
        await client.stop();
    } finally {
        client.dispose();
    }
}

/**
 * 释放本窗口由本扩展注册的全部资源（命令、侧边栏视图、状态栏、文件监视、
 * 流程图面板、Viper 核心的项目/工具链视图等）。
 * 单个资源释放失败不影响其余清理，故逐个吞掉异常。
 */
function disposeAllSubscriptions(context: ExtensionContext): void {
    while (context.subscriptions.length > 0) {
        const disposable = context.subscriptions.pop();
        try {
            disposable?.dispose();
        } catch {
            // 忽略：清理阶段不允许任何单个资源中断整体关停
        }
    }
}

/**
 * 删除全局语义高亮磁盘缓存目录（与语言服务端共用同一路径定义）。
 * 其它窗口可能正在读写同一目录（Windows 下删除会失败），失败不阻塞关停。
 */
function clearSemanticTokenDiskCache(): void {
    try {
        fs.rmSync(getSemanticTokenCacheDir(), { recursive: true, force: true });
    } catch {
        // 缓存目录被其它实例占用：跳过即可，下次关停或服务端过期清理仍会处理
    }
}

function isConfigSettingSetByUser(configuration: WorkspaceConfiguration, setting: string): boolean {
    const inspect = configuration.inspect(setting);
    if (inspect === undefined) {
        return false;
    }

    return (
        inspect.globalValue !== undefined ||
        inspect.workspaceValue !== undefined ||
        inspect.workspaceFolderValue !== undefined ||
        inspect.globalLanguageValue !== undefined ||
        inspect.workspaceLanguageValue !== undefined ||
        inspect.workspaceFolderLanguageValue !== undefined
    );
}
