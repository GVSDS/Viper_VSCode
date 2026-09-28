/*
 * viperREnumPointer.test.ts
 *
 * 验证 REnum（t.REnum tagged-union）指针的隐式转换口径（2026-09-28 修复）。
 *
 * 背景：指针隐式转换收紧为「pointee 必须兼容」后，`rawptr[LLVMType.Ptr]`
 * （REnum 变体指针）与 `rawptr[LLVMType]`（REnum 根指针）被判为不兼容，
 * 导致 llvmlite 的真实写法误报：
 *   - includes/llvmlite/__builder.vp:
 *       def build_load(builder, ty: rawptr[LLVMType], ptr, is_volatile=0) -> rawptr[Value]
 *   - TransPyV/App/lib/core/Gen/Call/CallGenCall.vp 的嵌套 match：
 *       case llvmlite.LLVMType.Ptr(lb_inner):
 *           match lb_inner:
 *               case llvmlite.LLVMType.Ptr(lb_inner2):
 *                   lb_obj = llvmlite.build_load(builder, lb_inner, lb_obj)
 *     内层 match 把 `lb_inner: rawptr[LLVMType]` 收窄成 `rawptr[Ptr]`
 *     （见 patternMatching.narrowTypeBasedOnClassPattern 的 Viper 扩展），
 *     再传回 `rawptr[LLVMType]` 形参即误报。
 *
 * 规则：同一 REnum 家族（根类 ↔ 其 suite 内声明的变体类）之间的指针互转允许
 *      （TransPyV 只 emit bitcast；判定用 fullName 前缀，与 match 收窄口径一致）；
 *      不同变体之间、REnum 与无关结构体之间仍拒绝。
 *
 * 运行：npx jest src/tests/viperREnumPointer.test.ts --runInBand
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

test('REnum 变体指针收窄后传回根指针形参不再误报（llvmlite/CallGenCall 形状）', () => {
    const code = `import t

class IRBuilder:
    pass

class LLVMType(t.REnum):
    class Ptr:
        Pointee: rawptr[LLVMType]

    class Int:
        Bits: int

class Value:
    Ty: rawptr[LLVMType]

def build_load(builder: rawptr[IRBuilder], ty: rawptr[LLVMType], ptr: rawptr[Value]) -> rawptr[Value]:
    return ptr

def f(builder: rawptr[IRBuilder], obj: rawptr[Value]) -> int:
    lb_obj: rawptr[Value] = obj
    if lb_obj is not None and lb_obj.Ty is not None:
        match lb_obj.Ty:
            case LLVMType.Ptr(lb_inner):
                match lb_inner:
                    case LLVMType.Ptr(lb_inner2):
                        lb_obj = build_load(builder, lb_inner, lb_obj)
                    case _:
                        pass
            case _:
                pass
    return 0
`;
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        code,
        '__viper_renum_pointer__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== REnum 家族指针诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [],
            `REnum 变体指针（收窄为 rawptr[Ptr]）传回 rawptr[LLVMType] 形参不应报错：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('REnum 指针转换矩阵：家族内互转允许，跨变体与无关结构体拒绝', () => {
    const code = `import t

class LLVMType(t.REnum):
    class Ptr:
        Pointee: rawptr[LLVMType]

    class Int:
        Bits: int

class Other:
    w: int

def take_root(p: rawptr[LLVMType]) -> None:
    pass

def take_ptr_variant(p: rawptr[LLVMType.Ptr]) -> None:
    pass

def take_int_variant(p: rawptr[LLVMType.Int]) -> None:
    pass

def take_other(p: rawptr[Other]) -> None:
    pass

def variant_to_root(p: rawptr[LLVMType.Ptr]) -> None:
    take_root(p)

def root_to_variant(r: rawptr[LLVMType]) -> None:
    take_ptr_variant(r)

def variant_mismatch(p: rawptr[LLVMType.Ptr], i: rawptr[LLVMType.Int]) -> None:
    take_int_variant(p)
    take_root(i)

def unrelated(p: rawptr[LLVMType.Ptr], o: rawptr[Other]) -> None:
    take_other(p)
    take_root(o)
`;
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        code,
        '__viper_renum_pointer_matrix__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== REnum 指针矩阵诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        // 允许：L26（变体 → 根）、L29（根 → 变体）、L33（Int 变体 → 根）
        // 拒绝：L32（Ptr 变体 → Int 变体，跨变体）
        //       L36（REnum 变体 → 无关结构体 Other）
        //       L37（无关结构体 Other → REnum 根）
        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [32, 36, 37],
            `应且仅应报 L32（跨变体）、L36/L37（与无关结构体互转）：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
