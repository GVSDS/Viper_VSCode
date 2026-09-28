/*
 * viperGenericBound.test.ts
 *
 * 验证泛型类型参数**带界**声明 `class GSList[T: GSListNode]:` 的支持
 * （TPC 侧 includes/ast/parser.vp 只「跳过」bound，LSP 侧则利用它做成员解析）。
 *
 * 背景：`includes/linkedlist.vp` 的 GSList 泛型链表，append 里对 `node: T` 的成员
 * 访问与赋值都依赖 T 的上界 GSListNode：
 *     novirtual class GSListNode[T]:
 *         Next: T*
 *     novirtual class GSList[T: GSListNode]:
 *         Head: T*
 *         Tail: T*
 *         def append(self, node: T):
 *             node.Next = None          # ① CPtr[T] 解引用查成员
 *             self.Head = node          # ② T 值 → T*（泛型类型参数取地址）
 *             self.Tail.Next = node     # ①②叠加
 *
 * 修复（三段，缺一不可）：
 *   ① `typeEvaluator` 的 CPtr 解引用（成员访问 / 属性覆盖 / 下标）把 pointee 的
 *      TypeVar 具体化为其上界，否则 `self.Tail.Next` 报「属性"Next"未知」；
 *   ② `assignType` 新增「泛型类型参数值 → CPtr[T]」放行（与「类实例 → CPtr[T]」
 *      同源：Viper 中类类型的值本身就是指针），覆盖 `self.Head = node`；
 *   ③ 未特化泛型基类上解析出的成员类型退化成 `CPtr[type]`（指向 builtins.type
 *      实例，即"某个类对象"）时按「指针目标未知」放行，覆盖 `self.Tail.Next = node`。
 *
 * 运行：npx jest src/tests/viperGenericBound.test.ts --runInBand
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

/** GSList 泛型链表（linkedlist.vp 的形状）；boundDecl 决定 T 是否带上界。 */
function buildCode(boundDecl: string): string {
    return `import t
from stdint import *

novirtual class GSListNode[T]:
    Next: T*

novirtual class GSList[${boundDecl}]:
    Head: T*
    Tail: T*
    Count: sizet

    def __init__(self):
        self.Head = None
        self.Tail = None
        self.Count = 0

    def append(self, node: T):
        if node is None:
            return
        node.Next = None
        if self.Head is None:
            self.Head = node
        else:
            self.Tail.Next = node
        self.Tail = node
        self.Count += 1

class GNode(GSListNode[GNode]):
    value: int

def use() -> None:
    lst: GSList[GNode] = GSList[GNode]()
    n: GNode = GNode()
    lst.append(n)
`;
}

test('泛型类型参数带界：`class GSList[T: GSListNode]` 的成员访问与赋值 0 报错', () => {
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        buildCode('T: GSListNode'),
        '__viper_generic_bound__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 泛型带界诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [],
            `T 带界 GSListNode 后，node.Next / self.Head = node / self.Tail.Next = node 都不应报错：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('无界的泛型类型参数仍报「属性未知」（带界才是修复手段）', () => {
    const { program, configOptions, uri, testDir, serviceProvider } = buildProgramForCode(
        buildCode('T'),
        '__viper_generic_bound_none__'
    );

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== 泛型无界诊断 ===');
        diagnostics
            .filter((d) => d.category === 0 || d.category === 1)
            .forEach((d) => console.log(`  L${d.line} [cat=${d.category}] ${d.message}`));

        // L20（node.Next = None）与 L24（self.Tail.Next = node）：无界 T 的成员
        // 退化为 object，找不到 Next，仍应报错。
        const lines = hardErrorLines(program, configOptions, uri);
        console.log('=== 报错行 ===');
        lines.forEach((l) => console.log(`  L${l}`));
        assert.deepStrictEqual(
            lines,
            [20, 24],
            `无界 T 的成员访问应报 L20/L24（Next 未知）：${JSON.stringify(
                diagnostics.filter((d) => d.category === 0 || d.category === 1)
            )}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
