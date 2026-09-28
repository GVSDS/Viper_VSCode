/*
 * viperVtableMethodAssign.test.ts
 *
 * 验证 `obj.method = func` 写入 **virtual class（vtable）方法槽位**时的签名校验
 * （ViperOS devfs.vp 的 `serial0_file.open = serial0_open` 写法）。
 *
 * 背景：编译器（TPC HandlesAssign / TransPyV CallGenVt._write_vtable_slot）只把
 * RHS 函数 bitcast 成 i8* 存进 vtable 槽，**不校验签名与 self**；LSP 若按普通
 * 成员赋值的「绑定方法类型」比较，RHS 显式写的 `self: rawptr` 会被当成多余参数，
 * 误报「参数名称不匹配 / 额外参数 …」。
 *
 * 放行条件（用户口径）：
 *   ① 类是 virtual class，成员是类里声明的方法；
 *   ② RHS 的 self 为泛指针（rawptr / t.CPtr）或该类本身/父类的指针；
 *   ③ 其余参数名称与类型逐个相同、返回类型相同（*args / **kwargs 可有无）。
 *   否则仍按普通赋值报错（非 virtual class、self 非指针、参数/返回不符等）。
 *
 * 运行：npx jest src/tests/viperVtableMethodAssign.test.ts --runInBand
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

    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');

    return { program, configOptions, uri, testDir, serviceProvider };
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

/** 代码里首个包含 snippet 的行号（1-based），用于定位断言。 */
function lineOf(code: string, snippet: string): number {
    return code.split('\n').findIndex((l) => l.includes(snippet)) + 1;
}

const VTABLE_CLASS = `import t

virtual class devfs_file:
    private_data: rawptr

    def open(self, path: const str, flags: int) -> int:
        return 0

    def close(self, fd: int) -> int:
        return 0

    def read(self, fd: int, buffer: rawptr, size: uint32) -> int:
        return 0

    def ioctl(self, fd: int, request: int, arg: rawptr, *args) -> int:
        return 0

    def addref(self, path: const str) -> int:
        return 0

    def exists(self, path: const str) -> int:
        return 0

    def create(self, path: const str) -> int:
        return 0

    def seek(self, fd: int, offset: int) -> int:
        return 0

    def truncate(self, fd: int, size: uint32) -> int:
        return 0

    def mmap(self, fd: int, size: uint32) -> int:
        return 0

serial0_file: devfs_file

def serial0_open(self: rawptr, path: const str, flags: int) -> int:
    return 0

def serial0_close(self: rawptr, fd: int) -> int:
    return 0

def serial0_read(self: rawptr, fd: int, buffer: rawptr, size: uint32) -> int:
    return 0

def ok_varargs(self: rawptr, fd: int, request: int, arg: rawptr) -> int:
    return 0

def ok_class_ptr(self: devfs_file*, path: const str) -> int:
    return 0

def devfs_register_serial0() -> int:
    global serial0_file
    serial0_file = devfs_file()
    serial0_file.open = serial0_open
    serial0_file.close = serial0_close
    serial0_file.read = serial0_read
    serial0_file.ioctl = ok_varargs
    serial0_file.addref = ok_class_ptr
    return 0
`;

test('virtual class（vtable）方法槽位赋值：self 为 rawptr / 本身指针 / *args 不同 → 放行', () => {
    const code = VTABLE_CLASS;
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(code, '__viper_vtable_assign_ok__');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== vtable 槽位赋值（放行）诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        const hard = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(
            hard.length,
            0,
            `devfs 写法（self: rawptr / self: devfs_file* / *args 不同）不应报错：${JSON.stringify(hard)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('virtual class 方法槽位赋值：self 非指针 / 参数类型·名称·个数·返回不符 → 仍报错', () => {
    const code = `${VTABLE_CLASS}
def bad_self(self: int, fd: int, size: uint32) -> int:
    return 0

def bad_param_type(self: rawptr, fd: int, offset: uint32) -> int:
    return 0

def bad_param_name(self: rawptr, fd: int, length: uint32) -> int:
    return 0

def bad_return(self: rawptr, path: const str) -> uint64:
    return 0

def bad_count(self: rawptr, path: const str, flags: int) -> int:
    return 0

def register_bad() -> int:
    global serial0_file
    serial0_file.mmap = bad_self
    serial0_file.seek = bad_param_type
    serial0_file.truncate = bad_param_name
    serial0_file.exists = bad_return
    serial0_file.create = bad_count
    return 0
`;
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(code, '__viper_vtable_assign_bad__');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== vtable 槽位赋值（拒绝）诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        const expectedLines = [
            lineOf(code, 'serial0_file.mmap = bad_self'),
            lineOf(code, 'serial0_file.seek = bad_param_type'),
            lineOf(code, 'serial0_file.truncate = bad_param_name'),
            lineOf(code, 'serial0_file.exists = bad_return'),
            lineOf(code, 'serial0_file.create = bad_count'),
        ];
        const hardLines = Array.from(
            new Set(
                diagnostics
                    .filter((d) => d.category === 0 || d.category === 1)
                    .map((d) => d.line)
            )
        ).sort((a, b) => a - b);
        console.log(`=== 期望报错行 ${JSON.stringify(expectedLines)}，实际 ${JSON.stringify(hardLines)} ===`);
        assert.deepStrictEqual(
            hardLines,
            [...expectedLines].sort((a, b) => a - b),
            `应且仅应报这 5 处：${JSON.stringify(diagnostics.filter((d) => d.category === 0 || d.category === 1))}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('非 virtual class（无 vtable）的方法赋值不受放宽：仍报错', () => {
    const code = `import t

class plain_file:
    def open(self, path: const str, flags: int) -> int:
        return 0

plain: plain_file

def plain_open(self: rawptr, path: const str, flags: int) -> int:
    return 0

def register_plain() -> int:
    global plain
    plain = plain_file()
    plain.open = plain_open
    return 0
`;
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(code, '__viper_vtable_assign_plain__');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 非 virtual class 赋值诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        const targetLine = lineOf(code, 'plain.open = plain_open');
        const hardOnLine = diagnostics.filter(
            (d) => (d.category === 0 || d.category === 1) && d.line === targetLine
        );
        assert(
            hardOnLine.length > 0,
            `非 virtual class 的方法赋值不应被放行（应仍报错）：${JSON.stringify(diagnostics)}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
