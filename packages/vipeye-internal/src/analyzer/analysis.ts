/*
 * analysis.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Various analysis helper types and functions
 */

import { CancellationToken } from 'vscode-languageserver';

import { OperationCanceledException, throwIfCancellationRequested } from '../common/cancellationUtils';
import { ConfigOptions } from '../common/configOptions';
import { ConsoleInterface } from '../common/console';
import * as debug from '../common/debug';
import { FileDiagnostics } from '../common/diagnosticSink';
import { Duration } from '../common/timing';
import { MaxAnalysisTime, Program } from './program';

export const nullCallback: AnalysisCompleteCallback = () => {
    /* empty */
};

export interface AnalysisResults {
    diagnostics: FileDiagnostics[];
    filesInProgram: number;
    checkingOnlyOpenFiles: boolean;
    requiringAnalysisCount: RequiringAnalysisCount;
    fatalErrorOccurred: boolean;
    configParseErrorOccurred: boolean;
    elapsedTime: number;
    error?: Error | undefined;
    reason: 'analysis' | 'tracking';
}

export interface RequiringAnalysisCount {
    files: number;
    cells: number;
}

/**
 * Viper 扩展：分析进度的快照，供 LSP 客户端在状态栏显示
 * 「C:\xxx\1.vp (4/90) 0.04% loading...」这类进度信息。
 */
export interface AnalysisProgress {
    /** 当前正在分析的文件路径（文件系统路径，Windows 下形如 C:\xxx\1.vp）。 */
    currentFile: string | undefined;

    /** 已分析的用户文件数。 */
    analyzed: number;

    /** 需要分析的用户文件总数。 */
    total: number;

    /** 是否已分析完毕（true 表示可以收起状态栏进度项）。 */
    done: boolean;
}

export type AnalysisProgressCallback = (progress: AnalysisProgress) => void;

export type AnalysisCompleteCallback = (results: AnalysisResults) => void;

export function analyzeProgram(
    program: Program,
    maxTime: MaxAnalysisTime | undefined,
    configOptions: ConfigOptions,
    callback: AnalysisCompleteCallback | undefined,
    console: ConsoleInterface,
    token: CancellationToken,
    progressCallback?: AnalysisProgressCallback
): boolean {
    let moreToAnalyze = false;

    callback = callback ?? nullCallback;

    try {
        throwIfCancellationRequested(token);

        const duration = new Duration();
        // 逐文件上报进度（analyze 每检查完一个文件就回一次），
        // 让客户端状态栏能实时反映「正在分析哪个文件」。
        moreToAnalyze = program.analyze(
            maxTime,
            token,
            progressCallback ? () => progressCallback({ ...program.getAnalysisProgress(), done: false }) : undefined
        );

        if (progressCallback) {
            progressCallback({ ...program.getAnalysisProgress(), done: !moreToAnalyze });
        }

        const requiringAnalysisCount = program.getFilesToAnalyzeCount();

        // If we're using command-line mode, the maxTime will be undefined, and we'll
        // want to report all diagnostics rather than just the ones that have changed.
        const reportDiagnosticDeltasOnly = maxTime !== undefined;

        const diagnostics = program.getDiagnostics(configOptions, reportDiagnosticDeltasOnly);
        const diagnosticFileCount = diagnostics.length;
        const elapsedTime = duration.getDurationInSeconds();

        // Report any diagnostics or completion.
        if (diagnosticFileCount > 0 || !moreToAnalyze) {
            callback({
                diagnostics,
                filesInProgram: program.getFileCount(),
                requiringAnalysisCount: requiringAnalysisCount,
                checkingOnlyOpenFiles: program.isCheckingOnlyOpenFiles(),
                fatalErrorOccurred: false,
                configParseErrorOccurred: false,
                elapsedTime,
                reason: 'analysis',
            });
        }
    } catch (e: any) {
        if (OperationCanceledException.is(e)) {
            return false;
        }

        const message = debug.getErrorString(e);
        console.error('Error performing analysis: ' + message);

        callback({
            diagnostics: [],
            filesInProgram: 0,
            requiringAnalysisCount: { files: 0, cells: 0 },
            checkingOnlyOpenFiles: true,
            fatalErrorOccurred: true,
            configParseErrorOccurred: false,
            elapsedTime: 0,
            error: debug.getSerializableError(e),
            reason: 'analysis',
        });
    }

    return moreToAnalyze;
}
