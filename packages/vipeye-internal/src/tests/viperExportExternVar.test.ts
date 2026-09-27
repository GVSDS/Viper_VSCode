/*
 * viperExportExternVar.test.ts
 *
 * 验证 Viper 的 `export` / `extern` **变量**声明（仅 LSP 侧实现，TPC/TPV 不动）：
 *   ① `export NAME: T [= v]` —— 注解脱糖为 `T | t.CExport`（与 TPC
 *      includes/ast/parser.vp `_parse_export_extern_var` 同形：定义端**裸名**，
 *      不加模块 SHA1 头），**允许**初始值；
 *   ② `extern NAME: T` —— 注解脱糖为 `T | t.State`（= t.CExtern | t.CExport：
 *      仅声明 + 裸名），**不允许**初始值：`extern a: int = 1` 报错；
 *   ③ 与函数形态（`export def f()` / `export f(...)`）由第三个 token 区分：
 *      `:` 是变量，`(` / `[` 是函数；函数形态逐字不变。
 *   ④ 存储类标记只作修饰：`export gdt: [7]gdt_entry = []` 的 `gdt[i].field`
 *      仍能解析出元素类型（`[]` 零初始化不报类型错误），
 *      展示为前缀限定符（`export CArray[gdt_entry, 7]` / `extern int`）。
 *
 * 运行：npx jest src/tests/viperExportExternVar.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { Program } from '../analyzer/program';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { IndexNode, NameNode, ParseNodeType, TypeAnnotationNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

function buildProgram(code: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__viper_export_extern__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const filePath = path.join(testRoot, 'main.vp');
    fs.writeFileSync(filePath, code, 'utf8');

    const projectRoot = UriEx.file(testRoot);
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

    const uri = UriEx.file(filePath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    return { program, configOptions, uri, serviceProvider, testRoot };
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

/** 按名字收集模块级变量的展示类型（printType 走 typePrinter，与 hover 一致）。 */
function collectVarTypes(program: Program, uri: any): Map<string, string> {
    const sourceFile = program.getSourceFile(uri);
    const parseResults = program.getParseResults(uri);
    assert(parseResults, 'parse results not found');
    const evaluator = program.evaluator!;
    const result = new Map<string, string>();

    class Collector extends ParseTreeWalker {
        override visitName(node: NameNode): boolean {
            const parent = node.parent;
            if (parent?.nodeType === ParseNodeType.TypeAnnotation && (parent as TypeAnnotationNode).d.valueExpr === node) {
                const type = evaluator.getType(node);
                if (type && !result.has(node.d.value)) {
                    result.set(node.d.value, program.printType(type));
                }
            }
            return true;
        }
        override visitIndex(node: IndexNode): boolean {
            const type = evaluator.getType(node);
            const text = sourceFile!.getParseResults()!.text.substr(node.start, node.length);
            if (text.startsWith('gdt[') || text.startsWith('ext_str[')) {
                result.set(text, type ? program.printType(type) : '(undefined)');
            }
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    return result;
}

test('export 变量声明：允许初始值，元素访问/展示均正常', () => {
    const code = `import t

class gdt_entry:
    limit_low:  uint16
    base_low:   uint16
    base_mid:   uint8
    access:     uint8
    flags:      uint8
    base_high:  uint8

export gdt: [7]gdt_entry = []
export tss_buf: [104]uint8
export counter: int = 3

def touch() -> uint8:
    gdt[1].access = 0x92
    return gdt[0].access
`;
    const { program, configOptions, uri, serviceProvider, testRoot } = buildProgram(code);

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== export 变量诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const real = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(real.length, 0, `export 变量声明不应报错：${JSON.stringify(real)}`);

        const types = collectVarTypes(program, uri);
        console.log('=== 变量类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));

        // 存储类标记按前缀限定符展示（与 static int 同一机制）
        assert.strictEqual(types.get('counter'), 'export int', `counter 应展示为 export int`);
        assert(
            types.get('gdt') === 'export CArray[gdt_entry, 7]' ||
                types.get('gdt')?.startsWith('export CArray[gdt_entry'),
            `gdt 应展示为 export CArray[gdt_entry, 7]，实际: ${types.get('gdt')}`
        );
        // 元素访问解析出元素类型（CArray 快路径，联合形态也生效）
        assert.strictEqual(types.get('gdt[0]'), 'gdt_entry', `gdt[0] 应为 gdt_entry`);
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('extern 变量声明：不带初始值合法，展示为 extern 前缀', () => {
    const code = `import t

extern ext_flag: int
extern ext_str: str
extern ext_ptr: t.CPtr

def touch() -> char:
    return ext_str[0]
`;
    const { program, configOptions, uri, serviceProvider, testRoot } = buildProgram(code);

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== extern 变量诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const real = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(real.length, 0, `extern 变量声明（不带初始值）不应报错：${JSON.stringify(real)}`);

        const types = collectVarTypes(program, uri);
        console.log('=== 变量类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));

        assert.strictEqual(types.get('ext_flag'), 'extern int', `ext_flag 应展示为 extern int`);
        assert.strictEqual(types.get('ext_str'), 'extern str', `ext_str 应展示为 extern str`);
        // `extern ext_ptr: t.CPtr`：CPtr 是裸指针模板，不能被修饰符折叠成 CPtr[State]
        assert(
            types.get('ext_ptr')?.startsWith('extern rawptr'),
            `ext_ptr 应展示为 extern rawptr[...]，实际: ${types.get('ext_ptr')}`
        );
        assert.strictEqual(types.get('ext_str[0]'), 'char', `ext_str[0] 应为 char`);
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('extern 变量声明带初始值报错（符号定义在外部）', () => {
    const { program, configOptions, uri, serviceProvider, testRoot } = buildProgram('extern a: int = 1\n');

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== extern 带初始值诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const target = diagnostics.filter((d) => d.message.includes('extern 变量声明不能带初始值'));
        assert.strictEqual(
            target.length,
            1,
            `extern a: int = 1 应报 1 条「不能带初始值」：${JSON.stringify(diagnostics)}`
        );
        assert.strictEqual(target[0].category, 0, `应为 error：${JSON.stringify(target[0])}`);
        assert.strictEqual(target[0].line, 1, `报错应落在第 1 行：${JSON.stringify(target[0])}`);
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});

test('export/extern 函数形态不受影响（第三个 token 为 ( / [）', () => {
    const code = `export def published(x: int) -> int:
    return x

extern def external_fn(x: int) -> int

export direct_decl(x: int) -> int

def touch() -> int:
    return published(1) + external_fn(2) + direct_decl(3)
`;
    const { program, configOptions, uri, serviceProvider, testRoot } = buildProgram(code);

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== export/extern 函数形态诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const real = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(real.length, 0, `export/extern 函数声明不应报错：${JSON.stringify(real)}`);
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testRoot, { recursive: true, force: true });
    }
});
