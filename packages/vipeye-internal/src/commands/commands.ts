/*
 * commands.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Command identifier strings.
 */

export const enum Commands {
    createTypeStub = 'viper.createtypestub',
    restartServer = 'viper.restartserver',
    orderImports = 'viper.organizeimports',
    unusedImport = 'viper.unusedImport',
    dumpFileDebugInfo = 'viper.dumpFileDebugInfo',
    dumpTokens = 'viper.dumpTokens',
    dumpNodes = 'viper.dumpNodes',
    dumpTypes = 'viper.dumpTypes',
    dumpCachedTypes = 'viper.dumpCachedTypes',
    dumpCodeFlowGraph = 'viper.dumpCodeFlowGraph',
}
