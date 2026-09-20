/*
 * environmentManager.ts
 * Viper 环境（编译器）清单与选中状态。
 *
 * 数据来源是 VET 每轮输出的**全量**快照，所以这里要自己 diff（Added / Removed），
 * 并把「选中哪个环境」持久化到扩展状态（globalState）——刻意不写回 .vpj，保持项目文件干净。
 */

import { Disposable, Event, EventEmitter, Memento, QuickPickItem, window, commands } from 'vscode';

import { ViperEnvironment } from './types';

/** 一次快照带来的变化。 */
export interface EnvironmentChange {
    /** 当前全部环境（已排序）。 */
    Environments: ViperEnvironment[];
    /** 本轮新增。 */
    Added: ViperEnvironment[];
    /** 本轮移除。 */
    Removed: ViperEnvironment[];
}

export class EnvironmentManager implements Disposable {
    private static readonly SelectedIdKey = 'viper.environmentTool.selectedId';

    private environments: ViperEnvironment[] = [];
    private selectedId: string | undefined;

    private readonly _onDidChangeEnvironments = new EventEmitter<EnvironmentChange>();
    readonly OnDidChangeEnvironments: Event<EnvironmentChange> = this._onDidChangeEnvironments.event;

    private readonly _onDidChangeSelection = new EventEmitter<ViperEnvironment | undefined>();
    readonly OnDidChangeSelection: Event<ViperEnvironment | undefined> = this._onDidChangeSelection.event;

    constructor(private readonly globalState: Memento) {
        this.selectedId = globalState.get<string>(EnvironmentManager.SelectedIdKey);
    }

    /** 应用一轮全量快照，返回 diff 结果。 */
    ApplySnapshot(environments: ViperEnvironment[]): EnvironmentChange {
        const previousIds = new Set(this.environments.map((environment) => environment.Id));
        const next = [...environments].sort(CompareEnvironments);
        const nextIds = new Set(next.map((environment) => environment.Id));

        const added = next.filter((environment) => !previousIds.has(environment.Id));
        const removed = this.environments.filter((environment) => !nextIds.has(environment.Id));

        this.environments = next;
        this.ResolveStickySelection();

        const change: EnvironmentChange = { Environments: next, Added: added, Removed: removed };
        this._onDidChangeEnvironments.fire(change);
        return change;
    }

    /**
     * 选定「本次生效的环境」：
     *   1. 优先复用上次用的那个 exe（按 VET 给的 uuid 在快照里找）；
     *   2. 找不到（第一次用、或那个 exe 已被删/移走）则用发现的第一个；
     *   3. VET 一个都没给出时保留上次记录，等它下一轮回来。
     * 结果写回 globalState，作为下一次的「上次用的」。
     */
    private ResolveStickySelection(): void {
        const preferred = this.environments.find((environment) => environment.Id === this.selectedId)
            ?? this.environments[0];

        if (!preferred || preferred.Id === this.selectedId) {
            return;
        }

        this.selectedId = preferred.Id;
        void this.globalState.update(EnvironmentManager.SelectedIdKey, preferred.Id);
        this._onDidChangeSelection.fire(preferred);
    }

    /** 当前全部环境。 */
    GetEnvironments(): ViperEnvironment[] {
        return this.environments;
    }

    /** 当前选中的环境 id。 */
    GetSelectedId(): string | undefined {
        return this.selectedId;
    }

    /** 当前选中的环境（若已被 VET 移除则为 undefined）。 */
    GetSelectedEnvironment(): ViperEnvironment | undefined {
        if (!this.selectedId) {
            return undefined;
        }
        return this.environments.find((environment) => environment.Id === this.selectedId);
    }

    /**
     * 选择环境。
     * @param environmentId 传入则直接选中该 id；不传则弹 QuickPick 让用户选。
     */
    async SelectEnvironment(environmentId?: string): Promise<ViperEnvironment | undefined> {
        if (environmentId) {
            return this.ApplySelection(environmentId);
        }

        const all = this.environments;
        if (all.length === 0) {
            const picked = await window.showWarningMessage('VET 还没有发现任何 Viper 编译器。', '重启 VET 扫描');
            if (picked === '重启 VET 扫描') {
                void commands.executeCommand('viper.restartEnvironmentTool');
            }
            return undefined;
        }

        const items = all.map<EnvironmentQuickPickItem>((environment) => ({
            label: environment.DisplayName,
            description: `${environment.Version} · ${environment.Arch} · ${environment.Source}`,
            detail: environment.Executable,
            picked: environment.Id === this.selectedId,
            Environment: environment,
        }));

        const picked = await window.showQuickPick(items, {
            title: '选择 Viper 环境',
            placeHolder: '选择要使用的 Viper 编译器（仅保存在扩展状态，不写入 .vpj）',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        return picked ? this.ApplySelection(picked.Environment.Id) : undefined;
    }

    dispose(): void {
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeSelection.dispose();
    }

    private async ApplySelection(environmentId: string): Promise<ViperEnvironment | undefined> {
        const environment = this.environments.find((item) => item.Id === environmentId);
        if (!environment) {
            return undefined;
        }

        this.selectedId = environmentId;
        await this.globalState.update(EnvironmentManager.SelectedIdKey, environmentId);
        this._onDidChangeSelection.fire(environment);
        return environment;
    }
}

interface EnvironmentQuickPickItem extends QuickPickItem {
    Environment: ViperEnvironment;
}

/** 排序：先按来源分组，再按展示名；保证每轮快照顺序稳定（避免视图抖动）。 */
function CompareEnvironments(left: ViperEnvironment, right: ViperEnvironment): number {
    if (left.Source !== right.Source) {
        return left.Source.localeCompare(right.Source);
    }
    return left.DisplayName.localeCompare(right.DisplayName);
}
