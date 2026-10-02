/*
 * viperMatchBreakFallthrough.test.ts
 *
 * 验证 match-case 内支持**裸 `break`** 与**裸 `fallthrough`**：
 *   - `break`    → 结束整个 match（对齐编译器语义，不再报 breakOutsideLoop）；
 *   - `fallthrough` → case 穿透（软关键字语句）。
 *
 * 背景：TPC/TransPyV 正在支持这两个裸关键字（此前只有 `c.Break()` / `c.NoBreak()`），
 * LSP 侧原先会把 match 内的裸 break 报成 breakOutsideLoop、把裸 fallthrough 当成未定义标识符。
 *
 * 实现要点（仅 LSP）：
 *   ① parser 新增 `_isInMatchCase`，在 `_parseCaseStatement` 解析 case body 期间置位
 *      （与循环的 `_isInLoop` 同法保存/恢复）；
 *   ② `_parseBreakStatement` 判据放宽为 `!_isInLoop && !_isInMatchCase` 才报错；
 *   ③ 新增 `ParseNodeType.Fallthrough` / `FallthroughNode`，parser 里以**软关键字**识别：
 *      仅当①方言为 viper、②处于 case 体内、③后跟行尾/`;`/文件尾 时才是该语句，
 *      其它位置仍是普通标识符（`fallthrough = 1` / `fallthrough()` / `x.fallthrough`）。
 *   ④ binder 把 fallthrough 当作流程终止（其后同 case 体语句不可达）；
 *      flowChartBuilder 把它并入终止语句。
 *
 * 运行：npx jest src/tests/viperMatchBreakFallthrough.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgramForCode(code: string, dirName: string) {
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
    const testDir = path.join(__dirname, dirName);
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'main.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }
    return { program, configOptions, uri, serviceProvider, testDir };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any) {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag: any) => ({
        category: diag.category,
        line: diag.range ? diag.range.start.line + 1 : -1,
        message: diag.message as string,
    }));
}

/** 实际报错（category 0=Error / 1=Warning）所在行集合。 */
function hardErrorLines(program: Program, configOptions: ConfigOptions, uri: any): number[] {
    return Array.from(
        new Set(
            getDiagnostics(program, configOptions, uri)
                .filter((d) => d.category === 0 || d.category === 1)
                .map((d) => d.line)
        )
    ).sort((a, b) => a - b);
}

/** match-case 内裸 break（结束 match）+ 裸 fallthrough（穿透到下一个 case）。 */
const MATCH_CODE = `import t
from stdint import *

def pick(x: int) -> int:
    total: int = 0
    match x:
        case 0:
            total = 1
            break
        case 1:
            total = 2
            fallthrough
        case 2:
            total = 3
            break
        case _:
            total = 4
    return total
`;

/** 反例：case 外的裸 break / 裸 fallthrough 仍应按原有规则报错。 */
const NEGATIVE_CODE = `import t
from stdint import *

def f() -> int:
    break
    return 0

def g() -> int:
    fallthrough
    return 0
`;

test('match-case 内裸 break 与 fallthrough 均不报错', () => {
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        MATCH_CODE,
        '__viper_match_break_fallthrough__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== match break/fallthrough 诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [],
            `case 体内的 break（结束 match）与 fallthrough（case 穿透）都不应报错：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('case 外的裸 break 报 breakOutsideLoop、裸 fallthrough 仍是未定义标识符', () => {
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        NEGATIVE_CODE,
        '__viper_match_break_fallthrough_neg__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== case 外 break/fallthrough 诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        // L5：循环/match 之外的 break 仍报 breakOutsideLoop；
        // L9：case 之外的 fallthrough 不是软关键字语句，按未定义标识符报错。
        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [5, 9],
            `case 外的 break（L5）与 fallthrough（L9）都应报错：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
