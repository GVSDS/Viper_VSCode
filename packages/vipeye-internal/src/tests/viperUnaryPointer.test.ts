/*
 * viperUnaryPointer.test.ts
 *
 * 验证 Viper 一元 '*'（解引用）与 '&'（取地址）运算符，与 C 语义一致：
 *   - `&x`：取地址，返回指向 x 的指针（`X | t.CPtr` 化简为 CPtr[X]）
 *   - `*p`：解引用，返回 p 指向的目标类型
 *   - 非指针解引用报错
 *
 * 以及 C 指针类型注解语法（Viper 方言）：
 *   - `p: T*`     → CPtr[T]
 *   - `p: T**`    → CPtr[CPtr[T]]
 *   - `p: T***`   → CPtr[CPtr[CPtr[T]]]
 *
 * 运行：npx jest src/tests/viperUnaryPointer.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { convertOffsetToPosition } from '../common/positionUtils';
import {
    AssignmentNode,
    BinaryOperationNode,
    CallNode,
    FunctionNode,
    IndexNode,
    ParameterNode,
    ParseNodeType,
    TypeAnnotationNode,
    UnaryOperationNode,
} from '../parser/parseNodes';
import { Type } from '../analyzer/types';
import { OperatorType } from '../parser/tokenizerTypes';

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
    const testDir = path.join(__dirname, '__unary_ptr__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'unary_ptr.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    const parseResults = sourceFile.getParseResults();
    assert(parseResults, 'parse results not found');

    return { program, configOptions, parseResults, uri, testDir, serviceProvider };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag) => {
        const line = diag.range ? diag.range.start.line + 1 : -1;
        return `[category=${diag.category}][line=${line}] ${diag.message}`;
    });
}

test('Viper 一元 * 解引用 / & 取地址 类型求值', () => {
    const code = `import t, c

class MyStruct():
    a: t.CInt
    b: t.CInt

def test_addr(x: t.CInt):
    # &x 返回指向 x 的指针：CPtr[CInt]
    p: t.CInt | t.CPtr = &x
    y: t.CInt = *p

def test_struct_ptr(s: MyStruct):
    # &s 返回指向 MyStruct 的指针，解引用后可访问成员
    p: MyStruct | t.CPtr = &s
    a: t.CInt = (*p).a
    b: t.CInt = p.a

def test_bad_deref(x: t.CInt):
    # 非指针解引用：应报错
    y: t.CInt = *x
`;
    const { program, configOptions, parseResults, uri, testDir, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    // 收集所有一元运算节点（* / &）的类型
    const unaryOps: { line: number; op: string; type: string }[] = [];
    class UnaryCollector extends ParseTreeWalker {
        override visitUnaryOperation(node: UnaryOperationNode) {
            if (node.d.operator !== OperatorType.Multiply && node.d.operator !== OperatorType.BitwiseAnd) {
                return true;
            }
            const op = node.d.operator === OperatorType.Multiply ? '*' : '&';
            const type = ev.getType(node as any);
            unaryOps.push({
                line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                op,
                type: type ? program.printType(type) : '(undefined)',
            });
            return true;
        }
    }
    new UnaryCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== 一元 * / & 节点类型 ===');
    unaryOps.forEach((u) => console.log(`  L${u.line} ${u.op}: ${u.type}`));

    // 断言 1：&x 返回 CPtr[CInt]（L9 p 的 RHS）
    const addrOf = unaryOps.find((u) => u.op === '&' && u.line === 9);
    assert(addrOf, '&x not found (L9)');
    assert(addrOf.type.includes('CInt'), `&x type should contain CInt: ${addrOf.type}`);

    // 断言 2：*p 解引用返回 CInt（L10）
    const derefL10 = unaryOps.find((u) => u.op === '*' && u.line === 10);
    assert(derefL10, '*p not found (L10)');
    assert(derefL10.type.includes('CInt'), `*p should resolve to CInt: ${derefL10.type}`);

    // 断言 3：(*p).a 解引用结构体（L15）
    const derefL15 = unaryOps.find((u) => u.op === '*' && u.line === 15);
    assert(derefL15, '(*p) not found (L15)');
    assert(derefL15.type.includes('MyStruct'), `(*p) should be MyStruct: ${derefL15.type}`);

    // 断言 4：非指针解引用 *x 报错（L20）
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const badDerefErrors = diagnostics.filter((d) => d.includes('line=20') && d.includes('*'));
    console.log('=== L20 诊断 ===');
    diagnostics.filter((d) => d.includes('line=20')).forEach((d) => console.log(`  ${d}`));
    assert(badDerefErrors.length > 0, `*x (non-pointer) should report error: ${JSON.stringify(diagnostics)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('Viper 指针类型注解 T* / T** / T*** 类型求值', () => {
    const code = `import t, c

class MyStruct():
    a: t.CInt
    b: t.CInt

p1: t.CInt*
p2: t.CInt**
p3: t.CInt***

sp: MyStruct*
v: t.CInt = sp.a

def test_interop(x: t.CInt):
    q: t.CInt* = &x
    v: t.CInt = *q

def test_double_deref(pp: t.CInt**):
    v: t.CInt = *(*pp)

def make_ptr(x: t.CInt) -> t.CInt*:
    return &x
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    // 收集所有类型注解（变量注解 / 参数注解 / 返回类型）的类型
    const anns: { line: number; type: string }[] = [];
    const collect = (node: any) => {
        const t = ev.getTypeOfAnnotation(node);
        anns.push({
            line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
            type: t ? program.printType(t) : '(undefined)',
        });
    };
    class AnnCollector extends ParseTreeWalker {
        override visitTypeAnnotation(node: TypeAnnotationNode) {
            collect(node.d.annotation);
            return true;
        }
        override visitParameter(node: ParameterNode) {
            if (node.d.annotation) {
                collect(node.d.annotation);
            }
            return true;
        }
        override visitFunction(node: FunctionNode) {
            if (node.d.returnAnnotation) {
                collect(node.d.returnAnnotation);
            }
            return true;
        }
    }
    new AnnCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== 指针类型注解类型 ===');
    anns.forEach((a) => console.log(`  L${a.line}: ${a.type}`));

    // T* → CPtr[CInt]（L7）
    const p1 = anns.find((a) => a.line === 7);
    assert(p1, 'p1 annotation not found (L7)');
    assert(p1.type.includes('rawptr[CInt]'), `p1 should be rawptr[CInt]: ${p1.type}`);

    // T** → rawptr[rawptr[CInt]]（L8）
    const p2 = anns.find((a) => a.line === 8);
    assert(p2, 'p2 annotation not found (L8)');
    assert(p2.type.includes('rawptr[rawptr[CInt]]'), `p2 should be rawptr[rawptr[CInt]]: ${p2.type}`);

    // T*** → rawptr[rawptr[rawptr[CInt]]]（L9）
    const p3 = anns.find((a) => a.line === 9);
    assert(p3, 'p3 annotation not found (L9)');
    assert(p3.type.includes('rawptr[rawptr[rawptr[CInt]]]'), `p3 should be rawptr[rawptr[rawptr[CInt]]]: ${p3.type}`);

    // 结构体指针 MyStruct* → rawptr[MyStruct]（L11）
    const sp = anns.find((a) => a.line === 11);
    assert(sp, 'sp annotation not found (L11)');
    assert(sp.type.includes('rawptr[MyStruct]'), `sp should be rawptr[MyStruct]: ${sp.type}`);

    // 参数 q: t.CInt*（L15）
    const q = anns.find((a) => a.line === 15);
    assert(q, 'q annotation not found (L15)');
    assert(q.type.includes('rawptr[CInt]'), `q should be rawptr[CInt]: ${q.type}`);

    // 参数 pp: t.CInt**（L18）
    const pp = anns.find((a) => a.line === 18);
    assert(pp, 'pp annotation not found (L18)');
    assert(pp.type.includes('rawptr[rawptr[CInt]]'), `pp should be rawptr[rawptr[CInt]]: ${pp.type}`);

    // 返回类型 -> t.CInt*（L21）
    const ret = anns.find((a) => a.line === 21);
    assert(ret, 'return annotation not found (L21)');
    assert(ret.type.includes('rawptr[CInt]'), `return should be rawptr[CInt]: ${ret.type}`);

    // 不得有任何 Error 类别诊断（指针类型注解不应产生错误）
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.includes('category=0'));
    console.log('=== 错误诊断 ===');
    errors.forEach((d) => console.log(`  ${d}`));
    assert(errors.length === 0, `pointer type annotations should produce no errors: ${JSON.stringify(errors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('Viper 无空格 T* = 赋值：词法 `*=`/`**=` 拆分为指针后缀 + 赋值号', () => {
    const code = `import t, c

def main() -> int:
    x: int = 42
    px: int*=&x
    ppx: int**=&px
    d: int = *px
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    const anns: { line: number; type: string }[] = [];
    class AnnCollector extends ParseTreeWalker {
        override visitTypeAnnotation(node: TypeAnnotationNode) {
            const t = ev.getTypeOfAnnotation(node.d.annotation);
            anns.push({
                line: convertOffsetToPosition(node.d.annotation.start, parseResults.parserOutput.lines).line + 1,
                type: t ? program.printType(t) : '(undefined)',
            });
            return true;
        }
    }
    new AnnCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== 无空格 *=/ **= 注解类型 ===');
    anns.forEach((a) => console.log(`  L${a.line}: ${a.type}`));

    // L5: px: int*=&x → rawptr[int]；L6: ppx: int**=&px → rawptr[rawptr[int]]
    const px = anns.find((a) => a.line === 5);
    assert(px, 'px annotation not found (L5)');
    assert(px.type.includes('rawptr[int]'), `px should be rawptr[int]: ${px.type}`);
    const ppx = anns.find((a) => a.line === 6);
    assert(ppx, 'ppx annotation not found (L6)');
    assert(ppx.type.includes('rawptr[rawptr[int]]'), `ppx should be rawptr[rawptr[int]]: ${ppx.type}`);

    // 不得有 Error 类别诊断（含内部错误）
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.includes('category=0'));
    console.log('=== 错误诊断 ===');
    errors.forEach((d) => console.log(`  ${d}`));
    assert(errors.length === 0, `no-space star-assign should produce no errors: ${JSON.stringify(errors)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('Viper 下标实参内指针后缀 + 外层指针：list[ast.AST*]* 不误报「[ 未关闭」', () => {
    const code = `import t, c
import ast

class Holder:
    ch_r: list[ast.AST*]*
    direct: rawptr[ast.AST]
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    const anns: { line: number; type: string }[] = [];
    let directType: Type | undefined;
    let chRType: Type | undefined;
    class AnnCollector extends ParseTreeWalker {
        override visitTypeAnnotation(node: TypeAnnotationNode) {
            const line = convertOffsetToPosition(node.d.annotation.start, parseResults.parserOutput.lines).line + 1;
            const t = ev.getTypeOfAnnotation(node.d.annotation);
            if (line === 5) {
                chRType = t;
            } else if (line === 6) {
                directType = t;
            }
            anns.push({
                line,
                type: t ? program.printType(t) : '(undefined)',
            });
            return true;
        }
    }
    new AnnCollector().walk(parseResults.parserOutput.parseTree);

    // L5: ch_r: list[ast.AST*]* → rawptr[list[rawptr[AST]]]
    const chR = anns.find((a) => a.line === 5);
    assert(chR, 'ch_r annotation not found (L5)');
    assert(
        chR.type.includes('rawptr[list[rawptr['),
        `ch_r should be rawptr[list[rawptr[AST]]]: ${chR.type}`
    );

    // L6: direct: rawptr[ast.AST] → rawptr[AST]（rawptr 由 builtins.vpi 存根声明，
    // 不得报「"rawptr" 未定义」）
    const direct = anns.find((a) => a.line === 6);
    assert(direct, 'direct annotation not found (L6)');
    assert(direct.type.includes('rawptr[AST]'), `direct should be rawptr[AST]: ${direct.type}`);

    // LSP 展示形态（hover）：sourceQualifiedNames → 按源码书写的完整 module 路径显示。
    // 源码写 `rawptr[ast.AST]`，故展示 `rawptr[ast.AST]`；源码写裸名 `list`，故仍是 `list`。
    assert(directType, 'direct type not captured (L6)');
    const directDisplay = program.printType(directType!, { sourceQualifiedNames: true });
    console.log(`=== LSP 展示形态 L6 direct: ${directDisplay}`);
    assert.strictEqual(directDisplay, 'rawptr[ast.AST]', `direct 应保留源码 module 路径: ${directDisplay}`);

    assert(chRType, 'ch_r type not captured (L5)');
    const chRDisplay = program.printType(chRType!, { sourceQualifiedNames: true });
    console.log(`=== LSP 展示形态 L5 ch_r: ${chRDisplay}`);
    assert.strictEqual(
        chRDisplay,
        'rawptr[list[rawptr[ast.AST]]]',
        `ch_r 应保留源码 module 路径且裸名 list 保持短名: ${chRDisplay}`
    );

    // 不得出现「"[" 未关闭」「rawptr 未定义」等错误（category=0 = Error）
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.includes('category=0'));
    assert(errors.length === 0, `list[ast.AST*]* should parse without errors: ${JSON.stringify(errors)}`);
    assert(
        !diagnostics.some((d) => d.includes('rawptr') && d.includes('未定义')),
        `rawptr should resolve from builtins.vpi: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

test('Viper 解引用赋值：*p = value（联合形式与 T* 形式）', () => {
    const code = `import t, c

def main() -> int:
    x: int = 42
    px: int | t.CPtr = &x
    *px = 100
    y: int = *px
    pz: int* = &x
    *pz = 7
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    const anns: { line: number; type: string }[] = [];
    class AnnCollector extends ParseTreeWalker {
        override visitTypeAnnotation(node: TypeAnnotationNode) {
            const t = ev.getTypeOfAnnotation(node.d.annotation);
            anns.push({
                line: convertOffsetToPosition(node.d.annotation.start, parseResults.parserOutput.lines).line + 1,
                type: t ? program.printType(t) : '(undefined)',
            });
            return true;
        }
    }
    new AnnCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== 解引用赋值 注解类型 ===');
    anns.forEach((a) => console.log(`  L${a.line}: ${a.type}`));

    // L5: px: int | t.CPtr → rawptr[int]（联合折叠）；L8: pz: int* → rawptr[int]
    const px = anns.find((a) => a.line === 5);
    assert(px, 'px annotation not found (L5)');
    assert(px.type.includes('rawptr[int]'), `px should fold to rawptr[int]: ${px.type}`);
    const pz = anns.find((a) => a.line === 8);
    assert(pz, 'pz annotation not found (L8)');
    assert(pz.type.includes('rawptr[int]'), `pz should be rawptr[int]: ${pz.type}`);

    // *px = 100（L6）与 *pz = 7（L8）不得报"表达式不能是赋值目标"；
    // y: int = *px 解引用右值赋值兼容。
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.includes('category=0'));
    console.log('=== 错误诊断 ===');
    errors.forEach((d) => console.log(`  ${d}`));
    assert(errors.length === 0, `deref assignment should produce no errors: ${JSON.stringify(errors)}`);
    assert(
        !diagnostics.some((d) => d.includes('赋值目标')),
        `deref should not report assignment target error: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

// Viper：str / bytes 都是 C 的 char*（i8*），`*s` 取首字符，类型为 char（i8）。
// 修复「类型 "str" 不支持运算符 "*"」（reportOperatorIssue）。
test('Viper 解引用 str/bytes 返回 char', () => {
    const code = `import t

def test_str_deref(fmt: str) -> int:
    c: char = *fmt
    *fmt = c
    return 0

def test_bytes_deref(buf: bytes) -> int:
    ch: char = *buf
    *buf = ch
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    const derefs: { line: number; type: string }[] = [];
    class UnaryCollector extends ParseTreeWalker {
        override visitUnaryOperation(node: UnaryOperationNode) {
            if (node.d.operator !== OperatorType.Multiply) {
                return true;
            }
            const type = ev.getType(node as any);
            derefs.push({
                line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                type: type ? program.printType(type) : '(undefined)',
            });
            return true;
        }
    }
    new UnaryCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== str/bytes 解引用类型 ===');
    derefs.forEach((d) => console.log(`  L${d.line}: ${d.type}`));

    // L4/L5: *fmt（读 / 写目标，fmt: str，即 i8*）→ char
    for (const line of [4, 5]) {
        const deref = derefs.find((d) => d.line === line);
        assert(deref, `*fmt not found (L${line})`);
        assert.strictEqual(deref.type, 'char', `*fmt (L${line}) 应为 char，实际: ${deref.type}`);
    }

    // L9/L10: *buf（读 / 写目标，buf: bytes，即 i8*）→ char
    for (const line of [9, 10]) {
        const deref = derefs.find((d) => d.line === line);
        assert(deref, `*buf not found (L${line})`);
        assert.strictEqual(deref.type, 'char', `*buf (L${line}) 应为 char，实际: ${deref.type}`);
    }

    // 不得报「类型 "str" / "bytes" 不支持运算符 "*"」
    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));
    assert(
        !diagnostics.some((d) => d.includes('不支持运算符')),
        `str/bytes 解引用不应报运算符错误: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

// Viper：三种 C 风格类型强转写法（指针类型 + 裸值/括号值），与既有调用式强转并存。
//   形式 2：(T*)x        —— 括号内指针类型 + 裸值     → CPtr[T]
//   形式 3：(T*)(x)      —— 括号内指针类型 + 括号值   → CPtr[T]
//   形式 1：T*(x)        —— 指针类型 + 括号值（与乘法歧义，靠左操作数为类型对象消解）
// 三者结果类型均为指针形态 CPtr[CInt]（打印为 rawptr[CInt]）。
// 对照组：既有强转 `(t.CInt)(x)`、`(t.CInt | t.CPtr)(x)`，以及真实乘法不受影响。
test('Viper 三种 C 风格强转 (T*)x / (T*)(x) / T*(x)', () => {
    const code = `import t

def f(ptr_raw: t.CUInt64T, offset: uint64) -> int:
    d = (t.CInt)(ptr_raw)
    a = (t.CInt*)offset
    b = (t.CInt*)(offset)
    c = t.CInt*(offset)
    p: t.CInt | t.CPtr = (t.CInt | t.CPtr)(ptr_raw)
    m: int = offset * 2
    n: int = 2 * 3
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    // 收集赋值右值的类型（d/a/b/c 均为无注解赋值，m/n 为带注解赋值）
    const rhsTypes: { line: number; type: string }[] = [];
    class RhsCollector extends ParseTreeWalker {
        override visitAssignment(node: AssignmentNode) {
            const line = convertOffsetToPosition(node.d.rightExpr.start, parseResults.parserOutput.lines).line + 1;
            const type = ev.getType(node.d.rightExpr);
            rhsTypes.push({ line, type: type ? program.printType(type) : '(undefined)' });
            return true;
        }
    }
    new RhsCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== 强转赋值右值类型 ===');
    rhsTypes.forEach((r) => console.log(`  L${r.line}: ${r.type}`));

    // 形式 2/3/1（L5/L6/L7）：均为指针形态且包含 CInt（rawptr[CInt]）
    for (const line of [5, 6, 7]) {
        const entry = rhsTypes.find((r) => r.line === line);
        assert(entry, `强转右值类型未找到 (L${line})`);
        assert(
            entry.type.includes('rawptr') && entry.type.includes('CInt'),
            `L${line} 应为指针形态且包含 CInt: ${entry.type}`
        );
    }

    // 对照组（L4）：既有调用式强转 `(t.CInt)(ptr_raw)` → CInt
    const dType = rhsTypes.find((r) => r.line === 4);
    assert(dType, 'd 类型未找到 (L4)');
    assert(dType.type.includes('CInt'), `d 应包含 CInt: ${dType.type}`);

    // 对照组的真实乘法：L9 offset * 2、L10 2 * 3 —— 不得被当作强转（不是指针形态）
    for (const line of [9, 10]) {
        const entry = rhsTypes.find((r) => r.line === line);
        assert(entry, `乘法右值类型未找到 (L${line})`);
        assert(!entry.type.includes('rawptr'), `L${line} 是真实乘法，不应为指针类型: ${entry.type}`);
    }

    // 全部写法不得有 category=0（错误）/ category=1（警告）诊断
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errorsAndWarnings = diagnostics.filter((d) => d.includes('category=0') || d.includes('category=1'));
    console.log('=== 错误/警告诊断 ===');
    errorsAndWarnings.forEach((d) => console.log(`  ${d}`));
    assert(
        errorsAndWarnings.length === 0,
        `三种强转写法不应产生错误/警告: ${JSON.stringify(errorsAndWarnings)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

// Viper：`(T)x` 强转（括号内普通类型名 + 裸值），语义 = 调用形式 `T(x)` 的强转结果。
// 与已支持的 `(T)(x)` 调用式强转对照；真实乘法 `(a)*b` / `(a) * (b)` 不受影响。
test('Viper (T)x 强转：括号内普通类型名 + 裸值', () => {
    const code = `import t

def f(ptr_raw: t.CUInt64T, offset: uint64, v: t.CUInt8T) -> int:
    d = (t.CInt)(ptr_raw)
    e = (t.CInt)offset
    g = (t.CUInt8T)v
    m: int = offset * 2
    n: int = (offset) * 2
    k: int = (offset)*2
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    const rhsTypes: { line: number; type: string }[] = [];
    class RhsCollector extends ParseTreeWalker {
        override visitAssignment(node: AssignmentNode) {
            const line = convertOffsetToPosition(node.d.rightExpr.start, parseResults.parserOutput.lines).line + 1;
            const type = ev.getType(node.d.rightExpr);
            rhsTypes.push({ line, type: type ? program.printType(type) : '(undefined)' });
            return true;
        }
    }
    new RhsCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== (T)x 强转赋值右值类型 ===');
    rhsTypes.forEach((r) => console.log(`  L${r.line}: ${r.type}`));

    // L4 对照：既有调用式强转 `(t.CInt)(ptr_raw)` → CInt
    const dType = rhsTypes.find((r) => r.line === 4);
    assert(dType, 'd 类型未找到 (L4)');
    assert(dType.type.includes('CInt'), `(t.CInt)(ptr_raw) 应含 CInt: ${dType.type}`);

    // L5：`(t.CInt)offset` → CInt（普通类型名 + 裸值）
    const eType = rhsTypes.find((r) => r.line === 5);
    assert(eType, 'e 类型未找到 (L5)');
    assert(
        eType.type.includes('CInt') && !eType.type.includes('rawptr'),
        `(t.CInt)offset 应为 CInt: ${eType.type}`
    );

    // L6：`(t.CUInt8T)v` → CUInt8T
    const gType = rhsTypes.find((r) => r.line === 6);
    assert(gType, 'g 类型未找到 (L6)');
    assert(gType.type.includes('CUInt8T'), `(t.CUInt8T)v 应为 CUInt8T: ${gType.type}`);

    // L7/L8/L9：真实乘法（含 `(offset) * 2`、`(offset)*2`）→ 非指针形态
    for (const line of [7, 8, 9]) {
        const entry = rhsTypes.find((r) => r.line === line);
        assert(entry, `乘法右值类型未找到 (L${line})`);
        assert(!entry.type.includes('rawptr'), `L${line} 是真实乘法，不应为指针类型: ${entry.type}`);
    }

    // 全部写法不得有 category=0（错误）/ category=1（警告）诊断
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errorsAndWarnings = diagnostics.filter((d) => d.includes('category=0') || d.includes('category=1'));
    console.log('=== 错误/警告诊断 ===');
    errorsAndWarnings.forEach((d) => console.log(`  ${d}`));
    assert(
        errorsAndWarnings.length === 0,
        `(T)x 强转不应产生错误/警告: ${JSON.stringify(errorsAndWarnings)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

// Viper：`(T)x` 强转的判定边界。
//   - `(xs)[0]`：'[' 非操作数起点 → 仍是下标（Name 形式）；
//   - `(t.CInt*)[0]`：'[' 非操作数起点 → 仍是指针类型后缀 + 下标，不被吞成强转；
//   - `(a)*b` / `(a) * (b)`：'*' 非操作数起点 → 仍是乘法；
//   - `(a)b`：归一为调用 `a(b)`（可接受的超集；值为类型即强转，否则语义层报「不可调用」）。
test('Viper (T)x 强转边界：(T*)[i] 仍为下标、乘法不受影响', () => {
    const code = `import t

def f(a: t.CInt, b: t.CInt, xs: list[int]) -> int:
    s: int = (xs)[0]
    idx0 = (t.CInt*)[0]
    m: t.CInt = (a)*b
    n: t.CInt = (a) * (b)
    w = (a)b
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const indexes: { line: number; leftIsPtrSuffix: boolean; leftIsName: boolean }[] = [];
    const binOps: { line: number; isMultiply: boolean }[] = [];
    const calls: { line: number; funcIsNameA: boolean }[] = [];
    class ShapeCollector extends ParseTreeWalker {
        override visitIndex(node: IndexNode) {
            indexes.push({
                line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                leftIsPtrSuffix:
                    node.d.leftExpr.nodeType === ParseNodeType.UnaryOperation &&
                    !!(node.d.leftExpr as UnaryOperationNode).d.isViperPointerTypeSuffix,
                leftIsName: node.d.leftExpr.nodeType === ParseNodeType.Name,
            });
            return true;
        }
        override visitBinaryOperation(node: BinaryOperationNode) {
            binOps.push({
                line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                isMultiply: node.d.operator === OperatorType.Multiply,
            });
            return true;
        }
        override visitCall(node: CallNode) {
            calls.push({
                line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                funcIsNameA:
                    node.d.leftExpr.nodeType === ParseNodeType.Name && node.d.leftExpr.d.value === 'a',
            });
            return true;
        }
    }
    new ShapeCollector().walk(parseResults.parserOutput.parseTree);

    console.log('=== (T)x 边界节点形状 ===');
    indexes.forEach((i) => console.log(`  L${i.line} Index: ptrSuffix=${i.leftIsPtrSuffix} name=${i.leftIsName}`));
    binOps.forEach((b) => console.log(`  L${b.line} Binary: multiply=${b.isMultiply}`));
    calls.forEach((c) => console.log(`  L${c.line} Call: funcIsNameA=${c.funcIsNameA}`));

    // L4 `(xs)[0]`：下标，左值为 Name（未被强转吞掉）
    const sIdx = indexes.find((i) => i.line === 4);
    assert(sIdx, '(xs)[0] 不是下标 (L4)');
    assert(sIdx.leftIsName, `(xs)[0] 左值应为 Name (L4)`);

    // L5 `(t.CInt*)[0]`：下标，左值为指针类型后缀（未被强转吞掉）
    const ptrIdx = indexes.find((i) => i.line === 5);
    assert(ptrIdx, '(t.CInt*)[0] 不是下标 (L5)');
    assert(ptrIdx.leftIsPtrSuffix, `(t.CInt*)[0] 左值应保留指针类型后缀 (L5)`);

    // L6/L7 乘法
    for (const line of [6, 7]) {
        const op = binOps.find((b) => b.line === line);
        assert(op, `乘法未找到 (L${line})`);
        assert(op.isMultiply, `L${line} 应为乘法`);
    }

    // L8 `(a)b` → 调用 a(b)
    const wCall = calls.find((c) => c.line === 8);
    assert(wCall, '(a)b 未归一为调用 (L8)');
    assert(wCall.funcIsNameA, `(a)b 的 callee 应为 a (L8)`);

    // 解析层不得出现语法错误（如「语句必须用换行符或分号分隔」）
    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));
    assert(
        !diagnostics.some((d) => d.includes('换行符') || d.includes('分号') || d.includes('未关闭')),
        `(T)x 边界不应产生语法错误: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
});

// Viper：str / bytes 的 C 指针语义 —— 指针算术（p ± n、n + p）与下标访问（s[i]）。
test('Viper str/bytes 指针算术与下标', () => {
    const code = `import t

def test_str_arith(fmt: str) -> int:
    p1: str = fmt + 1
    p2: str = fmt - 1
    p3: str = 1 + fmt
    c1: char = fmt[0]
    p4: str = fmt + c1
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;

    const binOps: { line: number; op: string; type: string }[] = [];
    const indexTypes: { line: number; type: string }[] = [];
    class BinaryCollector extends ParseTreeWalker {
        override visitBinaryOperation(node: BinaryOperationNode) {
            if (node.d.operator !== OperatorType.Add && node.d.operator !== OperatorType.Subtract) {
                return true;
            }
            const type = ev.getType(node as any);
            binOps.push({
                line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                op: node.d.operator === OperatorType.Add ? '+' : '-',
                type: type ? program.printType(type) : '(undefined)',
            });
            return true;
        }
        override visitIndex(node: IndexNode) {
            const type = ev.getType(node as any);
            indexTypes.push({
                line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                type: type ? program.printType(type) : '(undefined)',
            });
            return true;
        }
    }
    console.log('=== str 指针算术 / 下标类型 ===');
    new BinaryCollector().walk(parseResults.parserOutput.parseTree);
    binOps.forEach((b) => console.log(`  L${b.line} ${b.op}: ${b.type}`));
    indexTypes.forEach((i) => console.log(`  L${i.line} [i]: ${i.type}`));

    // L4/L5/L6：fmt + 1 / fmt - 1 / 1 + fmt → str（指针类型不变）
    for (const line of [4, 5, 6]) {
        const op = binOps.find((b) => b.line === line);
        assert(op, `指针算术未找到 (L${line})`);
        assert.strictEqual(op.type, 'str', `指针算术结果应为 str (L${line})，实际: ${op.type}`);
    }

    // L7：fmt[0] → char（与 `*fmt` 解引用统一为同一元素类型）
    const subscript = indexTypes.find((i) => i.line === 7);
    assert(subscript, `下标访问未找到 (L7)`);
    assert.strictEqual(subscript.type, 'char', `fmt[0] 应为 char，实际: ${subscript.type}`);
    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));
    assert(
        !diagnostics.some((d) => d.includes('不支持运算符')),
        `str 指针算术/下标不应报运算符错误: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
});
