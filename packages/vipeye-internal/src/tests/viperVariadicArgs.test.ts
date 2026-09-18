/*
 * viperVariadicArgs.test.ts
 *
 * 验证 Viper 扩展：`*args` 在函数体内应绑定为 `va_list`（指针），而非 Python 语义的 tuple。
 *
 * 场景：TransPyC/includes/viperlib.vp
 *   def sprintf(buf: t.CChar | t.CPtr, rule: str, *args) -> t.CVoid | t.CExport:
 *       if buf is None or rule is None: return
 *       vsnprintf(buf, 0x7FFFFFFF, rule, args)   # 不应报 tuple 不能赋值给 CPtr[CChar]
 *
 * 同时覆盖 vsprintf / snprintf 内部将 `args` 透传给 vsnprintf 的场景。
 *
 * 运行：npx jest src/tests/viperVariadicArgs.test.ts --runInBand
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

const VIPERLIB_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\viperlib.vp';
const MEMHUB_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\memhub.vp';
const REQUESTS_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\requests\\__init__.vp';
const ARGPARSE_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\argparse.vp';
const TYPES_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\llvmlite\\__types.vp';
const OS_INIT_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\os\\__init__.vp';
const SHA256_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\hashlib\\__sha256.vp';
const SHA512_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\hashlib\\__sha512.vp';
const AST_INIT_PATH = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes\\ast\\__init__.vp';
const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgram(targetPath: string, projectRootPath: string = TRANSPYC_INCLUDES, extraPaths: string[] = []) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const projectRoot = UriEx.file(projectRootPath);
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

test('viperlib.vp 中 *args 透传 vsnprintf 不报 tuple 类型错误', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(VIPERLIB_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 断言：sprintf/vsprintf/snprintf 内部的 `args` 透传（vsnprintf 的 ap 参数）不应报
    // tuple 类型不能赋值给 CPtr 的错误。
    const variadicErrors = diagnostics.filter(
        (d) =>
            d.message.includes('tuple') ||
            d.message.includes('vsnprintf') ||
            d.message.includes('cannot be assigned to parameter "ap"') ||
            d.message.includes('参数 "ap"')
    );
    assert.strictEqual(
        variadicErrors.length,
        0,
        `unexpected variadic arg errors: ${JSON.stringify(variadicErrors)}`
    );

    // va_arg / c.Deref 的误报（stdarg.vp 声明与 Viper 语义不符）也应消除。
    const derefVaArgErrors = diagnostics.filter(
        (d) => d.message.includes('va_arg') || d.message.includes('Deref')
    );
    assert.strictEqual(
        derefVaArgErrors.length,
        0,
        `unexpected va_arg/Deref errors: ${JSON.stringify(derefVaArgErrors)}`
    );

    // 不应有任何 category=0/1 的错误。
    // 唯一允许的已知源码问题：viperlib.vp L13 `return count1` 引用不存在的变量
    // （应为 `return count`，属于 TransPyC 源码自身的拼写错误，LSP 报错正确）。
    const hardErrors = diagnostics.filter((d) => d.category === 0 || d.category === 1);
    const knownSourceIssue = hardErrors.filter(
        (d) => d.range === 'L13' && (d.message.includes('count1') || d.message.includes('未定义'))
    );
    assert.strictEqual(
        hardErrors.length,
        knownSourceIssue.length,
        `unexpected hard errors: ${JSON.stringify(hardErrors)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('memhub.vp 中 viperio.Buf.__sizeof__() 不报 Argument missing for parameter "self"', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(MEMHUB_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // __sizeof__ 是 Viper 的类方法（sizeof(Type) -> int），不需要 self 参数。
    // 命中场景：memhub.vp L109 `self.alloc(viperio.Buf.__sizeof__())`。
    const sizeOfErrors = diagnostics.filter(
        (d) => d.message.includes('__sizeof__') || d.message.includes('parameter "self"')
    );
    assert.strictEqual(
        sizeOfErrors.length,
        0,
        `unexpected __sizeof__ errors: ${JSON.stringify(sizeOfErrors)}`
    );

    // 不应有任何 category=0/1 的错误。
    const hardErrors = diagnostics.filter((d) => d.category === 0 || d.category === 1);
    assert.strictEqual(hardErrors.length, 0, `unexpected hard errors: ${JSON.stringify(hardErrors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('argparse.vp 中 str = None 参数默认值不报类型不兼容（回归）', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(ARGPARSE_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 命中场景：argparse.vp L155-158 `short: str = None` / `help: str = None`。
    // Viper 下 None 是空指针，str 是 i8*，`str = None` 合法且不应展开为 str | None。
    const strNoneErrors = diagnostics.filter(
        (d) => d.message.includes('str') && (d.message.includes('None') || d.message.includes('default'))
    );
    assert.strictEqual(
        strNoneErrors.length,
        0,
        `unexpected str=None errors: ${JSON.stringify(strNoneErrors)}`
    );

    // 不应有任何 category=0/1 的错误。
    const hardErrors = diagnostics.filter((d) => d.category === 0 || d.category === 1);
    assert.strictEqual(hardErrors.length, 0, `unexpected hard errors: ${JSON.stringify(hardErrors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('__types.vp 嵌套类成员 Pointee: LLVMType | t.CPtr 自我引用不被标为 Unknown', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(TYPES_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 命中场景：llvmlite/__types.vp 的 class LLVMType(t.REnum) 中，
    // class Ptr 的成员 Pointee: LLVMType | t.CPtr 引用外层类 LLVMType。
    // 嵌套类成员注解引用外层类名（自我指定）应解析为类类型而非 Unknown。
    const unknownErrors = diagnostics.filter(
        (d) => d.message.includes('Unknown') && d.message.includes('LLVMType')
    );
    assert.strictEqual(
        unknownErrors.length,
        0,
        `unexpected Unknown errors for nested self-ref: ${JSON.stringify(unknownErrors)}`
    );

    // 不应有 TypePrint 参数不匹配（Struct | Unknown）错误。
    const typePrintErrors = diagnostics.filter(
        (d) => d.message.includes('TypePrint') && d.message.includes('Struct')
    );
    assert.strictEqual(
        typePrintErrors.length,
        0,
        `unexpected TypePrint errors: ${JSON.stringify(typePrintErrors)}`
    );

    // REnum 变体构造（LLVMType.Int(1) / LLVMType.Struct(f, c, n)）不报位置参数错误。
    const variantCtorErrors = diagnostics.filter(
        (d) => d.message.includes('位置参数') && d.message.includes('应为 0')
    );
    assert.strictEqual(
        variantCtorErrors.length,
        0,
        `unexpected REnum variant ctor errors: ${JSON.stringify(variantCtorErrors)}`
    );

    // 泛型自引用基类（class ParamNode(GSListNode[ParamNode])）不报未定义。
    const paramNodeErrors = diagnostics.filter((d) => d.message.includes('ParamNode'));
    assert.strictEqual(
        paramNodeErrors.length,
        0,
        `unexpected ParamNode errors: ${JSON.stringify(paramNodeErrors)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('os/__init__.vp 中 os._win32 子模块访问不报未知属性', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(OS_INIT_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 命中场景：os/__init__.vp L6 `import os._win32` 后，L25 `os._win32.exists(path)`。
    // Viper 中 `import os._win32` 应把子模块 _win32 注册为 os 模块的属性。
    const win32Errors = diagnostics.filter(
        (d) => d.message.includes('_win32') && (d.message.includes('known attribute') || d.message.includes('属性'))
    );
    assert.strictEqual(
        win32Errors.length,
        0,
        `unexpected os._win32 errors: ${JSON.stringify(win32Errors)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('requests.vp 中 str = None 默认值不展开为 str | None，无 Optional 误报', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(REQUESTS_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 命中场景：requests/__init__.vp L679 `def post(url: str, data: str = None, ...)`。
    // Viper 下 str 是 i8*（可空指针），None 是空指针，不应展开为 str | None，
    // 否则 data[0] 等下标访问会误报 reportOptionalSubscript。
    const optionalErrors = diagnostics.filter(
        (d) => d.message.includes('OptionalSubscript') || d.message.includes('is not subscriptable')
    );
    assert.strictEqual(
        optionalErrors.length,
        0,
        `unexpected optional subscript errors: ${JSON.stringify(optionalErrors)}`
    );

    // 不应有任何 category=0/1 的错误。
    const hardErrors = diagnostics.filter((d) => d.category === 0 || d.category === 1);
    assert.strictEqual(hardErrors.length, 0, `unexpected hard errors: ${JSON.stringify(hardErrors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('__sha256.vp 中 CArray 传给 CPtr 参数（数组名退化）不报类型错误', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(SHA256_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 命中场景：__sha256.vp L95/100/111 `self.transform(self.buf)`，
    // self.buf 是 `t.CArray[t.CUInt8T, SHA256_BLOCK_LEN]`，transform 的
    // block 参数是 `t.CUInt8T | t.CPtr`（折叠为 CPtr[CUInt8T]）。
    // C 语义下数组名退化为指向首元素的指针，应允许 CArray → CPtr 传参。
    const cptrErrors = diagnostics.filter(
        (d) =>
            d.message.includes('cannot be assigned to parameter "block"') ||
            d.message.includes('参数 "block"') ||
            (d.message.includes('CArray') && (d.message.includes('rawptr') || d.message.includes('CPtr')))
    );
    assert.strictEqual(cptrErrors.length, 0, `unexpected CArray->rawptr errors: ${JSON.stringify(cptrErrors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('__sha512.vp 中 CPtr 传给 CArray 参数（形参调整）不报类型错误', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(SHA512_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 命中场景：__sha512.vp L119 `self.transform(data)`，
    // data 是 `t.CUInt8T | t.CPtr`（折叠为 CPtr[CUInt8T]），transform 的
    // block 参数是 `t.CArray[t.CUInt8T, SHA512_BLOCK_LEN]`。
    // C 语义下函数参数声明为数组时自动调整为指针（parameter adjustment），
    // 应允许 CPtr → CArray 形参传参。
    const cptrErrors = diagnostics.filter(
        (d) =>
            d.message.includes('cannot be assigned to parameter "block"') ||
            d.message.includes('参数 "block"') ||
            (d.message.includes('CArray') && (d.message.includes('rawptr') || d.message.includes('CPtr')))
    );
    assert.strictEqual(cptrErrors.length, 0, `unexpected rawptr->CArray errors: ${JSON.stringify(cptrErrors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('ast/__init__.vp 中派生类实例传给基类指针（Expression→CPtr[AST]）不报类型错误', () => {
    const { program, serviceProvider, uri, configOptions } = buildProgram(AST_INIT_PATH);

    const diagnostics = getDiagnostics(program, configOptions, uri);

    // 命中场景：ast/__init__.vp L105 `return Expression(pool, body)`，
    // Expression 继承自 AST，函数返回类型是 `AST | t.CPtr`（折叠为 CPtr[AST]）。
    // C 语义下派生类指针可隐式 upcast 为基类指针（CPtr[Expression] → CPtr[AST]）。
    const exprErrors = diagnostics.filter(
        (d) => d.message.includes('Expression') && (d.message.includes('返回类型') || d.message.includes('assignable'))
    );
    assert.strictEqual(exprErrors.length, 0, `unexpected Expression->CPtr[AST] errors: ${JSON.stringify(exprErrors)}`);

    program.dispose();
    serviceProvider.dispose();
});

/**
 * 语义 token 辅助：解码 SemanticTokens 相对编码，返回 line 级 token 映射。
 * 返回 Map<line, Array<{start, text, tokenType, tokenModifiers}>>
 */
function getSemanticTokens(program: Program, uri: any): Map<number, any[]> {
    const { SemanticTokenProvider } = require('../languageService/semanticTokenProvider');
    const { LogTracker } = require('../common/logTracker');
    const provider = new SemanticTokenProvider(new LogTracker());
    const result = provider.provideFull(program, uri);
    assert(result, 'no semantic tokens produced');

    const sourceFile = program.getSourceFile(uri);
    const lines = sourceFile!.getParseResults()!.text.split('\n');

    const map = new Map<number, any[]>();
    let cursorLine = 0;
    let cursorChar = 0;
    for (let i = 0; i < result.data.length; i += 5) {
        const deltaLine = result.data[i];
        const deltaStart = result.data[i + 1];
        const length = result.data[i + 2];
        const tokenType = result.data[i + 3];
        const tokenMod = result.data[i + 4];
        cursorLine += deltaLine;
        cursorChar = deltaLine === 0 ? cursorChar + deltaStart : deltaStart;
        const lineText = lines[cursorLine] || '';
        const text = lineText.substring(cursorChar, cursorChar + length);
        const entry = { start: cursorChar, text, tokenType, tokenModifiers: tokenMod };
        if (!map.has(cursorLine)) {
            map.set(cursorLine, []);
        }
        map.get(cursorLine)!.push(entry);
    }
    return map;
}

test('不存在的相对导入 from .visitor import ASTVisitor 标黄且标白（undefined）', () => {
    // 自包含用例：临时包 pkg/__init__.vp 中写 `from .visitor import ASTVisitor`。
    // （原用例指向 ast/__init__.vp，但该 import 已被源码注释掉，断言随之过期。）
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__visitor_undef__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    const pkgDir = path.join(testRoot, 'pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    const filePath = path.join(pkgDir, '__init__.vp');
    fs.writeFileSync(filePath, 'from .visitor import ASTVisitor\n', 'utf8');

    const { program, serviceProvider, uri, configOptions } = buildProgram(filePath, testRoot, [TRANSPYC_INCLUDES]);

    // 1. 诊断：不存在的模块 `.visitor` 应标黄（warning，cat=1=Warning）
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const visitorDiag = diagnostics.find(
        (d) => d.range === 'L1' && d.message.includes('visitor')
    );
    assert(visitorDiag, `expected unresolved '.visitor' diagnostic, got: ${JSON.stringify(diagnostics)}`);
    assert.strictEqual(visitorDiag.category, 1, `expected warning(1) for .visitor, got cat=${visitorDiag.category}`);

    // 2. 语义 token：`visitor` 和 `ASTVisitor` 都应为 undefined（白色，type=11）
    const tokensByLine = getSemanticTokens(program, uri);
    const line1 = tokensByLine.get(0);
    assert(line1, 'expected tokens on line 1');

    const visitorToken = line1.find((t) => t.text === 'visitor');
    assert(visitorToken, 'expected "visitor" token on line 1');
    assert.strictEqual(visitorToken.tokenType, 11, `"visitor" should be undefined(11), got ${visitorToken.tokenType}`);

    const astVisitorToken = line1.find((t) => t.text === 'ASTVisitor');
    assert(astVisitorToken, 'expected "ASTVisitor" token on line 1');
    assert.strictEqual(
        astVisitorToken.tokenType,
        11,
        `"ASTVisitor" should be undefined(11), got ${astVisitorToken.tokenType}`
    );

    program.dispose();
    serviceProvider.dispose();
    fs.rmSync(testRoot, { recursive: true, force: true });
});

/**
 * TransPyV/Test/App 场景：workspace root 是 Test（App 的父目录），
 * App 下的 test_main.vp 通过同目录绝对导入引用各测试模块。
 * Viper 编译时被分析文件所在目录链即搜索根，同目录模块必须可解析。
 */
test('TransPyV/Test/App 中同目录模块绝对导入可解析（from flow_test import flow_test）', () => {
    const testRoot = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\TransPyV\\Test';
    const targetPath = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\TransPyV\\Test\\App\\test_main.vp';
    // 模拟用户配置：includes 作为 extraPaths 提供 stdio/stdint/t/c 等标准库。
    const { program, serviceProvider, uri, configOptions } = buildProgram(targetPath, testRoot, [
        TRANSPYC_INCLUDES,
    ]);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    // 同目录模块（flow_test/asm_test 等）与 includes 标准库必须解析成功。
    // testcheck 是测试脚本真实缺失（App 下只有 testcheck_test.vp），允许报错。
    const missingImports = diagnostics.filter(
        (d) => d.message.includes('无法解析导入') && !d.message.includes('testcheck')
    );
    assert.strictEqual(
        missingImports.length,
        0,
        `unexpected missing import errors: ${JSON.stringify(missingImports)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

/**
 * Viper 语义：`def minus(...) -> None` 编译为返回 i32（隐式 ret i32 0），
 * 其函数指针类型与 `t.Callable[[int, int], int]` 一致。
 * `func_p = minus` 不应报返回类型 None 与 int 不兼容。
 */
test('-> None 函数可赋给返回 int 的 t.Callable（func_p = minus 不报错）', () => {
    const targetPath = path.resolve(__dirname, 'samples', 'viper_callable_none.vp');
    const { program, serviceProvider, uri, configOptions } = buildProgram(targetPath);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const returnMismatch = diagnostics.filter(
        (d) =>
            d.message.includes('返回类型') ||
            d.message.includes('return type') ||
            d.message.includes('不可分配') ||
            d.message.includes('不可分配给') ||
            d.message.includes('incompatible')
    );
    assert.strictEqual(
        returnMismatch.length,
        0,
        `unexpected return type mismatch errors: ${JSON.stringify(returnMismatch)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

/**
 * Viper 语义：`t.CArray[T]` 单参数合法（不定长数组，None 结尾）。
 * t.vpi 中 N 声明 `TypeVar('N', default=None)`，但 stub 的 __class_getitem__
 * 使 N 被推断为合成泛型参数导致标准检查误报"应为 2，但收到 1"。
 */
test('t.CArray[str] 单参数（不定长数组）合法，不报类型参数不足', () => {
    const targetPath = path.resolve(__dirname, 'samples', 'viper_carray_one_arg.vp');
    const { program, serviceProvider, uri, configOptions } = buildProgram(targetPath);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const typeArgErrors = diagnostics.filter(
        (d) =>
            d.message.includes('类型参数') ||
            d.message.includes('type arguments') ||
            d.message.includes('provided for')
    );
    assert.strictEqual(
        typeArgErrors.length,
        0,
        `unexpected type argument errors: ${JSON.stringify(typeArgErrors)}`
    );

    program.dispose();
    serviceProvider.dispose();
});
