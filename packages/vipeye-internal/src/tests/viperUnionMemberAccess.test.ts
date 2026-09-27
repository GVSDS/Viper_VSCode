/*
 * viperUnionMemberAccess.test.ts
 *
 * 验证 Viper 扩展：联合类型 `MemBuddy | CPtr` 的变量访问成员方法（如 realloc）
 * 不应报 "Cannot access attribute for class UnionType"。
 *
 * 场景：TransPyC/Test/BuddyTest/App/mbuddytest.vp
 *   bd3: memhub.MemBuddy | CPtr = memhub.MemBuddy(arena3, 4096)
 *   rp2: bytes = bd3.realloc(rp, 128)
 *
 * 同时覆盖 `with memhub.MemBuddy(...) as wbd:` 上下文管理器场景：
 *   - @t.CVTable 装饰的 MemManager 类必须解析为 type[MemManager] 而非 Type
 *   - __enter__ 返回 'MemManager' | t.CPtr 折叠为 CPtr[MemManager]
 *   - wbd.alloc / bd3.realloc 成员访问不报 Unknown
 *
 * 运行：npx jest src/tests/viperUnionMemberAccess.test.ts --runInBand
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

// 允许 vipershed-fallback（t.vpi/c.vpi 存根）被定位。
(global as any).__rootDirectory = path.resolve();

const BUDDY_TEST = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\Test\\BuddyTest\\App\\mbuddytest.vp';
const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgram(targetPath: string) {
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

    const uri = UriEx.file(targetPath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环直到分析完成
    }

    return { program, serviceProvider, uri, configOptions };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): any[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag) => ({
        category: diag.category,
        message: diag.message,
        range: diag.range ? `L${diag.range.start.line + 1}` : '(no range)',
    }));
}

test('BuddyTest 联合类型变量访问 realloc/alloc 成员不报 UnionType/Unknown 错误', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(BUDDY_TEST);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 断言：联合类型 `MemBuddy | CPtr` 的成员访问（realloc/alloc/__enter__/__exit__）无错误。
    const unionErrors = diagnostics.filter(
        (d) =>
            d.message.includes('UnionType') ||
            d.message.includes('realloc') ||
            d.message.includes('alloc') ||
            d.message.includes('__enter__') ||
            d.message.includes('__exit__') ||
            d.message.includes('不能与 "with" 一起使用')
    );
    assert.strictEqual(
        unionErrors.length,
        0,
        `unexpected union/member access errors: ${JSON.stringify(unionErrors)}`
    );

    // 排除合理的既有告警（未使用的 import/变量），不应有 category=0/1 的其它错误。
    // 唯一允许的已知源码问题：mbuddytest.vp L209 引用了 MemBuddy 不存在的属性 "mem"
    // （应为 base，属于 TransPyC 测试源码自身的问题，LSP 报错是正确的）。
    const hardErrors = diagnostics.filter((d) => d.category === 0 || d.category === 1);
    const knownSourceIssue = hardErrors.filter((d) => d.range === 'L209' && d.message.includes('mem'));
    assert.strictEqual(
        hardErrors.length,
        knownSourceIssue.length,
        `unexpected hard errors: ${JSON.stringify(hardErrors)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

// Viper：`X | t.CPtr` 折叠出的指针级数。
// 背景（用户报的误报）：`HANDLE = VOIDPTR = t.CPtr`（void*），CreatePipe 的
// `hReadPipe: HANDLE | t.CPtr` 语义上是 HANDLE*（void**）。但两侧在类型层同形
// （都是 type[CPtr[Unknown]]），原先被并成一级指针 → `&stdout_read`（void**）
// 传参被误报"跨级指针隐式转换不允许"。
// 本用例锁定：左操作数已是指针时按"包一层指针"折叠；同时真实跨级错误必须照报。
test('Viper `X | t.CPtr`：左操作数已是指针时折成二级指针（HANDLE | t.CPtr = void**）', () => {
    const code = `import t
from stdint import *
import w32.win32base
import w32.win32file

extern def TakeHandlePtr(h: w32.win32base.HANDLE | t.CPtr) -> BOOL
extern def TakeStructPtr(s: w32.win32base.SECURITY_ATTRIBUTES | t.CPtr) -> BOOL
extern def TakeVoidPtr(p: t.CVoid | t.CPtr) -> BOOL
extern def TakeStrPtr(s: str | t.CPtr) -> BOOL

def types_ok(handle: w32.win32base.HANDLE, sa: w32.win32base.SECURITY_ATTRIBUTES, text: str) -> int:
    # HANDLE | t.CPtr = void**：&handle（void**）应接受
    TakeHandlePtr(&handle)
    # 结构体 | t.CPtr = 结构体*：&sa 应接受
    TakeStructPtr(&sa)
    # CVoid | t.CPtr = void*：&sa（一级）应接受
    TakeVoidPtr(&sa)
    # str | t.CPtr = i8**：&text（i8**）应接受
    TakeStrPtr(&text)
    return 0

def level_mismatch_still_reported(handle: w32.win32base.HANDLE) -> int:
    # void** 传 void*：真实跨级错误必须照报
    TakeVoidPtr(&handle)
    return 0

def create_pipe(capture_output: BOOL, sa: w32.win32base.SECURITY_ATTRIBUTES) -> int:
    stdout_read: w32.win32base.HANDLE = None
    stdout_write: w32.win32base.HANDLE = None
    if capture_output:
        pipe_result: BOOL = w32.win32file.CreatePipe(&stdout_read, &stdout_write, &sa, 0)
    return 0
`;

    const fs = require('fs');
    const testDir = path.join(__dirname, '__viper_union_ptr_level__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'ptr_level.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    try {
        const { program, serviceProvider, uri, configOptions } = buildProgram(testFile);
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== ptr_level.vp diagnostics ===');
        diagnostics.forEach((d) => console.log(`  ${d.range} [category=${d.category}] ${d.message}`));

        const errors = diagnostics.filter((d) => d.category === 0);
        const levelErrors = errors.filter((d) => d.message.includes('跨级指针'));
        const callErrors = errors.filter((d) => d.message.includes('CreatePipe') || d.message.includes('TakeHandlePtr')
            || d.message.includes('TakeStructPtr') || d.message.includes('TakeStrPtr'));

        // 唯一允许的错误：level_mismatch_still_reported 里 `TakeVoidPtr(&handle)` 的跨级错误。
        assert.strictEqual(
            levelErrors.length,
            1,
            `应且仅应报 1 处跨级指针错误（void** → void*）：${JSON.stringify(errors)}`
        );
        assert.strictEqual(callErrors.length, 0, `不应有参数类型误报：${JSON.stringify(callErrors)}`);

        program.dispose();
        serviceProvider.dispose();
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});
