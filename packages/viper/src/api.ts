/*
 * api.ts
 * 导出给其他扩展（如 vscode-viper-lsp）使用的 ViperApi 实现。
 */

import * as fs from 'fs';
import * as path from 'path';
import { Event } from 'vscode';
import { ProjectManager } from './projectManager';
import { ToolchainManager } from './toolchainManager';
import { ToolchainInfo, ViperApi, ViperProject } from './types';

/** 自动 include 查找：每一层尝试的目录名（对齐 TransPyV 的 `./includes` 与 `../include` 两种约定）。 */
const CompilerIncludeDirNames = ['includes', 'include'];

/** 自动 include 查找：从编译器 exe 所在目录向上最多再找几层。 */
const CompilerIncludeMaxUpLevels = 4;

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

    GetCompilerIncludePaths(): string[] {
        return FindCompilerIncludePaths(this.toolchain.GetToolchain().Path);
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

/**
 * 自动发现编译器自带的 includes 目录（工程未在 .vpj / project.json 声明 includes 时的兜底）。
 *
 * 基准是**当前选中编译器的 exe 所在目录**（不是被分析的 .vp 所在目录）：
 * 从 exe 所在目录起，向上最多再找 {@link CompilerIncludeMaxUpLevels} 层，每层只看**直接子目录**
 * `includes` / `include`（不递归），返回其中真实存在的目录（绝对路径）。
 * 例：`TransPyC/exe/TransPyV.exe` → 命中 `TransPyC/includes`（对齐 project.vpj 里的 `"../includes"`）。
 *
 * 只认绝对路径：相对路径（如默认占位 `C:\v.exe` 之外的相对写法）会以扩展宿主 CWD 为基准，
 * 可能误命中无关目录，故直接放弃。目录不存在时静默跳过（非 Viper 工具链下整体为空操作）。
 */
function FindCompilerIncludePaths(exePath: string): string[] {
    const found: string[] = [];
    if (!exePath || !path.isAbsolute(exePath)) {
        return found;
    }

    const seen = new Set<string>();
    let dir = path.dirname(exePath);
    for (let level = 0; level <= CompilerIncludeMaxUpLevels; level++) {
        for (const name of CompilerIncludeDirNames) {
            const candidate = path.join(dir, name);
            const key = candidate.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            if (IsDirectory(candidate)) {
                found.push(candidate);
            }
        }

        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    return found;
}

/** 目录存在且确实是目录；不存在 / 无权限 / 是文件时返回 false。 */
function IsDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}
