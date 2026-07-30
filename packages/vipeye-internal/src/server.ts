/*
 * server.ts
 *
 * Implements viper language server.
 */

import {
    CancellationToken,
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    Command,
    Connection,
    ExecuteCommandParams,
    WorkDoneProgressServerReporter,
} from 'vscode-languageserver';

import { AnalysisResults } from './analyzer/analysis';
import { CacheManager } from './analyzer/cacheManager';
import { ImportResolver } from './analyzer/importResolver';
import { BackgroundAnalysis } from './backgroundAnalysis';
import { IBackgroundAnalysis } from './backgroundAnalysisBase';
import { CommandController } from './commands/commandController';
import { getCancellationFolderName } from './common/cancellationUtils';
import { ConfigOptions, SignatureDisplayType } from './common/configOptions';
import { ConsoleWithLogLevel, LogLevel, convertLogLevel } from './common/console';
import { isDebugMode, isDefined, isString } from './common/core';
import { resolvePathWithEnvVariables } from './common/envVarUtils';
import { FileBasedCancellationProvider } from './common/fileBasedCancellationUtils';
import { FileSystem } from './common/fileSystem';
import { FullAccessHost } from './common/fullAccessHost';
import { Host } from './common/host';
import { ServerSettings } from './common/languageServerInterface';
import { ProgressReporter } from './common/progressReporter';
import { RealTempFile, WorkspaceFileWatcherProvider, createFromRealFileSystem } from './common/realFileSystem';
import { ServiceProvider } from './common/serviceProvider';
import { createServiceProvider } from './common/serviceProviderExtensions';
import { Uri } from './common/uri/uri';
import { getRootUri } from './common/uri/uriUtils';
import { LanguageServerBase } from './languageServerBase';
import { CodeActionProvider } from './languageService/codeActionProvider';
import { ViperFileSystem } from './viperFileSystem';
import { WellKnownWorkspaceKinds, Workspace } from './workspaceFactory';
import { PartialStubService } from './partialStubService';

const maxAnalysisTimeInForeground = { openFilesTimeInMs: 50, noOpenFilesTimeInMs: 200 };

export class ViperServer extends LanguageServerBase {
    private _controller: CommandController;

    constructor(connection: Connection, maxWorkers: number, realFileSystem?: FileSystem) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const version = require('../package.json').version || '';

        const tempFile = new RealTempFile();
        const console = new ConsoleWithLogLevel(connection.console);
        const fileWatcherProvider = new WorkspaceFileWatcherProvider();
        const fileSystem = realFileSystem ?? createFromRealFileSystem(tempFile, console, fileWatcherProvider);
        const viperFs = new ViperFileSystem(fileSystem);
        const cacheManager = new CacheManager(maxWorkers);
        const partialStubService = new PartialStubService(viperFs);

        const serviceProvider = createServiceProvider(
            viperFs,
            tempFile,
            console,
            cacheManager,
            partialStubService,
            new FileBasedCancellationProvider('bg')
        );

        // When executed from CLI command (vipeye-langserver), __rootDirectory is
        // already defined. When executed from VSCode extension, rootDirectory should
        // be __dirname.
        const rootDirectory: Uri = getRootUri(serviceProvider) || Uri.file(__dirname, serviceProvider);
        const realPathRoot = viperFs.realCasePath(rootDirectory);

        super(
            {
                productName: 'Vipeye',
                rootDirectory: realPathRoot,
                version,
                serviceProvider,
                fileWatcherHandler: fileWatcherProvider,
                maxAnalysisTimeInForeground,
                supportedCodeActions: [CodeActionKind.QuickFix, CodeActionKind.SourceOrganizeImports],
            },
            connection
        );

        this._controller = new CommandController(this);
    }

    async getSettings(workspace: Workspace): Promise<ServerSettings> {
        const serverSettings: ServerSettings = {
            watchForSourceChanges: true,
            watchForLibraryChanges: true,
            watchForConfigChanges: true,
            openFilesOnly: true,
            useLibraryCodeForTypes: true,
            disableLanguageServices: false,
            disableTaggedHints: false,
            disableOrganizeImports: false,
            typeCheckingMode: 'standard',
            diagnosticSeverityOverrides: {},
            logLevel: LogLevel.Info,
            autoImportCompletions: true,
            functionSignatureDisplay: SignatureDisplayType.formatted,
        };

        try {
            const workspaces = this.workspaceFactory.getNonDefaultWorkspaces(WellKnownWorkspaceKinds.Regular);

            const viperSection = await this.getConfiguration(workspace.rootUri, 'viper');

            const viperAnalysisSection = viperSection?.analysis;
            if (viperAnalysisSection) {
                const typeshedPaths = viperAnalysisSection.typeshedPaths;
                if (typeshedPaths && Array.isArray(typeshedPaths) && typeshedPaths.length > 0) {
                    const typeshedPath = typeshedPaths[0];
                    if (typeshedPath && isString(typeshedPath)) {
                        serverSettings.typeshedPath = resolvePathWithEnvVariables(workspace, typeshedPath, workspaces);
                    }
                }

                const stubPath = viperAnalysisSection.stubPath;
                if (stubPath && isString(stubPath)) {
                    serverSettings.stubPath = resolvePathWithEnvVariables(workspace, stubPath, workspaces);
                }

                const diagnosticSeverityOverrides = viperAnalysisSection.diagnosticSeverityOverrides;
                if (diagnosticSeverityOverrides) {
                    for (const [name, value] of Object.entries(diagnosticSeverityOverrides)) {
                        const ruleName = this.getDiagnosticRuleName(name);
                        const severity = this.getSeverityOverrides(value as string | boolean);
                        if (ruleName && severity) {
                            serverSettings.diagnosticSeverityOverrides![ruleName] = severity!;
                        }
                    }
                }

                if (viperAnalysisSection.diagnosticMode !== undefined) {
                    serverSettings.openFilesOnly = this.isOpenFilesOnly(viperAnalysisSection.diagnosticMode);
                } else if (viperAnalysisSection.openFilesOnly !== undefined) {
                    serverSettings.openFilesOnly = !!viperAnalysisSection.openFilesOnly;
                }

                if (viperAnalysisSection.useLibraryCodeForTypes !== undefined) {
                    serverSettings.useLibraryCodeForTypes = !!viperAnalysisSection.useLibraryCodeForTypes;
                }

                serverSettings.logLevel = convertLogLevel(viperAnalysisSection.logLevel);
                serverSettings.autoSearchPaths = !!viperAnalysisSection.autoSearchPaths;

                const extraPaths = viperAnalysisSection.extraPaths;
                if (extraPaths && Array.isArray(extraPaths) && extraPaths.length > 0) {
                    serverSettings.extraPaths = extraPaths
                        .filter((p) => p && isString(p))
                        .map((p) => resolvePathWithEnvVariables(workspace, p, workspaces))
                        .filter(isDefined);
                }

                serverSettings.includeFileSpecs = this._getStringValues(viperAnalysisSection.include);
                serverSettings.excludeFileSpecs = this._getStringValues(viperAnalysisSection.exclude);
                serverSettings.ignoreFileSpecs = this._getStringValues(viperAnalysisSection.ignore);

                if (viperAnalysisSection.typeCheckingMode !== undefined) {
                    serverSettings.typeCheckingMode = viperAnalysisSection.typeCheckingMode;
                }

                if (viperAnalysisSection.autoImportCompletions !== undefined) {
                    serverSettings.autoImportCompletions = viperAnalysisSection.autoImportCompletions;
                }

                if (
                    serverSettings.logLevel === LogLevel.Log &&
                    viperAnalysisSection.logTypeEvaluationTime !== undefined
                ) {
                    serverSettings.logTypeEvaluationTime = viperAnalysisSection.logTypeEvaluationTime;
                }

                if (viperAnalysisSection.typeEvaluationTimeThreshold !== undefined) {
                    serverSettings.typeEvaluationTimeThreshold = viperAnalysisSection.typeEvaluationTimeThreshold;
                }
            } else {
                serverSettings.autoSearchPaths = true;
            }

            const vipeyeSection = await this.getConfiguration(workspace.rootUri, 'vipeye');
            if (vipeyeSection) {
                serverSettings.disableLanguageServices = !!vipeyeSection.disableLanguageServices;
                serverSettings.disableTaggedHints = !!vipeyeSection.disableTaggedHints;
                serverSettings.disableOrganizeImports = !!vipeyeSection.disableOrganizeImports;
            }
        } catch (error) {
            this.console.error(`Error reading settings: ${error}`);
        }
        return serverSettings;
    }

    createBackgroundAnalysis(serviceId: string, workspaceRoot: Uri): IBackgroundAnalysis | undefined {
        if (isDebugMode() || !getCancellationFolderName()) {
            // Don't do background analysis if we're in debug mode or an old client
            // is used where cancellation is not supported.
            return undefined;
        }

        return new BackgroundAnalysis(workspaceRoot, this.serverOptions.serviceProvider);
    }

    protected override createHost(): Host {
        return new FullAccessHost(this.serverOptions.serviceProvider);
    }

    protected override createImportResolver(
        serviceProvider: ServiceProvider,
        options: ConfigOptions,
        host: Host
    ): ImportResolver {
        const importResolver = new ImportResolver(serviceProvider, options, host);

        // In case there was cached information in the file system related to
        // import resolution, invalidate it now.
        importResolver.invalidateCache();

        return importResolver;
    }

    protected executeCommand(params: ExecuteCommandParams, token: CancellationToken): Promise<any> {
        return this._controller.execute(params, token);
    }

    protected isLongRunningCommand(command: string): boolean {
        return this._controller.isLongRunningCommand(command);
    }

    protected isRefactoringCommand(command: string): boolean {
        return this._controller.isRefactoringCommand(command);
    }

    protected async executeCodeAction(
        params: CodeActionParams,
        token: CancellationToken
    ): Promise<(Command | CodeAction)[] | undefined | null> {
        this.recordUserInteractionTime();

        const uri = Uri.parse(params.textDocument.uri, this.serverOptions.serviceProvider);
        const workspace = await this.getWorkspaceForFile(uri);
        return CodeActionProvider.getCodeActionsForPosition(workspace, uri, params.range, params.context.only, token);
    }

    protected createProgressReporter(): ProgressReporter {
        // The old progress notifications are kept for backwards compatibility with
        // clients that do not support work done progress.
        let displayingProgress = false;
        let workDoneProgress: Promise<WorkDoneProgressServerReporter> | undefined;
        return {
            isDisplayingProgress: () => displayingProgress,
            isEnabled: (data: AnalysisResults) => true,
            begin: () => {
                displayingProgress = true;
                if (this.client.hasWindowProgressCapability) {
                    workDoneProgress = this.connection.window.createWorkDoneProgress();
                    workDoneProgress
                        .then((progress) => {
                            progress.begin('');
                        })
                        .catch(() => {});
                } else {
                    this.connection.sendNotification('viper/beginProgress');
                }
            },
            report: (message: string) => {
                if (workDoneProgress) {
                    workDoneProgress
                        .then((progress) => {
                            progress.report(message);
                        })
                        .catch(() => {});
                } else {
                    this.connection.sendNotification('viper/reportProgress', message);
                }
            },
            end: () => {
                displayingProgress = false;
                if (workDoneProgress) {
                    workDoneProgress
                        .then((progress) => {
                            progress.done();
                        })
                        .catch(() => {});
                    workDoneProgress = undefined;
                } else {
                    this.connection.sendNotification('viper/endProgress');
                }
            },
        };
    }

    private _getStringValues(values: any) {
        if (!values || !Array.isArray(values) || values.length === 0) {
            return [];
        }

        return values.filter((p) => p && isString(p)) as string[];
    }
}
