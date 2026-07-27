/*
 * projectManager.ts
 * 负责发现、解析、监听 .vpj 项目配置文件。
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter, Event, Uri, workspace, WorkspaceFolder } from 'vscode';
import { ViperProject } from './types';

export class ProjectManager {
    private projects = new Map<string, ViperProject>();
    private readonly _onDidChange = new EventEmitter<ViperProject | undefined>();
    readonly OnDidChangeProject: Event<ViperProject | undefined> = this._onDidChange.event;

    /** 扫描 workspace 下所有 .vpj 文件。 */
    async DiscoverProjects(): Promise<void> {
        this.projects.clear();
        const uris = await workspace.findFiles('**/*.vpj', '**/node_modules/**', 50);
        for (const uri of uris) {
            this.LoadProject(uri);
        }
        this._onDidChange.fire(this.GetProject());
    }

    /** 解析并加载单个 .vpj 文件。 */
    LoadProject(uri: Uri): ViperProject | undefined {
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const raw = JSON.parse(content);
            const projectRoot = path.dirname(uri.fsPath);

            const project: ViperProject = {
                Name: raw.name ?? 'unnamed',
                Version: raw.version ?? '0.0.0',
                SourceDir: path.resolve(projectRoot, raw.source_dir ?? '.'),
                BuildDir: path.resolve(projectRoot, raw.build_dir ?? './.tpv_build'),
                Includes: (raw.includes ?? []).map((p: string) => path.resolve(projectRoot, p)),
                Compiler: {
                    Cmd: raw.compiler?.cmd ?? 'llc',
                    Flags: raw.compiler?.flags ?? [],
                },
                Linker: {
                    Cmd: raw.linker?.cmd ?? 'clang++',
                    Flags: raw.linker?.flags ?? [],
                    Output: raw.linker?.output ?? 'app.exe',
                },
                Target: {
                    Triple: raw.target?.triple ?? 'x86_64-pc-windows-gnu',
                    DataLayout: raw.target?.datalayout ?? '',
                },
                Options: {
                    SliceLevel: raw.options?.slice_level ?? 3,
                    Sha1SliceLevel: raw.options?.sha1_slice_level ?? 1,
                    Target: raw.options?.target ?? 'llvm',
                    StrictMode: raw.options?.strict_mode ?? false,
                },
                ProjectRoot: projectRoot,
                ProjectFile: uri.fsPath,
            };

            const key = this.GetWorkspaceKey(uri);
            this.projects.set(key, project);
            this._onDidChange.fire(project);
            return project;
        } catch (err) {
            console.error(`[Viper] Failed to parse project file: ${uri.fsPath}`, err);
            return undefined;
        }
    }

    /** 获取指定 workspace 的项目（默认第一个）。 */
    GetProject(workspaceFolder?: WorkspaceFolder | string): ViperProject | undefined {
        if (workspaceFolder) {
            const key = typeof workspaceFolder === 'string' ? workspaceFolder : workspaceFolder.uri.fsPath;
            return this.projects.get(key);
        }
        if (this.projects.size === 0) {
            return undefined;
        }
        return this.projects.values().next().value;
    }

    /** 获取所有已加载项目。 */
    GetAllProjects(): ViperProject[] {
        return Array.from(this.projects.values());
    }

    /** 重新加载指定 .vpj 文件。 */
    ReloadProject(uri: Uri): void {
        this.LoadProject(uri);
    }

    /** 移除项目。 */
    RemoveProject(uri: Uri): void {
        const key = this.GetWorkspaceKey(uri);
        if (this.projects.delete(key)) {
            this._onDidChange.fire(this.GetProject());
        }
    }

    /** 监听 .vpj 文件变更。 */
    WatchProjectFiles(): { dispose: () => void } {
        const watcher = workspace.createFileSystemWatcher('**/*.vpj');
        const changeSub = watcher.onDidChange((uri) => this.ReloadProject(uri));
        const createSub = watcher.onDidCreate((uri) => this.LoadProject(uri));
        const deleteSub = watcher.onDidDelete((uri) => this.RemoveProject(uri));
        return {
            dispose: () => {
                changeSub.dispose();
                createSub.dispose();
                deleteSub.dispose();
                watcher.dispose();
            },
        };
    }

    private GetWorkspaceKey(uri: Uri): string {
        const folder = workspace.getWorkspaceFolder(uri);
        return folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
    }
}
