/*
 * viperViewProvider.ts
 * 左侧活动栏各视图的 TreeDataProvider 实现。
 */

import { Event, EventEmitter, ProviderResult, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { EnvironmentManager } from './environmentManager';
import { EnvironmentTool } from './environmentTool';
import { ProjectManager } from './projectManager';
import { ToolchainManager } from './toolchainManager';
import { ViperEnvironment, ViperTreeNode } from './types';

/** 通用树视图提供者，按视图 ID 返回不同节点集。 */
export class ViperViewProvider implements TreeDataProvider<ViperTreeNode> {
    private readonly _onDidChangeTreeData = new EventEmitter<ViperTreeNode | undefined>();
    readonly onDidChangeTreeData: Event<ViperTreeNode | undefined> = this._onDidChangeTreeData.event;

    constructor(
        private readonly viewId: string,
        private readonly projects: ProjectManager,
        private readonly toolchain: ToolchainManager,
        private readonly environments: EnvironmentManager,
        private readonly tool: EnvironmentTool
    ) {}

    Refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ViperTreeNode): TreeItem {
        const item = new TreeItem(element.Label, this.ToCollapsibleState(element.Children));
        item.description = element.Description;
        item.tooltip = element.Tooltip;
        if (element.Icon) {
            item.iconPath = element.Icon;
        }
        if (element.Command) {
            item.command = { command: element.Command, title: element.Label, arguments: element.CommandArguments };
        }
        if (element.ContextValue) {
            item.contextValue = element.ContextValue;
        }
        return item;
    }

    getChildren(element?: ViperTreeNode): ProviderResult<ViperTreeNode[]> {
        if (element) {
            return Promise.resolve(element.Children ?? []);
        }
        return Promise.resolve(this.BuildRootNodes());
    }

    private BuildRootNodes(): ViperTreeNode[] {
        switch (this.viewId) {
            case 'viper.projectView':
                return this.BuildProjectNodes();
            case 'viper.toolchainView':
                return this.BuildToolchainNodes();
            case 'viper.settingsView':
                return this.BuildSettingsNodes();
            case 'viper.environmentView':
                return this.BuildEnvironmentNodes();
            default:
                return [];
        }
    }

    private BuildProjectNodes(): ViperTreeNode[] {
        const all = this.projects.GetAllProjects();
        if (all.length === 0) {
            return [
                {
                    Label: 'No project found',
                    Description: 'Click to create',
                    Command: 'viper.createProject',
                    Icon: '$(warning)',
                },
            ];
        }

        return all.map((project) => ({
            Label: project.Name,
            Description: project.Version,
            Tooltip: project.ProjectFile,
            Icon: '$(package)',
            ContextValue: 'viperProject',
            Children: [
                {
                    Label: 'Source Directory',
                    Description: project.SourceDir,
                    Icon: '$(folder)',
                },
                {
                    Label: 'Build Directory',
                    Description: project.BuildDir,
                    Icon: '$(folder)',
                },
                {
                    Label: 'Target Triple',
                    Description: project.Target.Triple,
                    Icon: '$(server)',
                },
                {
                    Label: 'Compiler',
                    Description: `${project.Compiler.Cmd} ${project.Compiler.Flags.join(' ')}`,
                    Icon: '$(tools)',
                },
                {
                    Label: 'Linker',
                    Description: `${project.Linker.Cmd} → ${project.Linker.Output}`,
                    Icon: '$(link)',
                },
                {
                    Label: 'Includes',
                    Description: `${project.Includes.length} path(s)`,
                    Icon: '$(symbol-folder)',
                    Children: project.Includes.map((p) => ({
                        Label: p,
                        Icon: '$(folder)',
                    })),
                },
            ],
        }));
    }

    private BuildToolchainNodes(): ViperTreeNode[] {
        const tool = this.toolchain.GetToolchain();
        return [
            {
                Label: tool.Path,
                Description: tool.Version,
                Tooltip: `Source: ${tool.Source}`,
                Icon: '$(tools)',
                Command: 'viper.selectToolchain',
                ContextValue: 'viperToolchain',
            },
            {
                Label: 'Version',
                Description: tool.Version,
                Icon: '$(tag)',
            },
            {
                Label: 'Source',
                Description: tool.Source,
                Icon: '$(info)',
            },
        ];
    }

    private BuildSettingsNodes(): ViperTreeNode[] {
        return [
            {
                Label: 'Open Settings',
                Description: 'Viper configuration',
                Icon: '$(settings-gear)',
                Command: 'viper.openSettings',
            },
            {
                Label: 'Show Project Info',
                Description: 'Display active .vpj details',
                Icon: '$(info)',
                Command: 'viper.showProjectInfo',
            },
            {
                Label: 'Refresh',
                Description: 'Reload project & toolchain',
                Icon: '$(refresh)',
                Command: 'viper.refreshView',
            },
        ];
    }

    /** 环境视图：按 VET 给出的 source 分组（workspace / global / ...）。 */
    private BuildEnvironmentNodes(): ViperTreeNode[] {
        const all = this.environments.GetEnvironments();
        const selectedId = this.environments.GetSelectedId();

        if (all.length === 0) {
            // 手动关闭 VET 时不能显示"扫描中…"（那是误导），改为明确告知并引导重新启动。
            const stopped = this.tool.GetState() === 'stopped';
            return [
                {
                    Label: stopped ? 'VET 已关闭' : '未发现 Viper 编译器',
                    Description: stopped ? '点击重新启动' : 'VET 扫描中…',
                    Tooltip: stopped ? 'VET 已被手动停止，点击重新启动扫描' : '点击可重启 VET 扫描',
                    Icon: stopped ? '$(debug-stop)' : '$(sync~spin)',
                    Command: 'viper.restartEnvironmentTool',
                },
            ];
        }

        const groups = new Map<string, ViperEnvironment[]>();
        for (const environment of all) {
            const source = environment.Source || 'unknown';
            const bucket = groups.get(source);
            if (bucket) {
                bucket.push(environment);
            } else {
                groups.set(source, [environment]);
            }
        }

        const nodes: ViperTreeNode[] = [];
        for (const [source, environments] of groups) {
            nodes.push({
                Label: source,
                Description: `${environments.length}`,
                Tooltip: `${environments.length} 个环境（来源：${source}）`,
                Icon: '$(folder)',
                Children: environments.map((environment) => this.ConvertEnvironmentToNode(environment, selectedId)),
            });
        }

        return nodes;
    }

    private ConvertEnvironmentToNode(environment: ViperEnvironment, selectedId: string | undefined): ViperTreeNode {
        const isSelected = environment.Id === selectedId;
        return {
            Label: environment.DisplayName,
            Description: `${environment.Version} · ${environment.Arch}${isSelected ? ' · 已选中' : ''}`,
            Tooltip: `${environment.Executable}\n来源: ${environment.Source}\nID: ${environment.Id}`,
            Icon: isSelected ? '$(check)' : '$(server-process)',
            Command: 'viper.selectEnvironment',
            CommandArguments: [environment.Id],
        };
    }

    private ToCollapsibleState(children?: ViperTreeNode[]): TreeItemCollapsibleState {
        return children && children.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None;
    }
}
