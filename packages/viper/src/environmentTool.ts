/*
 * environmentTool.ts
 * VET（Viper Environment Tool）常驻进程客户端。
 *
 * VET 是一个用 Viper 自身写的扫盘发现器（见 TransPyC/VET），协议如下：
 *   VET.exe scan --cache <path> [--sleep <毫秒>]
 *           [--need-confirm <秒> [--need-confirm-timeout <毫秒>]] [--path <dir>]...
 *   - stdout：每轮输出一行**完整**的编译器 JSON 数组（所以增量变化要自己 diff）
 *   - stderr：滚动日志（量很大，原样进输出通道）
 *   - --need-confirm：每 <秒> 秒一个确认窗口（窗口长度 = --need-confirm-timeout，缺省 5s），
 *     窗口内必须从 stdin 收到一行 {"ok":1}；否则 VET 在 stdout 输出 {"exit":1,...} 并以退出码 1 终止。
 *
 * 本类负责：进程生命周期（自动重启 + 指数退避 + 重启上限）、心跳确认、输出转发、快照解析。
 *
 * 输出：VET 的 stdout 与 stderr **原样**转发到 "Vipeye VET" 输出通道，不落盘。
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { commands, Disposable, Event, EventEmitter, OutputChannel, window, workspace } from 'vscode';

import { ViperEnvironment } from './types';

/**
 * VET 进程状态。
 *   disabled   —— 配置里 viper.environmentTool.enabled = false，扩展不启动它
 *   stopped    —— 用户手动执行了「停止 VET」命令（与 disabled 区分，便于状态栏给出「点击可重新启动」）
 *   starting / running / restarting / failed —— 进程生命周期与自动重启
 */
export type EnvironmentToolState = 'disabled' | 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

/** 进程存活超过该时长即认为这一轮是健康的，重启计数清零。 */
const HealthyRunMs = 30000;
/** 两次心跳之间的最小间隔，避免同一轮重复发送。 */
const MinConfirmIntervalMs = 1500;

export class EnvironmentTool implements Disposable {
    private process: ChildProcessWithoutNullStreams | undefined;
    private state: EnvironmentToolState = 'disabled';
    private restarts = 0;
    private startedAt = 0;
    private lastConfirmAt = 0;
    private stdoutBuffer = '';
    private stderrBuffer = '';
    private restartTimer: NodeJS.Timeout | undefined;
    private watchdogTimer: NodeJS.Timeout | undefined;
    private disposed = false;
    /** 上次记录过的退出信息，避免状态栏/提示重复报同一件事。 */
    private lastExitSummary = '';

    private readonly channel: OutputChannel;

    private readonly _onDidChangeEnvironments = new EventEmitter<ViperEnvironment[]>();
    /** 每轮 stdout 快照（全量）。 */
    readonly OnDidChangeEnvironments: Event<ViperEnvironment[]> = this._onDidChangeEnvironments.event;

    private readonly _onDidChangeState = new EventEmitter<EnvironmentToolState>();
    readonly OnDidChangeState: Event<EnvironmentToolState> = this._onDidChangeState.event;

    constructor(private readonly storageDir: string, channel: OutputChannel) {
        this.channel = channel;
    }

    /** 当前进程状态。 */
    GetState(): EnvironmentToolState {
        return this.state;
    }

    /** 缓存文件路径（交给 VET 自己维护）。 */
    GetCachePath(): string {
        return path.join(this.storageDir, 'vet-cache.json');
    }

    /** 当前配置里的 VET 可执行文件路径。 */
    GetExecutablePath(): string {
        return this.ReadConfig().exePath;
    }

    /** 启动（已启动则先停掉再起）。 */
    Start(): void {
        this.StopProcess();
        this.restarts = 0;
        this.lastExitSummary = '';
        this.Spawn();
    }

    /** 手动重启（命令入口）：重置重启计数，让用户能自己解围。 */
    Restart(): void {
        this.AppendLog('[vscode] 手动重启 VET');
        this.Start();
    }

    /**
     * 手动停止（命令入口）：停掉进程并置为 stopped（区别于配置禁用），不再自动重启。
     * 之后用「重启 VET」即可恢复（Restart → Start 会重新 Spawn）。
     * 说明：不清空已发现的环境与选中项 —— VET 只是发现器，关掉它不影响已经选定的编译器。
     */
    Stop(): void {
        this.AppendLog('[vscode] 手动停止 VET');
        this.StopProcess();
        this.restarts = 0;
        this.SetState('stopped');
    }

    /** 追加一行日志（进 "Vipeye VET" 输出通道），供扩展其它部分记录与 VET 相关的信息。 */
    AppendLog(line: string): void {
        this.channel.appendLine(line);
    }

    /** 显示输出通道。 */
    ShowLog(): void {
        this.channel.show(true);
    }

    dispose(): void {
        this.disposed = true;
        this.StopProcess();
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeState.dispose();
        this.channel.dispose();
    }

    // ===== 进程生命周期 =====

    private Spawn(): void {
        if (this.disposed) {
            return;
        }

        const config = this.ReadConfig();
        if (!config.enabled) {
            this.SetState('disabled');
            this.AppendLog('[vscode] viper.environmentTool.enabled = false，不启动 VET');
            return;
        }

        if (!fs.existsSync(config.exePath)) {
            // 路径配错不会自己好，直接失败并提示，不做无意义的重启。
            this.SetState('failed');
            this.AppendLog(`[vscode] 找不到 VET 可执行文件: ${config.exePath}`);
            void window
                .showErrorMessage(
                    `VET 可执行文件不存在：${config.exePath}。请检查设置 viper.environmentTool.path。`,
                    '打开设置'
                )
                .then((picked) => {
                    if (picked === '打开设置') {
                        void commands.executeCommand('workbench.action.openSettings', 'viper.environmentTool.path');
                    }
                });
            return;
        }

        // VET 要把发现缓存写到该目录；目录不存在时缓存写失败（只告警），会导致每轮都从空缓存重扫。
        try {
            fs.mkdirSync(this.storageDir, { recursive: true });
        } catch {
            // 建不出目录不阻断启动（VET 仍能运行，只是缓存不可用）。
        }

        this.SetState('starting');

        const args = this.BuildArgs(config);
        this.AppendLog(`[vscode] 启动: ${config.exePath} ${args.join(' ')}`);

        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(config.exePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            this.AppendLog(`[vscode] 启动失败: ${String(e)}`);
            this.HandleUnexpectedExit(-1, 'spawn-error');
            return;
        }

        this.process = child;
        this.startedAt = Date.now();
        this.lastConfirmAt = 0;
        this.stdoutBuffer = '';
        this.stderrBuffer = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => this.HandleStdout(chunk));
        child.stderr.on('data', (chunk: string) => this.HandleStderr(chunk));
        child.on('error', (err: Error) => {
            this.AppendLog(`[vscode] 进程错误: ${err.message}`);
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.SetState('failed');
                void window.showErrorMessage(`无法启动 VET（${config.exePath}）：${err.message}`);
            }
        });
        child.on('exit', (code, signal) => {
            if (this.process === child) {
                this.process = undefined;
            }

            const aliveMs = Date.now() - this.startedAt;
            this.AppendLog(`[vscode] VET 退出: code=${code} signal=${signal ?? '-'} 存活 ${aliveMs} ms`);

            if (this.disposed) {
                return;
            }
            this.HandleUnexpectedExit(code ?? -1, signal ?? 'exit');
        });

        this.EnsureWatchdog();
        this.SetState('running');
    }

    /** 组装 scan 子命令参数。 */
    private BuildArgs(config: EnvironmentToolConfig): string[] {
        const args = ['scan', '--cache', this.GetCachePath(), '--sleep', String(config.scanIntervalMs)];

        if (config.confirmSeconds > 0) {
            args.push('--need-confirm', String(config.confirmSeconds));
            args.push('--need-confirm-timeout', String(config.confirmTimeoutMs));
        }

        // 一旦出现 --path，VET 就不再自动建常用目录表，所以仅在显式配置时追加。
        for (const scanPath of config.scanPaths) {
            if (scanPath && scanPath.trim().length > 0) {
                args.push('--path', scanPath);
            }
        }

        return args;
    }

    private StopProcess(): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }

        const child = this.process;
        this.process = undefined;
        if (!child) {
            return;
        }

        this.AppendLog('[vscode] 请求停止 VET 进程');
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.removeAllListeners('exit');
        child.kill();
    }

    /**
     * 非主动退出：按「重启上限 + 指数退避」处理，并且每次都通知用户。
     * @param code 退出码（-1 表示启动失败等非进程退出情形）
     * @param reason 退出原因描述
     */
    private HandleUnexpectedExit(code: number, reason: string): void {
        const config = this.ReadConfig();
        const aliveMs = Date.now() - this.startedAt;
        if (aliveMs >= HealthyRunMs) {
            this.restarts = 0;
        }

        const summary = `code=${code} reason=${reason}`;
        if (summary !== this.lastExitSummary) {
            this.lastExitSummary = summary;
            void window
                .showErrorMessage(`VET 异常退出（${summary}）。`, '查看日志')
                .then((picked) => {
                    if (picked === '查看日志') {
                        this.ShowLog();
                    }
                });
        }

        if (this.restarts >= config.maxRestarts) {
            this.SetState('failed');
            this.AppendLog(
                `[vscode] 已连续异常退出 ${this.restarts} 次，达到上限 ${config.maxRestarts}，不再自动重启`
            );
            void window
                .showErrorMessage(
                    `VET 已连续异常退出 ${this.restarts} 次（上限 ${config.maxRestarts}），不再自动重启。`,
                    '重启 VET',
                    '打开设置'
                )
                .then((picked) => {
                    if (picked === '重启 VET') {
                        this.Restart();
                    } else if (picked === '打开设置') {
                        void import('vscode').then((vscode) =>
                            vscode.commands.executeCommand('workbench.action.openSettings', 'viper.environmentTool')
                        );
                    }
                });
            return;
        }

        this.restarts++;
        const delay = Math.min(30000, 1000 * 2 ** (this.restarts - 1));
        this.SetState('restarting');
        this.AppendLog(`[vscode] 第 ${this.restarts}/${config.maxRestarts} 次重启，${delay} ms 后重试`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            this.Spawn();
        }, delay);
    }

    // ===== stdout / stderr =====

    private HandleStdout(chunk: string): void {
        this.stdoutBuffer += chunk;

        let newlineIndex = this.stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            if (line.length > 0) {
                this.HandleStdoutLine(line);
            }
            newlineIndex = this.stdoutBuffer.indexOf('\n');
        }
    }

    private HandleStdoutLine(line: string): void {
        // stdout 是数据通道（每轮一行完整 JSON 数组）。原样进 "Vipeye VET"，与 stderr 对照排查。
        this.channel.appendLine(`[stdout] ${line}`);

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            // 非 JSON 的 stdout（例如 VET 的 [OOM] 文本）已在上面原样输出。
            return;
        }

        if (Array.isArray(parsed)) {
            this._onDidChangeEnvironments.fire(this.ToEnvironments(parsed));
            return;
        }

        // {"exit":1, "msg":"timeout/ok!=1"} —— VET 因确认失败而终止。
        const exitInfo = parsed as { exit?: number; msg?: string };
        this.AppendLog(`[vscode] VET 报告退出: exit=${exitInfo.exit ?? '?'} msg=${exitInfo.msg ?? ''}`);
    }

    /** 把 VET 输出的 JSON 条目规整为强类型（字段名转 PascalCase，缺字段给空串）。 */
    private ToEnvironments(entries: unknown[]): ViperEnvironment[] {
        return entries
            .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
            .map((entry) => this.ToEnvironment(entry))
            .filter((environment) => environment.Id.length > 0 || environment.Executable.length > 0);
    }

    private ToEnvironment(entry: Record<string, unknown>): ViperEnvironment {
        return {
            Id: String(entry.id ?? ''),
            Executable: String(entry.executable ?? ''),
            Version: String(entry.version ?? ''),
            Arch: String(entry.arch ?? ''),
            Source: String(entry.source ?? ''),
            DisplayName: String(entry.displayName ?? entry.executable ?? ''),
        };
    }

    private HandleStderr(chunk: string): void {
        this.stderrBuffer += chunk;

        let newlineIndex = this.stderrBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const line = this.stderrBuffer.slice(0, newlineIndex).replace(/\r$/, '');
            this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
            if (line.length > 0) {
                this.HandleStderrLine(line);
            }
            newlineIndex = this.stderrBuffer.indexOf('\n');
        }
    }

    private HandleStderrLine(line: string): void {
        // stderr 全部原样进 "Vipeye VET"（含 [scan] 进度行），不做过滤。
        this.channel.appendLine(line);

        // 每轮结束会提示进入确认窗口，这时才回 {"ok":1}（窗口只有几秒，必须立刻回）。
        if (line.includes('本轮期限') || line.includes('[confirm] 请在')) {
            this.SendConfirm();
        }
    }

    /** 向 VET 的 stdin 写入一行 {"ok":1}。 */
    private SendConfirm(): void {
        const child = this.process;
        if (!child || !child.stdin.writable) {
            return;
        }
        // 提示是两行（请在… / 当前… 本轮期限…），间隔很短；去重避免同一窗口重复发送。
        if (Date.now() - this.lastConfirmAt < MinConfirmIntervalMs) {
            return;
        }

        this.lastConfirmAt = Date.now();
        try {
            child.stdin.write('{"ok":1}\n');
            this.AppendLog('[vscode] 已发送心跳 {"ok":1}');
        } catch (e) {
            this.AppendLog(`[vscode] 心跳写入失败: ${String(e)}`);
        }
    }

    /**
     * 心跳兜底：万一没识别到确认提示（例如 VET 日志措辞变化），
     * 超过「确认周期 + 5 秒」没有发送过就补一次，避免 VET 因超时自杀。
     */
    private EnsureWatchdog(): void {
        if (this.watchdogTimer) {
            return;
        }

        this.watchdogTimer = setInterval(() => {
            const config = this.ReadConfig();
            if (config.confirmSeconds <= 0 || !this.process) {
                return;
            }
            if (Date.now() - this.lastConfirmAt > (config.confirmSeconds + 5) * 1000) {
                this.SendConfirm();
            }
        }, 2000);
    }

    // ===== 状态 =====

    private SetState(next: EnvironmentToolState): void {
        if (this.state === next) {
            return;
        }
        this.state = next;
        this._onDidChangeState.fire(next);
    }

    private ReadConfig(): EnvironmentToolConfig {
        const config = workspace.getConfiguration('viper.environmentTool');
        return {
            enabled: config.get<boolean>('enabled', true),
            exePath: config.get<string>('path', '').trim(),
            scanPaths: config.get<string[]>('scanPaths', []),
            confirmSeconds: config.get<number>('confirmSeconds', 10),
            confirmTimeoutMs: config.get<number>('confirmTimeoutMs', 5000),
            scanIntervalMs: config.get<number>('scanIntervalMs', 10000),
            maxRestarts: Math.max(0, config.get<number>('maxRestarts', 5)),
        };
    }
}

interface EnvironmentToolConfig {
    enabled: boolean;
    exePath: string;
    scanPaths: string[];
    confirmSeconds: number;
    confirmTimeoutMs: number;
    scanIntervalMs: number;
    maxRestarts: number;
}
