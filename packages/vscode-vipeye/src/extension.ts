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

import * as path from 'path';
import {
    commands,
    ExtensionContext,
    ExtensionMode,
    extensions,
    Position,
    Range,
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

// Viper 核心（packages/viper）——侧边栏活动栏（Project/Toolchain/Settings）、
// .vpj 项目管理与工具链。源码单一，本包直接引用，构建时一并打包。
import { activate as activateViperCore } from '../../viper/src/extension';

import { FileBasedCancellationStrategy } from './cancellationUtils';

let cancellationStrategy: FileBasedCancellationStrategy | undefined;

let languageClient: LanguageClient | undefined;

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
