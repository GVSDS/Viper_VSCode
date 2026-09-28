/*
 * viperPointerConversion.test.ts
 *
 * 验证 Viper 指针语义（2026-09-28 收紧）：
 *
 * ① 一元 `&` / `*` 的返回类型，且**结果类型参与类型拦截**：
 *      x: T   → `&x` : T*
 *      x: T*  → `*x` : T
 *      x: T*  → `&x` : T**（`a(&x)` 传给 `rawptr`（void*）应判非法）
 *
 * ② 指针 → 指针的隐式转换规则（原先「同级即无条件允许」，现收紧）：
 *      - 级数必须相同；
 *      - pointee 任一侧是 void* / 未定（`rawptr`）→ 允许；
 *      - pointee 相同 → 允许；
 *      - pointee 都是基本类型（数值标量）→ 按 T 的隐式转换规则；
 *      - 结构体（非基本类型）→ 仅允许**同一继承体系内**的转换（上转型 + 下转型），
 *        不相关的结构体、结构体 ↔ 基本类型一律禁止；
 *      - 单级指针 ↔ void*（CVoid）双向允许；多级（如 Node** → void*）禁止。
 *
 * 运行：npx jest src/tests/viperPointerConversion.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { Program } from '../analyzer/program';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { convertOffsetToPosition } from '../common/positionUtils';
import { UnaryOperationNode } from '../parser/parseNodes';
import { OperatorType } from '../parser/tokenizerTypes';

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
    const parseResults = sourceFile.getParseResults();
    assert(parseResults, 'parse results not found');

    return { program, configOptions, uri, testDir, serviceProvider, parseResults };
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

test('一元 & / * 的返回类型正确，且结果类型参与类型拦截', () => {
    const code = `import t

class Node:
    v: uint64

def take_raw(p: rawptr) -> None:
    pass

def addr_of_value(x: Node) -> None:
    p: Node* = &x

def addr_of_ptr(x: Node*) -> None:
    p: Node** = &x

def deref_ptr(x: Node*) -> None:
    v: Node = *x

def bad_pass(x: Node*) -> None:
    take_raw(&x)
`;
    const { program, configOptions, uri, testDir, serviceProvider, parseResults } = buildProgramForCode(
        code,
        '__viper_ptr_unary__'
    );

    try {
        const evaluator = program.evaluator as TypeEvaluator | undefined;
        assert(evaluator, 'evaluator not available');
        const ev = evaluator;

        const unaryOps: { line: number; op: string; type: string }[] = [];
        class UnaryCollector extends ParseTreeWalker {
            override visitUnaryOperation(node: UnaryOperationNode) {
                if (node.d.operator !== OperatorType.Multiply && node.d.operator !== OperatorType.BitwiseAnd) {
                    return true;
                }
                const type = ev.getType(node as any);
                unaryOps.push({
                    line: convertOffsetToPosition(node.start, parseResults.parserOutput.lines).line + 1,
                    op: node.d.operator === OperatorType.Multiply ? '*' : '&',
                    type: type ? program.printType(type) : '(undefined)',
                });
                return true;
            }
        }
        new UnaryCollector().walk(parseResults.parserOutput.parseTree);
        console.log('=== 一元 * / & 节点类型 ===');
        unaryOps.forEach((u) => console.log(`  L${u.line} ${u.op}: ${u.type}`));

        // x: Node  → &x : Node*
        const addrValue = unaryOps.find((u) => u.op === '&' && u.line === 10);
        assert(addrValue, '&x (x: Node) 未找到 (L10)');
        assert.strictEqual(addrValue.type, 'rawptr[Node]', `&x (x: Node) 应为 rawptr[Node]，实际: ${addrValue.type}`);

        // x: Node* → &x : Node**
        const addrPtr = unaryOps.find((u) => u.op === '&' && u.line === 13);
        assert(addrPtr, '&x (x: Node*) 未找到 (L13)');
        assert.strictEqual(
            addrPtr.type,
            'rawptr[rawptr[Node]]',
            `&x (x: Node*) 应为 rawptr[rawptr[Node]]，实际: ${addrPtr.type}`
        );

        // x: Node* → *x : Node
        const deref = unaryOps.find((u) => u.op === '*' && u.line === 16);
        assert(deref, '*x 未找到 (L16)');
        assert.strictEqual(deref.type, 'Node', `*x (x: Node*) 应为 Node，实际: ${deref.type}`);

        // 拦截：`a(&x)`（x: Node* → Node**）传给 rawptr（void*）应判非法
        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(lines, [19], `应且仅应报 L19（&x 的 Node** 传给 void*）：${JSON.stringify(lines)}`);
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('指针隐式转换规则：同级 + pointee 兼容（基本类型 / 结构体 / void* / 多级）', () => {
    const code = `import t

class Node:
    v: uint64

class Other:
    w: uint64

class Sub(Node):
    z: uint64

def take_u64(p: uint64*) -> None:
    pass

def take_u16(p: uint16*) -> None:
    pass

def take_node(p: Node*) -> None:
    pass

def take_other(p: Other*) -> None:
    pass

def take_void(p: t.CVoid) -> None:
    pass

def take_raw(p: rawptr) -> None:
    pass

def basic_ok(p: uint32*) -> None:
    take_u64(p)
    take_u16(p)

def struct_rules(n: Node*, s: Sub*) -> None:
    take_node(n)
    take_other(n)
    take_node(s)
    take_void(n)
    take_raw(n)

def void_source(r: rawptr, v: t.CVoid) -> None:
    take_node(r)
    take_node(v)

def mixed(n: Node*) -> None:
    take_u64(n)

def level_guard(n: Node*) -> None:
    take_void_of(&n)

def take_void_of(p: t.CVoid) -> None:
    pass
`;
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        code,
        '__viper_ptr_convert__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 指针转换诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        // 允许：L31/L32（uint32* → uint64*/uint16*，整数按 T 规则全方向）
        //       L35（Node* → Node*）、L37（Sub* → Node*，上转型）
        //       L38（Node* → void*）、L39（Node* → rawptr）
        //       L42（rawptr → Node*）、L43（CVoid → Node*）
        // 拒绝：L36（Node* → Other*，不相关结构体）
        //       L46（Node* → uint64*，结构体 → 基本类型指针）
        //       L49（Node** → void*，多级指针跨级）
        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [36, 46, 49],
            `应且仅应报 L36（Node*→Other*）、L46（Node*→uint64*）、L49（Node**→void*）：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('同一继承体系内的结构体指针双向转换（上转型 / 下转型），不相关结构体仍拒绝', () => {
    // 下转型的真实依赖：TransPyV/App/lib/core/Gen/Call/CallGenDispatch.vp:824
    //   len_arg_node: ast.AST* = cargs.get(0)
    //   ..._is_list_builtin_receiver(pool, len_val, len_cls_nm, "__len__", len_arg_node)
    //   形参声明为 cl: rawptr[ast.Call]（Call 派生自 AST）
    // Viper 指针运行期不带静态类型（都是 i8*），同一继承体系内的 reinterpret 是
    // 既有代码的常规写法，故 `AST* → Call*`（下转型）与 `Call* → AST*`（上转型）都放行。
    const code = `import t

class AST:
    kind: int

class Call(AST):
    callee: int

class Other:
    w: int

def take_call(cl: rawptr[Call]) -> int:
    return 0

def take_ast(n: rawptr[AST]) -> int:
    return 0

def take_other(o: rawptr[Other]) -> int:
    return 0

def downcast(n: rawptr[AST]) -> int:
    return take_call(n)

def upcast(c: rawptr[Call]) -> int:
    return take_ast(c)

def unrelated(n: rawptr[AST]) -> int:
    return take_other(n)
`;
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        code,
        '__viper_ptr_hierarchy__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 继承体系指针诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        // 允许：L22（AST* → Call*，下转型）、L25（Call* → AST*，上转型）
        // 拒绝：L28（AST* → Other*，不相关结构体）
        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [28],
            `应且仅应报 L28（AST*→Other*，不相关结构体）：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
