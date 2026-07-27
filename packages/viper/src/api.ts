/*
 * api.ts
 * 导出给其他扩展（如 vscode-viper-lsp）使用的 ViperApi 实现。
 */

import * as path from 'path';
import { Event } from 'vscode';
import { ProjectManager } from './projectManager';
import { ToolchainManager } from './toolchainManager';
import { ToolchainInfo, ViperApi, ViperProject } from './types';

export class ViperApiImpl implements ViperApi {
    constructor(
        private readonly projects: ProjectManager,
        private readonly toolchain: ToolchainManager
    ) {}

    GetProject(workspaceFolder?: string): ViperProject | undefined {
        return this.projects.GetProject(workspaceFolder);
    }

    GetViperSearchPaths(workspaceFolder?: string): string[] {
        const project = this.projects.GetProject(workspaceFolder);
        if (!project) {
            return [];
        }
        const paths: string[] = [project.SourceDir];
        paths.push(...project.Includes);
        // stdlib 路径：工具链同目录下的 stdlib/（占位，后续由 toolchain 发现）
        const tool = this.toolchain.GetToolchain();
        const stdlib = path.join(path.dirname(tool.Path), 'stdlib');
        paths.push(stdlib);
        return paths;
    }

    GetToolchain(): ToolchainInfo {
        return this.toolchain.GetToolchain();
    }

    GetTargetTriple(workspaceFolder?: string): string | undefined {
        return this.projects.GetProject(workspaceFolder)?.Target.Triple;
    }

    get OnDidChangeProject(): Event<ViperProject | undefined> {
        return this.projects.OnDidChangeProject;
    }

    get OnDidChangeToolchain(): Event<ToolchainInfo> {
        return this.toolchain.OnDidChangeToolchain;
    }
}
