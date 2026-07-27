/*
 * toolchainManager.ts
 * 发现和切换 Viper 工具链。
 * 当前硬编码为 C:\v.exe，版本 1.0.0。
 */

import { EventEmitter, Event, workspace } from 'vscode';
import { ToolchainInfo } from './types';

export class ToolchainManager {
    // 硬编码的工具链信息，后续支持自动发现时替换。
    private static readonly HardcodedToolchain: ToolchainInfo = {
        Path: 'C:\\v.exe',
        Version: '1.0.0',
        Source: 'hardcoded',
    };

    private current: ToolchainInfo;
    private readonly _onDidChange = new EventEmitter<ToolchainInfo>();
    readonly OnDidChangeToolchain: Event<ToolchainInfo> = this._onDidChange.event;

    constructor() {
        this.current = this.ResolveToolchain();
    }

    /** 获取当前工具链。 */
    GetToolchain(): ToolchainInfo {
        return this.current;
    }

    /** 切换工具链（更新配置项）。 */
    async SelectToolchain(): Promise<void> {
        const config = workspace.getConfiguration('viper.toolchain');
        const newPath = await this.PromptForPath(config.get<string>('path', ToolchainManager.HardcodedToolchain.Path));
        if (newPath) {
            await config.update('path', newPath, true);
            this.current = this.ResolveToolchain();
            this._onDidChange.fire(this.current);
        }
    }

    /** 重新解析当前工具链（配置变更后调用）。 */
    Refresh(): void {
        const next = this.ResolveToolchain();
        if (next.Path !== this.current.Path || next.Version !== this.current.Version) {
            this.current = next;
            this._onDidChange.fire(this.current);
        }
    }

    private ResolveToolchain(): ToolchainInfo {
        const config = workspace.getConfiguration('viper.toolchain');
        const configuredPath = config.get<string>('path');
        const configuredVersion = config.get<string>('version', ToolchainManager.HardcodedToolchain.Version);

        if (configuredPath && configuredPath.trim().length > 0) {
            return {
                Path: configuredPath,
                Version: configuredVersion,
                Source: 'config',
            };
        }

        return { ...ToolchainManager.HardcodedToolchain };
    }

    private async PromptForPath(current: string): Promise<string | undefined> {
        // 简化：后续可以替换为 QuickInput + 文件选择器。
        const { window } = await import('vscode');
        const result = await window.showInputBox({
            prompt: 'Viper compiler path',
            value: current,
            placeHolder: 'C:\\v.exe',
        });
        return result;
    }
}
