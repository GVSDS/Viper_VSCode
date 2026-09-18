/*
 * sourceFile.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Unit tests for viper sourceFile module.
 */
import * as assert from 'assert';

import { ImportResolver } from '../analyzer/importResolver';
import { SourceFile } from '../analyzer/sourceFile';
import { ConfigOptions, getBasicDiagnosticRuleSet } from '../common/configOptions';
import { FullAccessHost } from '../common/fullAccessHost';
import { combinePaths } from '../common/pathUtils';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { Uri } from '../common/uri/uri';
import { parseAndGetTestState } from './harness/fourslash/testState';

test('Empty', () => {
    const filePath = combinePaths(process.cwd(), 'tests/samples/test_file1.py');
    const tempFile = new RealTempFile();
    const fs = createFromRealFileSystem(tempFile);
    const serviceProvider = createServiceProvider(tempFile, fs);
    const sourceFile = new SourceFile(serviceProvider, Uri.file(filePath, serviceProvider), () => '', false, false, {
        isEditMode: false,
    });
    const configOptions = new ConfigOptions(Uri.file(process.cwd(), serviceProvider));
    const sp = createServiceProvider(fs);
    const importResolver = new ImportResolver(sp, configOptions, new FullAccessHost(sp));

    sourceFile.parse(configOptions, importResolver);
    serviceProvider.dispose();
});

test('SourceFile setInitialDiagnosticRuleSet overrides default', () => {
    const filePath = combinePaths(process.cwd(), 'tests/samples/test_file1.py');
    const tempFile = new RealTempFile();
    const fs = createFromRealFileSystem(tempFile);
    const serviceProvider = createServiceProvider(tempFile, fs);

    // Viper 模式默认关闭 reportPrivateImportUsage（无 PEP 561 / py.typed 私有导入概念）。
    const basicRuleSet = getBasicDiagnosticRuleSet();
    assert.strictEqual(basicRuleSet.reportPrivateImportUsage, 'none');

    // 用与默认不同的 level（'error'）验证 setInitialDiagnosticRuleSet 确实把规则集应用到了文件上。
    const overriddenRuleSet = { ...basicRuleSet, reportPrivateImportUsage: 'error' as const };

    const sourceFile = new SourceFile(serviceProvider, Uri.file(filePath, serviceProvider), () => '', false, false, {
        isEditMode: false,
    });

    // Call setInitialDiagnosticRuleSet to apply config-level overrides.
    sourceFile.setInitialDiagnosticRuleSet(overriddenRuleSet);

    assert.strictEqual((sourceFile as any)._diagnosticRuleSet.reportPrivateImportUsage, 'error');

    assert.ok(sourceFile);
    serviceProvider.dispose();
});

test('Empty Open file', () => {
    const code = `
// @filename: test.py
//// [|/*marker*/# Content|]
    `;

    const state = parseAndGetTestState(code).state;
    const marker = state.getMarkerByName('marker');

    assert.strictEqual(
        state.workspace.service.test_program.getSourceFile(marker.fileUri)?.getFileContent(),
        '# Content'
    );

    state.workspace.service.updateOpenFileContents(marker.fileUri, 1, '');
    assert.strictEqual(state.workspace.service.test_program.getSourceFile(marker.fileUri)?.getFileContent(), '');
});

test('No unexpected user files', () => {
    const code = `
// @filename: viperconfig.json
//// {
////   "pythonVersion": "3.14"
//// }

// @filename: test.vp
//// [|/*marker*/x: int = 1|]
    `;

    const state = parseAndGetTestState(code).state;
    const marker = state.getMarkerByName('marker');
    while (state.workspace.service.test_program.analyze());

    const userFiles = state.workspace.service.test_program.getUserFiles();
    assert.strictEqual(userFiles.length, 1);
    assert.strictEqual(userFiles[0].uri.toString(), marker.fileUri.toString());
});
