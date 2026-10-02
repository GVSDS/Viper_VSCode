/*
 * extension.ts
 * Viper Core 扩展入口。
 */

import * as path from 'path';
import { commands, ExtensionContext, OutputChannel, ProgressLocation, Uri, window, workspace } from 'vscode';
import { EnvironmentManager } from './environmentManager';
import { EnvironmentTool } from './environmentTool';
import { CountProjectLoc, FormatLocReport, LocReport } from './lineCounter';
import { LocReportView } from './locReportView';
import { ProjectManager } from './projectManager';
import { ToolchainManager } from './toolchainManager';
import { ViperCheckResult, ViperEnvironment } from './types';
import { ViperViewProvider } from './viperViewProvider';
import { EnvironmentStatusBar } from './statusBar';
import { ViperApiImpl } from './api';
import { VpjEditorProvider } from './vpjEditorProvider';

export async function activate(context: ExtensionContext): Promise<ViperApiImpl> {
    const projects = new ProjectManager();
    const toolchain = new ToolchainManager();

    // VET（Viper Environment Tool）常驻进程：扫盘发现编译器，每轮输出全量 JSON 快照。
    // stdout 与 stderr 都原样转发到该输出通道（不落盘）。
    const vetChannel = window.createOutputChannel('Vipeye VET');
    const environmentTool = new EnvironmentTool(context.globalStorageUri.fsPath, vetChannel);
    const environments = new EnvironmentManager(context.globalState);

    // LOC 统计输出通道（右键 .vpj → 统计该工程源目录下所有已知语言的行数）。
    const locChannel = window.createOutputChannel('Viper LOC');
    context.subscriptions.push(locChannel);

    // 初始扫描项目文件。
    await projects.DiscoverProjects();

    // 监听 .vpj 变更。
    const watcher = projects.WatchProjectFiles();
    context.subscriptions.push(watcher);

    // 注册四个树视图。
    const projectView = new ViperViewProvider('viper.projectView', projects, toolchain, environments, environmentTool);
    const toolchainView = new ViperViewProvider('viper.toolchainView', projects, toolchain, environments, environmentTool);
    const settingsView = new ViperViewProvider('viper.settingsView', projects, toolchain, environments, environmentTool);
    const environmentView = new ViperViewProvider('viper.environmentView', projects, toolchain, environments, environmentTool);

    context.subscriptions.push(
        window.registerTreeDataProvider('viper.projectView', projectView),
        window.registerTreeDataProvider('viper.toolchainView', toolchainView),
        window.registerTreeDataProvider('viper.settingsView', settingsView),
        window.registerTreeDataProvider('viper.environmentView', environmentView)
    );

    // 状态栏：只保留 VET 环境项（编译器位置完全由发现结果决定）。
    context.subscriptions.push(new EnvironmentStatusBar(environments, environmentTool));

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

    // VET 快照 → 环境清单（自己 diff；VET 每轮都给全量）。
    context.subscriptions.push(
        environmentTool.OnDidChangeEnvironments((snapshot) => {
            const change = environments.ApplySnapshot(snapshot);

            const summary = [`本轮: 共 ${change.Environments.length} 个`];
            if (change.Added.length > 0) {
                summary.push(`+${change.Added.length}`);
            }
            if (change.Removed.length > 0) {
                summary.push(`-${change.Removed.length}`);
            }
            environmentTool.AppendLog(`[vscode] ${summary.join(' ')}`);

            // 生效环境同步给工具链：有环境就用它（上次用的那个 → 否则发现的第一个），
            // 一个都没发现时回退到配置/硬编码的兜底路径。
            const selected = environments.GetSelectedEnvironment();
            if (selected) {
                toolchain.ApplyEnvironment(selected.Executable, selected.Version);
            } else {
                toolchain.ClearEnvironmentOverride();
            }
        }),
        environments.OnDidChangeEnvironments(() => environmentView.Refresh()),
        // 进程状态变化（含手动停止）会影响 Environments 视图的空态文案与状态栏。
        environmentTool.OnDidChangeState(() => environmentView.Refresh()),
        environments.OnDidChangeSelection((selected) => {
            if (selected) {
                toolchain.ApplyEnvironment(selected.Executable, selected.Version);
            } else {
                toolchain.ClearEnvironmentOverride();
            }
            environmentView.Refresh();
        })
    );

    // 选择列表里的「选择编译器…」：手动输入路径 → VET check → 并入环境清单并切过去。
    environments.SetManualCompilerPicker(() => PickManualCompiler(environmentTool, environments));

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
            environmentView.Refresh();
        }),
        RegisterCommandSafe(context, 'viper.selectEnvironment', async (environmentId?: unknown) => {
            await environments.SelectEnvironment(typeof environmentId === 'string' ? environmentId : undefined);
        }),
        RegisterCommandSafe(context, 'viper.restartEnvironmentTool', () => {
            environmentTool.Restart();
        }),
        RegisterCommandSafe(context, 'viper.stopEnvironmentTool', () => {
            environmentTool.Stop();
        }),
        RegisterCommandSafe(context, 'viper.showEnvironmentLog', () => {
            environmentTool.ShowLog();
        }),
        RegisterCommandSafe(context, 'viper.checkEnvironment', async () => {
            await CheckEnvironmentCommand(environmentTool);
        }),
        RegisterCommandSafe(context, 'viper.openVpjAsJson', async (uri?: import('vscode').Uri) => {
            const target = uri ?? window.activeTextEditor?.document.uri;
            if (!target) {
                window.showWarningMessage('No .vpj file selected.');
                return;
            }
            // 用默认文本编辑器打开，绕过自定义 webview 编辑器。
            await window.showTextDocument(target, { preview: false });
        }),
        RegisterCommandSafe(context, 'viper.countLines', async (uri?: unknown) => {
            await CountProjectLocCommand(context, projects, locChannel, IsUri(uri) ? uri : undefined);
        })
    );

    // 监听配置变更，刷新工具链 / 重启 VET。
    context.subscriptions.push(
        workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('viper.toolchain')) {
                toolchain.Refresh();
            }
            if (e.affectsConfiguration('viper.environmentTool')) {
                environmentTool.Restart();
            }
        })
    );

    // 生命周期：随扩展一起释放（dispose 会停掉 VET 进程并关闭日志流）。
    context.subscriptions.push(environmentTool, environments);

    // 启动 VET 扫盘发现。
    environmentTool.Start();

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

/**
 * 弹文件选择框挑一个 exe，并做 Viper 编译器校验。
 * 校验优先走 VET 的 check 通道；VET 未启用/未运行时由扩展本地模拟（读 PE + `--version`，均带超时）。
 * 返回回执；用户取消时返回 undefined（校验失败会在这里给出错误提示）。
 */
async function PickAndCheckExecutable(tool: EnvironmentTool): Promise<ViperCheckResult | undefined> {
    const picked = await window.showOpenDialog({
        title: '选择 Viper 编译器',
        canSelectMany: false,
        openLabel: '选择',
        filters: { 'Viper 可执行文件': ['exe'] },
    });
    const exePath = picked?.[0]?.fsPath;
    if (!exePath) {
        return undefined;
    }

    return window.withProgress(
        { location: ProgressLocation.Notification, title: `正在检查 ${path.basename(exePath)}…` },
        async () => {
            try {
                return await tool.CheckExecutable(exePath);
            } catch (e) {
                void window.showErrorMessage(`检查失败：${e instanceof Error ? e.message : String(e)}`);
                return undefined;
            }
        }
    );
}

/**
 * 「选择编译器…」：选一个 exe，校验通过后并入环境清单并立刻切换过去
 * （走 VET check 时 VET 会把该 exe 入库，后续轮次快照里也会带着它）。
 */
async function PickManualCompiler(
    tool: EnvironmentTool,
    environments: EnvironmentManager
): Promise<ViperEnvironment | undefined> {
    const result = await PickAndCheckExecutable(tool);
    if (!result) {
        return undefined;
    }

    const environment = result.Environment;
    if (result.Ok && environment) {
        environments.AddEnvironment(environment);
        const selected = await environments.SelectEnvironment(environment.Id);
        void window.showInformationMessage(`已切换到 ${environment.DisplayName}（${environment.Arch}）`);
        return selected;
    }

    void window.showErrorMessage(`检查未通过：${DescribeCheckMessage(result.Message)}`);
    return undefined;
}

/** 挑一个 exe 做检查（只检查、不切换），结果通过信息消息回报。 */
async function CheckEnvironmentCommand(tool: EnvironmentTool): Promise<void> {
    const result = await PickAndCheckExecutable(tool);
    if (!result) {
        return;
    }

    const environment = result.Environment;
    if (result.Ok && environment) {
        void window
            .showInformationMessage(
                `检查通过：${environment.DisplayName}（${environment.Arch}）`,
                '选择为当前环境',
                '显示详情'
            )
            .then((choice) => {
                if (choice === '选择为当前环境') {
                    void commands.executeCommand('viper.selectEnvironment', environment.Id);
                } else if (choice === '显示详情') {
                    void window.showInformationMessage(environment.Executable, { modal: true });
                }
            });
        return;
    }

    void window.showErrorMessage(`检查未通过：${DescribeCheckMessage(result.Message)}`);
}

/** 把校验回执里的原因串（VET 的 check_msg / 本地模拟的同名原因串）翻译成可读说明。 */
function DescribeCheckMessage(message: string | undefined): string {
    if (!message) {
        return '未知原因（未给出原因串）';
    }
    switch (message) {
        case 'NOT_FOUND':
            return '文件不存在';
        case 'NO_PERMISSION':
            return '无法打开该文件（权限不足或被占用）';
        case 'NOT_EXE':
            return '不是有效的 PE 可执行文件';
        case 'NO_PRVERSN':
            return '缺少 .PRVERSN 段（不是 TransPyV 工具链产物）';
        case 'PRVERSN_ERR':
            return '.PRVERSN 段定位或读取失败';
        case 'PREFIX_ERR':
            return '--version 输出不以 Viper 开头';
        case 'TIMEOUT':
            return '--version 探测超时';
        case 'CHANNEL_UNAVAILABLE':
            return 'VET 的 check 通道不可用（内部缓冲未就绪）';
        default:
            // EXE_ERR,0x<HEX>：拉起失败，错误码原样带上
            return message.startsWith('EXE_ERR,')
                ? `无法启动该 exe（错误码 ${message.slice('EXE_ERR,'.length)}）`
                : message;
    }
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

/** 判断命令参数是否为 Uri（右键菜单传入的第一个参数）。 */
function IsUri(value: unknown): value is Uri {
    return !!value && typeof value === 'object' && typeof (value as Uri).fsPath === 'string';
}

/** 取本命令要统计的工程文件：右键传入的 .vpj → 当前活动编辑器（是 .vpj 时）。 */
function ResolveProjectFile(uri?: Uri): Uri | undefined {
    const isProjectFile = (candidate: Uri | undefined): boolean =>
        !!candidate && path.extname(candidate.fsPath).toLowerCase() === '.vpj';

    if (isProjectFile(uri)) {
        return uri;
    }
    const activeUri = window.activeTextEditor?.document.uri;
    return isProjectFile(activeUri) ? activeUri : undefined;
}

/**
 * 「统计项目 LOC」：右键 .vpj → 统计该工程源目录（source_dir，通常为 App）下
 * 所有已知语言（.vp/.vpi/.vpnci/.vpj/.def）的文件数与行数，
 * 结果在 Webview 面板里以进度条 + 图表 + 明细表展示（另存一份纯文本到输出通道）。
 * 未传文件参数（命令面板）时退回当前工作区已加载的工程。
 */
async function CountProjectLocCommand(
    context: ExtensionContext,
    projects: ProjectManager,
    channel: OutputChannel,
    uri?: Uri
): Promise<void> {
    const projectFile = ResolveProjectFile(uri);
    // 右键的 .vpj 可能不是 DiscoverProjects 留下（每个工作区只保留最后一个）的那个，
    // 故按点击的文件重新解析，保证统计的就是被点中的工程。
    const project = projectFile ? projects.LoadProject(projectFile) : projects.GetProject();
    if (!project) {
        void window.showWarningMessage('未找到 Viper 工程：请对 .vpj 文件使用本命令。');
        return;
    }

    const view = LocReportView.Show(context);
    view.StartRun(project.Name, project.ProjectFile, project.SourceDir);

    let report: LocReport;
    try {
        report = await CountProjectLoc(project.SourceDir, [project.BuildDir], (progress) => {
            view.ReportProgress(progress);
        });
    } catch (error) {
        view.ReportError(`统计失败：${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    // 纯文本一份留档（便于复制），主力展示在 Webview。
    channel.clear();
    channel.appendLine(FormatLocReport(report, project.Name, project.ProjectFile));

    view.ReportResult({ ...report, ProjectName: project.Name, ProjectFile: project.ProjectFile });

    if (report.Total.FileCount > 0) {
        void window.showInformationMessage(
            `LOC：${report.Total.CodeLines} 行代码 / ${report.Total.TotalLines} 行（${report.Total.FileCount} 个文件，注释率 ${(report.Total.CommentRate * 100).toFixed(1)}%）`
        );
    }
}
