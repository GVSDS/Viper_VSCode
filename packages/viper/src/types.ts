/*
 * types.ts
 * Viper Core 类型定义。
 */

import { Event } from 'vscode';

/** .vpj 解析后的项目配置。 */
export interface ViperProject {
    Name: string;
    Version: string;
    SourceDir: string;       // 绝对路径
    BuildDir: string;        // 绝对路径
    Includes: string[];      // 绝对路径
    Compiler: { Cmd: string; Flags: string[] };
    Linker: { Cmd: string; Flags: string[]; Output: string };
    Target: { Triple: string; DataLayout: string };
    Options: {
        SliceLevel: number;
        Sha1SliceLevel: number;
        Target: string;
        StrictMode: boolean;
    };
    ProjectRoot: string;     // .vpj 所在目录（绝对路径）
    ProjectFile: string;     // .vpj 绝对路径
}

/** 工具链信息。 */
export interface ToolchainInfo {
    Path: string;            // 编译器可执行文件路径
    Version: string;         // 版本字符串
    Source: 'hardcoded' | 'config' | 'env' | 'path';
}

/** 暴露给其他扩展的 API。 */
export interface ViperApi {
    /** 获取当前工作区的项目配置。 */
    GetProject(workspaceFolder?: string): ViperProject | undefined;

    /** 获取 Viper 搜索路径（stdlib + includes + sourceDir）。 */
    GetViperSearchPaths(workspaceFolder?: string): string[];

    /** 获取当前工具链。 */
    GetToolchain(): ToolchainInfo;

    /** 获取 target triple。 */
    GetTargetTriple(workspaceFolder?: string): string | undefined;

    /** 项目配置变更事件。 */
    OnDidChangeProject: Event<ViperProject | undefined>;

    /** 工具链变更事件。 */
    OnDidChangeToolchain: Event<ToolchainInfo>;
}

/** 树视图节点。 */
export interface ViperTreeNode {
    Label: string;
    Description?: string;
    Tooltip?: string;
    Icon?: string;
    Children?: ViperTreeNode[];
    Command?: string;
    ContextValue?: string;
}
