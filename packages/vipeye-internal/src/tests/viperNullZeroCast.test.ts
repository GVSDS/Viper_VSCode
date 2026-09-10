/*
 * viperNullZeroCast.test.ts
 *
 * 验证 Viper C 空指针常量（null pointer constant）规则：
 *   - 整数字面量 0 可隐式转换为任意指针（NULL），包括赋值与函数传参
 *   - 其他整数值（含值为 0 的变量）不允许隐式转换为指针，需显式转换
 *   - None 仍允许（空指针）
 *   - 显式转换 t.CInt(addr, t.CPtr) 仍允许
 *
 * 运行：npx jest src/tests/viperNullZeroCast.test.ts --runInBand
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
    const testDir = path.join(__dirname, '__null_zero__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'null_zero.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return { program, configOptions, uri, serviceProvider };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag) => {
        const line = diag.range ? diag.range.start.line + 1 : -1;
        return `[category=${diag.category}][line=${line}] ${diag.message}`;
    });
}

test('整数字面量 0 → Ptr 隐式转换（NULL），其他整数拒绝', () => {
    // 注：带注解的变量声明初始化（p: T = v）遵循 Viper TypeSet 语义，
    // RHS 被声明类型覆盖不单独校验；本测试覆盖会真实触发赋值检查的
    // 重新赋值（p = v）与函数传参（foo(v)）。
    const code = `import t, c

def takes_ptr(p: t.CInt | t.CPtr) -> t.CInt | t.CPtr:
    return p

def test_zero_cast():
    p: t.CInt | t.CPtr = None
    q: t.CInt | t.CPtr = None
    p = 0
    p = 1
    x: t.CInt = 0
    p = x
    takes_ptr(0)
    takes_ptr(1)
    addr: t.CUnsignedLong = 0x1234
    p = addr
    p = t.CInt(addr, t.CPtr)
    takes_ptr(p)
    takes_ptr(q)
`;
    const { program, configOptions, uri, serviceProvider } = buildProgramForCode(code);
    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 允许行：L7/L8 声明 None、L9 重新赋值 0、L13 函数传参 0、L17 显式转换
    for (const okLine of [7, 8, 9, 13, 17]) {
        const errs = diagnostics.filter((d) => d.includes(`[line=${okLine}]`));
        assert.strictEqual(
            errs.length,
            0,
            `L${okLine} 不应报错，实际: ${JSON.stringify(errs)}`
        );
    }

    // 拒绝行：L10 重新赋值 1、L12 变量 x、L14 函数传参 1、L16 地址值变量
    for (const badLine of [10, 12, 14, 16]) {
        const errs = diagnostics.filter((d) => d.includes(`[line=${badLine}]`));
        assert(errs.length > 0, `L${badLine} 应报"仅允许整数字面量 0"错误，实际诊断: ${JSON.stringify(diagnostics)}`);
        const msg = errs[0];
        assert(
            msg.includes('仅允许整数字面量 0'),
            `L${badLine} 错误信息应提示仅允许 0，实际: ${msg}`
        );
    }

    program.dispose();
    serviceProvider.dispose();
});
