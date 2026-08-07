/*
 * extension.ts
 * Viper Core 扩展入口。
 */

import { commands, ExtensionContext, window, workspace } from 'vscode';
import { ProjectManager } from './projectManager';
import { ToolchainManager } from './toolchainManager';
import { ViperViewProvider } from './viperViewProvider';
import { StatusBarManager } from './statusBar';
import { ViperApiImpl } from './api';
import { VpjEditorProvider } from './vpjEditorProvider';

export async function activate(context: ExtensionContext): Promise<ViperApiImpl> {
    const projects = new ProjectManager();
    const toolchain = new ToolchainManager();

    // 初始扫描项目文件。
    await projects.DiscoverProjects();

    // 监听 .vpj 变更。
    const watcher = projects.WatchProjectFiles();
    context.subscriptions.push(watcher);

    // 注册三个树视图。
    const projectView = new ViperViewProvider('viper.projectView', projects, toolchain);
    const toolchainView = new ViperViewProvider('viper.toolchainView', projects, toolchain);
    const settingsView = new ViperViewProvider('viper.settingsView', projects, toolchain);

    context.subscriptions.push(
        window.registerTreeDataProvider('viper.projectView', projectView),
        window.registerTreeDataProvider('viper.toolchainView', toolchainView),
        window.registerTreeDataProvider('viper.settingsView', settingsView)
    );

    // 状态栏。
    context.subscriptions.push(new StatusBarManager(toolchain));

    // 注册 .vpj 自定义编辑器。
    context.subscriptions.push(VpjEditorProvider.Register(context));

    // 项目/工具链变更时刷新视图。
    context.subscriptions.push(
        projects.OnDidChangeProject(() => {
            projectView.Refresh();
            toolchainView.Refresh();
        }),
        toolchain.OnDidChangeToolchain(() => {
            toolchainView.Refresh();
        })
    );

    // 命令。
    context.subscriptions.push(
        RegisterCommandSafe(context, 'viper.createProject', async () => {
            await CreateProjectCommand();
            await projects.DiscoverProjects();
            projectView.Refresh();
        }),
        RegisterCommandSafe(context, 'viper.selectToolchain', async () => {
            await toolchain.SelectToolchain();
        }),
        RegisterCommandSafe(context, 'viper.showProjectInfo', () => {
            ShowProjectInfoCommand(projects);
        }),
        RegisterCommandSafe(context, 'viper.openSettings', () => {
            commands.executeCommand('workbench.action.openSettings', '@ext:TermiNexus.vipeye');
        }),
        RegisterCommandSafe(context, 'viper.refreshView', async () => {
            await projects.DiscoverProjects();
            toolchain.Refresh();
            projectView.Refresh();
            toolchainView.Refresh();
            settingsView.Refresh();
        }),
        RegisterCommandSafe(context, 'viper.openVpjAsJson', async (uri?: import('vscode').Uri) => {
            const target = uri ?? window.activeTextEditor?.document.uri;
            if (!target) {
                window.showWarningMessage('No .vpj file selected.');
                return;
            }
            // 用默认文本编辑器打开，绕过自定义 webview 编辑器。
            await window.showTextDocument(target, { preview: false });
        })
    );

    // 监听配置变更，刷新工具链。
    context.subscriptions.push(
        workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('viper.toolchain')) {
                toolchain.Refresh();
            }
        })
    );

    // 导出 API。
    const api = new ViperApiImpl(projects, toolchain);
    return api;
}

export function deactivate(): void {
    // 清理由 context.subscriptions 自动处理。
}

/** 安全注册命令：vscode-vipeye 单一合并了核心代码，若与独立的 viper 核心扩展
 *  同时激活，命令可能已被先注册的扩展注册（command 'xxx' already exists）。
 *  此处捕获重复注册错误并跳过，避免整个扩展激活失败；命令由先注册方提供。 */
function RegisterCommandSafe(
    context: ExtensionContext,
    commandId: string,
    handler: (...args: any[]) => any
): import('vscode').Disposable {
    try {
        return commands.registerCommand(commandId, handler);
    } catch (e) {
        console.warn(`[viper] command '${commandId}' already registered by another extension, skipping.`);
        return { dispose() {} };
    }
}

/** 创建项目命令：在当前 workspace 根目录生成 .vpj 模板。 */
async function CreateProjectCommand(): Promise<void> {
    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
        window.showWarningMessage('Open a folder first to create a Viper project.');
        return;
    }

    const folder = workspace.workspaceFolders[0];
    const name = await window.showInputBox({
        prompt: 'Project name',
        placeHolder: 'MyViperApp',
        value: 'MyViperApp',
    });
    if (!name) {
        return;
    }

    const template = {
        $schema: 'https://raw.githubusercontent.com/TermiNexus/TransPyC/main/schemas/project-schema.json',
        name,
        version: '1.0.0',
        source_dir: './App',
        build_dir: './.tpv_build',
        compiler: {
            cmd: 'llc',
            flags: ['-filetype=obj', '-relocation-model=pic'],
        },
        linker: {
            cmd: 'clang++',
            flags: ['-lmsvcrt', '-lucrt', '-lpthread', '-lmingwex', '-lkernel32', '-Wl,--allow-multiple-definition'],
            output: 'app.exe',
        },
        includes: [],
        target: {
            triple: 'x86_64-pc-windows-gnu',
            datalayout:
                'e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128',
        },
        options: {
            slice_level: 3,
            sha1_slice_level: 1,
            target: 'llvm',
            strict_mode: true,
        },
    };

    const uri = folder.uri.with({ path: `${folder.uri.path}/project.vpj` });
    const content = JSON.stringify(template, null, 4);
    await workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    window.showInformationMessage(`Created ${uri.fsPath}`);
}

/** 显示当前项目信息。 */
function ShowProjectInfoCommand(projects: ProjectManager): void {
    const project = projects.GetProject();
    if (!project) {
        window.showWarningMessage('No Viper project loaded.');
        return;
    }
    const lines = [
        `Name: ${project.Name}`,
        `Version: ${project.Version}`,
        `Project File: ${project.ProjectFile}`,
        `Source Dir: ${project.SourceDir}`,
        `Build Dir: ${project.BuildDir}`,
        `Target Triple: ${project.Target.Triple}`,
        `Includes: ${project.Includes.join('; ') || '(none)'}`,
        `Compiler: ${project.Compiler.Cmd} ${project.Compiler.Flags.join(' ')}`,
        `Linker: ${project.Linker.Cmd} → ${project.Linker.Output}`,
        `Options: slice=${project.Options.SliceLevel}, sha1_slice=${project.Options.Sha1SliceLevel}, target=${project.Options.Target}, strict=${project.Options.StrictMode}`,
    ];
    const channel = window.createOutputChannel('Viper');
    channel.clear();
    channel.appendLine(lines.join('\n'));
    channel.show();
}
