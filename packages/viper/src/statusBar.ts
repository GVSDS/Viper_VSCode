/*
 * statusBar.ts
 * 右下角状态栏：显示 VET 发现的 Viper 环境与当前生效项。
 */

import { Disposable, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { EnvironmentManager } from './environmentManager';
import { EnvironmentTool, EnvironmentToolState } from './environmentTool';

/**
 * 环境状态栏：显示 VET 发现/选中了哪个编译器，点击打开环境选择器。
 * 这里只保留这一项：编译器位置完全由 VET 发现结果决定，不再显示硬编码路径。
 */
export class EnvironmentStatusBar implements Disposable {
    private readonly item: StatusBarItem;
    private readonly disposables: Disposable[] = [];

    constructor(private readonly environments: EnvironmentManager, private readonly tool: EnvironmentTool) {
        this.item = window.createStatusBarItem(StatusBarAlignment.Right, 99);
        this.item.command = 'viper.selectEnvironment';

        this.disposables.push(
            environments.OnDidChangeEnvironments(() => this.Update()),
            environments.OnDidChangeSelection(() => this.Update()),
            tool.OnDidChangeState(() => this.Update())
        );

        this.Update();
    }

    private Update(): void {
        const state = this.tool.GetState();
        if (state === 'disabled') {
            this.item.hide();
            return;
        }

        const selected = this.environments.GetSelectedEnvironment();
        const count = this.environments.GetEnvironments().length;
        const stateText = DescribeState(state);

        // 点击状态栏始终打开选择列表：VET 关闭时也一样 —— 已发现的环境仍可选用，
        // 需要重启 VET 请走命令面板的「Restart VET」。
        this.item.command = 'viper.selectEnvironment';

        if (state === 'stopped') {
            this.item.text = '$(debug-stop) VET 已关闭';
        } else if (selected) {
            this.item.text = `$(server-environment) Viper 环境: ${selected.DisplayName}`;
        } else if (count > 0) {
            this.item.text = `$(server-environment) Viper 环境: 未选择 (${count})`;
        } else if (state === 'running' || state === 'starting') {
            this.item.text = '$(sync~spin) Viper 环境: 扫描中…';
        } else {
            this.item.text = `$(warning) Viper 环境: ${stateText}`;
        }

        this.item.tooltip = [
            `VET 状态: ${stateText}`,
            `发现环境: ${count}`,
            selected ? `当前选中: ${selected.DisplayName}\n${selected.Executable}` : '当前选中: （无）',
            `VET: ${this.tool.GetExecutablePath()}`,
            '输出: Vipeye VET 输出通道',
            state === 'stopped'
                ? '点击选择编译器（VET 已关闭，已发现的环境仍可选用；重启请用 Restart VET）'
                : '点击选择编译器',
        ].join('\n');
        this.item.show();
    }

    dispose(): void {
        this.item.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}

function DescribeState(state: EnvironmentToolState): string {
    switch (state) {
        case 'running':
            return '运行中';
        case 'starting':
            return '启动中';
        case 'restarting':
            return '重启中';
        case 'stopped':
            return '已关闭（手动）';
        case 'failed':
            return '已停止（连续失败）';
        default:
            return '未启用';
    }
}
