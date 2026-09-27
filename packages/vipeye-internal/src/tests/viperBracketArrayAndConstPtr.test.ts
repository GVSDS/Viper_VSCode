/*
 * viperBracketArrayAndConstPtr.test.ts
 *
 * ① `[SIZE]T` 的 SIZE 是**值表达式**（数组长度），允许任意编译期整型运算：
 *      part_types: [MAX_VOLUMES * MAX_PARTITIONS]uint8
 *      part_lit:   [MAX_VOLUMES * 2]uint8
 *      part_minus: [MAX_VOLUMES - 1]uint8
 *      part_shift: [1 << 3]uint8
 *    回归点（此前两个方向都不通）：
 *      - parser：`_parseViperBracketArrayType` 解析 SIZE 期间 `_isParsingTypeAnnotation`
 *        为真时，`*` 会被 _parseArithmeticTerm 的「注解中停止解析」分支吞掉 →
 *        误报「[ 未关闭」+「类型表达式中不允许使用解包运算符」；
 *      - evaluator：SIZE 里的算术表达式带 TypeExpression 求值 →
 *        误报 binaryOperationNotAllowed（「类型表达式中不允许使用二元运算符」）。
 *    边界：两侧不是整数的运算（如类名相加）仍须报错。
 * ② `const` 指针（如 `lfn: const str` = `CConst | str`）指向只读数据：
 *      解引用**读**允许（`*lfn`、`lfn[0]`）；
 *      解引用**赋值**必须报错（`*lfn = c`、`lfn[i] = c`）；
 *      非 const 指针（`buf: str`）的 `*buf = c` / `buf[i] = c` 仍合法。
 * ③ C 修饰符（CConst / CStatic / CVolatile / CVoid）在迭代 / 解引用路径上
 *    **只是修饰**，跳过即可：`path: const str` 可 `for ch in path:` 迭代，
 *    不再误报「“CConst”不可迭代 / 未定义 __iter__」（判据须认 str / bytes，
 *    不能只认 CPtr，见 viperTypeContainsPointer）。
 *
 * 运行：npx jest src/tests/viperBracketArrayAndConstPtr.test.ts --runInBand
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

    assert(program.getParseResults(uri), 'parse results not found');

    return { program, configOptions, uri, serviceProvider, testDir };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any) {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag: any) => ({
        category: diag.category,
        line: diag.range ? diag.range.start.line + 1 : -1,
        col: diag.range ? diag.range.start.character + 1 : -1,
        message: diag.message as string,
    }));
}

test('[SIZE]T 的 SIZE 支持整型常量运算（乘法/减法/移位/字面量）', () => {
    const code = `import t

MAX_VOLUMES: int = 4
MAX_PARTITIONS: int = 4

class PartTable:
    part_types:       [MAX_VOLUMES * MAX_PARTITIONS]uint8
    part_start_lbas:  [MAX_VOLUMES * MAX_PARTITIONS]uint64
    part_is_fat32:    [MAX_VOLUMES * MAX_PARTITIONS]int
    part_lit:         [MAX_VOLUMES * 2]uint8
    part_minus:       [MAX_VOLUMES - 1]uint8
    part_shift:       [1 << 3]uint8
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(
        code,
        '__viper_bracket_array_expr__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== [SIZE]T 整型运算诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line}:${d.col} [category=${d.category}] ${d.message}`));

        const real = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(
            real.length,
            0,
            `[SIZE]T 的 SIZE 为整型常量运算时不应报错：${JSON.stringify(real)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('类型表达式中的非整型二元运算仍报错（边界）', () => {
    const code = `class C1:
    pass

class C2:
    pass

Bad: C1 + C2 = 0
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(
        code,
        '__viper_type_binop_bound__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 类型表达式非整型运算诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line}:${d.col} [category=${d.category}] ${d.message}`));

        assert(
            diagnostics.some((d) => d.category === 0),
            `类名相加不是整型常量运算，仍应报错：${JSON.stringify(diagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('const 指针：解引用读允许、解引用赋值报错；非 const 指针赋值仍合法', () => {
    const code = `def read_lfn(lfn: const str) -> int:
    return lfn[0]

def deref_read(lfn: const str) -> char:
    return *lfn

def deref_write(lfn: const str) -> None:
    *lfn = char(65)

def mutable_ok(buf: str) -> None:
    *buf = char(65)
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(
        code,
        '__viper_const_ptr_deref__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== const 指针解引用诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line}:${d.col} [category=${d.category}] ${d.message}`));

        const constWriteDiags = diagnostics.filter((d) => d.message.includes('const 指针的解引用赋值'));
        assert.strictEqual(
            constWriteDiags.length,
            1,
            `只应报 1 处 const 解引用赋值错误（*lfn = ...）：${JSON.stringify(diagnostics)}`
        );
        // 报错行应为 `*lfn = char(65)` 所在行（第 8 行）。
        assert.strictEqual(
            constWriteDiags[0].line,
            8,
            `const 解引用赋值错误应落在第 8 行：${JSON.stringify(constWriteDiags)}`
        );

        // 解引用读取 / 非 const 指针赋值不得产生任何 error。
        const otherErrors = diagnostics.filter(
            (d) => d.category === 0 && !d.message.includes('const 指针的解引用赋值')
        );
        assert.strictEqual(
            otherErrors.length,
            0,
            `解引用读 / 非 const 指针赋值不应报错：${JSON.stringify(otherErrors)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('const 指针：下标读允许、下标赋值报错；非 const 指针下标赋值仍合法', () => {
    const code = `def index_read(lfn: const str) -> char:
    return lfn[0]

def index_write(lfn: const str) -> None:
    lfn[0] = char(65)

def mutable_index_ok(buf: str) -> None:
    buf[0] = char(65)
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(
        code,
        '__viper_const_ptr_index__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== const 指针下标诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line}:${d.col} [category=${d.category}] ${d.message}`));

        const constWriteDiags = diagnostics.filter((d) => d.message.includes('const 指针的解引用赋值'));
        assert.strictEqual(
            constWriteDiags.length,
            1,
            `只应报 1 处 const 下标赋值错误（lfn[0] = ...）：${JSON.stringify(diagnostics)}`
        );
        // 报错行应为 `lfn[0] = char(65)` 所在行（第 5 行）。
        assert.strictEqual(
            constWriteDiags[0].line,
            5,
            `const 下标赋值错误应落在第 5 行：${JSON.stringify(constWriteDiags)}`
        );

        const otherErrors = diagnostics.filter(
            (d) => d.category === 0 && !d.message.includes('const 指针的解引用赋值')
        );
        assert.strictEqual(
            otherErrors.length,
            0,
            `下标读 / 非 const 指针下标赋值不应报错：${JSON.stringify(otherErrors)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('const 指针可迭代：for ch in path 不报「不可迭代 / 未定义 __iter__」', () => {
    const code = `import t

def walk(path: const str) -> int:
    count: int = 0
    for ch in path:
        count = count + 1
    return count

def walk_parts(parts: const t.CPtr) -> int:
    total: int = 0
    for p in parts:
        total = total + 1
    return total
`;
    const { program, configOptions, uri, serviceProvider, testDir } = buildProgramForCode(
        code,
        '__viper_const_ptr_iter__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== const 指针迭代诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line}:${d.col} [category=${d.category}] ${d.message}`));

        const notIterableDiags = diagnostics.filter(
            (d) => d.message.includes('不可迭代') || d.message.includes('__iter__')
        );
        assert.strictEqual(
            notIterableDiags.length,
            0,
            `const 指针（const str 等）应可迭代，不应报不可迭代：${JSON.stringify(diagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
