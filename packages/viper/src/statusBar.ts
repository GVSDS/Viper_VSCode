/*
 * statusBar.ts
 * 右下角状态栏：显示当前 Viper 编译器路径与版本。
 */

import { StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { ToolchainManager } from './toolchainManager';
import { Disposable } from 'vscode';

export class StatusBarManager implements Disposable {
    private readonly item: StatusBarItem;
    private readonly toolchain: ToolchainManager;
    private readonly disposable: Disposable;

    constructor(toolchain: ToolchainManager) {
        this.toolchain = toolchain;
        this.item = window.createStatusBarItem(StatusBarAlignment.Right, 100);
        this.item.command = 'viper.selectToolchain';

        this.disposable = toolchain.OnDidChangeToolchain(() => this.Update());
        this.Update();
        this.item.show();
    }

    private Update(): void {
        const tool = this.toolchain.GetToolchain();
        this.item.text = `$(tools) Viper: ${tool.Path} (${tool.Version})`;
        this.item.tooltip = `Viper Toolchain\nPath: ${tool.Path}\nVersion: ${tool.Version}\nSource: ${tool.Source}\nClick to change`;
    }

    dispose(): void {
        this.item.dispose();
        this.disposable.dispose();
    }
}
