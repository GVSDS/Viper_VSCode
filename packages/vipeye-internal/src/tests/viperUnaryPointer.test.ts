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
import { FunctionNode, ParameterNode, TypeAnnotationNode, UnaryOperationNode } from '../parser/parseNodes';
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
