/*
 * viperCompletionKeyword.test.ts
 *
 * 验证 Viper 方言专有关键字出现在补全提示里：硬关键字 define / const / volatile，
 * 软关键字 typedef / inline / export / extern / virtual / novirtual / enum / rnum /
 * union / struct，以及 def 别名 fn / fun / func / function。
 * 这些词不在 CPython 关键字表里，若未并入 Keywords 列表则补全时"看不见"。
 *
 * 运行：npx jest src/tests/viperCompletionKeyword.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { CancellationToken, CompletionItemKind, MarkupKind, Position } from 'vscode-languageserver';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { CompletionProvider } from '../languageService/completionProvider';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

/** 期望出现在补全里的 Viper 关键字（硬关键字 + 软关键字 + def 别名）。 */
const ViperKeywords: string[] = [
    'define',
    'const',
    'volatile',
    'typedef',
    'inline',
    'export',
    'extern',
    'virtual',
    'novirtual',
    'enum',
    'rnum',
    'union',
    'struct',
    'fn',
    'fun',
    'func',
    'function',
];

function buildProgramForCode(code: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const projectRoot = UriEx.file(TRANSPYC_INCLUDES);
    const configOptions = new ConfigOptions(projectRoot);
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');

    const execEnv = new ExecutionEnvironment(
        'python',
        projectRoot,
        configOptions.diagnosticRuleSet,
        configOptions.defaultPythonVersion,
        configOptions.defaultPythonPlatform,
        [projectRoot],
        /* skipNativeLibraries */ false,
        /* defaultDialect */ 'viper'
    );
    configOptions.executionEnvironments = [execEnv];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    const fs = require('fs');
    const testDir = path.join(__dirname, '__viper_completion_keyword__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'completion_keyword.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    return { program, configOptions, uri, serviceProvider, testDir };
}

/** 与内置符号同名的关键字：补全里会先命中该符号（如 `class function` 来自
 *  builtins stub），按符号种类提示而非 Keyword，故只校验"能被提示到"。 */
const SymbolCollidingKeywords = new Set(['function']);

test('Viper 补全提示包含 Viper 专有关键字', async () => {
    // 第 2 行（索引 1）是函数体内空语句槽；补全位置取该行缩进之后。
    const code = `def f() -> int:
    
    return 0
`;
    const { program, uri, serviceProvider, testDir } = buildProgramForCode(code);

    try {
        const provider = new CompletionProvider(
            program,
            uri,
            Position.create(1, 4),
            { format: MarkupKind.PlainText, snippet: false, lazyEdit: false },
            CancellationToken.None
        );
        const completions = await provider.getCompletions();
        assert(completions, '补全结果为空');

        const labels: string[] = completions.items.map((item) => item.label);
        console.log(
            `=== 补全项 ${labels.length} 项，Viper 关键字命中 ${
                ViperKeywords.filter((keyword) => labels.indexOf(keyword) >= 0).length
            }/${ViperKeywords.length} ===`
        );

        for (const keyword of ViperKeywords) {
            const index = labels.indexOf(keyword);
            assert(index >= 0, `补全里缺少 Viper 关键字 ${keyword}：${JSON.stringify(labels)}`);
            if (!SymbolCollidingKeywords.has(keyword)) {
                assert.strictEqual(
                    completions.items[index].kind,
                    CompletionItemKind.Keyword,
                    `${keyword} 的 kind 应为 Keyword`
                );
            }
        }
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
