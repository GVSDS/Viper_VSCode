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

/** VET（Viper Environment Tool）发现的一个编译器条目。字段名与 VET 的 stdout JSON 一致。 */
export interface ViperEnvironment {
    Id: string;              // VET 分配的稳定 id（GUID）
    Executable: string;      // 编译器可执行文件绝对路径
    Version: string;         // 版本字符串（来自 .PRVERSN 段与 --version 前缀）
    Arch: string;            // 架构，如 x86_64
    Source: string;          // 来源分类，如 workspace / global / ...
    DisplayName: string;     // 展示名，如「Viper 0.0.3-dev.428」
}

/** VET check 通道的单次检查回执。 */
export interface ViperCheckResult {
    /** 检查是否通过（回执的 check_result）。 */
    Ok: boolean;
    /** 请求时带的 id；VET 原样回带，仅用于把回执与请求配对。 */
    Id: number;
    /** 通过时的发现项（回执的 viper 子对象，source 固定为 check）。 */
    Environment?: ViperEnvironment;
    /** 未通过时的固定原因串（回执的 check_msg，如 NOT_FOUND / NO_PRVERSN）。 */
    Message?: string;
}

/** 暴露给其他扩展的 API。 */
export interface ViperApi {
    /** 获取当前工作区的项目配置。 */
    GetProject(workspaceFolder?: string): ViperProject | undefined;

    /** 获取 Viper 搜索路径（stdlib + includes + sourceDir）。 */
    GetViperSearchPaths(workspaceFolder?: string): string[];

    /** 获取当前工具链。 */
    GetToolchain(): ToolchainInfo;

    /**
     * 自动发现编译器自带的 includes 目录（以选中编译器 exe 所在目录为基准向上查找，
     * 仅返回真实存在的目录）。工程未声明 includes 时由调用方补进搜索路径。
     */
    GetCompilerIncludePaths(): string[];

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
    /** 命令参数（点击该节点时随命令一起传入）。 */
    CommandArguments?: unknown[];
    ContextValue?: string;
}
