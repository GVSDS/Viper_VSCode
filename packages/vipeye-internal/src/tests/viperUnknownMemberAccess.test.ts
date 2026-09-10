/*
 * viperUnknownMemberAccess.test.ts
 *
 * 验证 Viper 的"对象可能未定义"（viperUnknownMemberAccess）诊断：
 *   - 仅对"最终" Unknown（isIncomplete=false，如 import 解析失败）报错；
 *   - 对分析中间态 Unknown（isIncomplete=true，如循环 import 中方法 self
 *     绑定尚未收敛）不报错，避免误报。
 *
 * 回归场景：TransPyC StructGenMixin.get_mro_chain（L1358）内 `self.find_struct(cur)`，
 * 其 self 参数在循环 import（StructGenMixin ⇄ Generator）分析早期为
 * Unknown(incomplete)，收敛后为 Self@StructGenMixin。含 App 搜索根时不得报错；
 * 缺 App 搜索根（Generator.vp import 失败）时 `self.Gen.StructGen.find_struct`
 * 应正常报"对象可能未定义"。
 *
 * 运行：npx jest src/tests/viperUnknownMemberAccess.test.ts --runInBand
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
import { Uri } from '../common/uri/uri';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';
const TPV_APP = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\TransPyV\\App';
const STRUCT_GEN_MIXIN =
    'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\TransPyV\\App\\lib\\core\\Gen\\StructGenMixin.vp';
const ASSIGN_GEN_MIXIN =
    'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\TransPyV\\App\\lib\\core\\Gen\\AssignGenMixin.vp';

function buildProgram(targetPath: string, extraPaths: string[]) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const projectRoot = UriEx.file(path.dirname(targetPath));
    const configOptions = new ConfigOptions(projectRoot);
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');

    const execEnv = new ExecutionEnvironment(
        'python',
        projectRoot,
        configOptions.diagnosticRuleSet,
        configOptions.defaultPythonVersion,
        configOptions.defaultPythonPlatform,
        [projectRoot, ...extraPaths.map((p) => UriEx.file(p))],
        /* skipNativeLibraries */ false,
        /* defaultDialect */ 'viper'
    );
    configOptions.executionEnvironments = [execEnv];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    const uri = UriEx.file(targetPath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    return { program, configOptions, uri, serviceProvider };
}

function getFindStructDiags(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || [])
        .filter((d) => d.message.includes('find_struct'))
        .map((d) => {
            const line = d.range ? d.range.start.line + 1 : -1;
            return `[category=${d.category}][line=${line}] ${d.message}`;
        });
}

test('循环 import 中间态 Unknown（isIncomplete）不报"对象可能未定义"', () => {
    // 含 App 搜索根：Generator.vp import 全部解析成功，self 收敛为 Self@StructGenMixin，
    // get_mro_chain 内 self.find_struct（L1358）不得误报。
    const { program, configOptions, uri, serviceProvider } = buildProgram(STRUCT_GEN_MIXIN, [
        TRANSPYC_INCLUDES,
        TPV_APP,
    ]);

    const findStructDiags = getFindStructDiags(program, configOptions, uri);
    console.log('=== 含 App 根: find_struct 诊断 ===');
    findStructDiags.forEach((d) => console.log(`  ${d}`));
    assert.strictEqual(
        findStructDiags.length,
        0,
        `self.find_struct should not report on incomplete Unknown: ${JSON.stringify(findStructDiags)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('import 解析失败的最终 Unknown 仍报"对象可能未定义"', () => {
    // 缺 App 搜索根：Generator.vp 的 lib.core.* import 失败 → self.Gen 链为最终
    // Unknown（isIncomplete=false）→ self.Gen.StructGen.find_struct 应报错（真实问题）。
    const { program, configOptions, uri, serviceProvider } = buildProgram(ASSIGN_GEN_MIXIN, [TRANSPYC_INCLUDES]);

    const findStructDiags = getFindStructDiags(program, configOptions, uri);
    console.log('=== 缺 App 根: find_struct 诊断 ===');
    findStructDiags.forEach((d) => console.log(`  ${d}`));
    assert(
        findStructDiags.length >= 3,
        `final Unknown should report find_struct errors: ${JSON.stringify(findStructDiags)}`
    );
    assert(
        findStructDiags.every((d) => d.includes('对象可能未定义')),
        `find_struct errors should be viperUnknownMemberAccess: ${JSON.stringify(findStructDiags)}`
    );

    program.dispose();
    serviceProvider.dispose();
});
