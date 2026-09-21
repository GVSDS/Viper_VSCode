/*
 * viperDefineConst.test.ts
 *
 * 验证 Viper 的 `define` 编译期常量声明与整数字面量位宽校验：
 *   - `define NAME: 类型 = 值` / `define NAME = 值`（后者由编译器推导类型大小）；
 *   - `define f(...)`（宏函数，等价 def）不受影响；
 *   - 字面量无法存入声明类型位宽时报错（如 int 为 i32 存不下 10^31），
 *     非 define 的普通声明形式同样报错（类型大小无法正确存储数字，需要扩容）。
 *
 * 运行：npx jest src/tests/viperDefineConst.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { FullAccessHost } from '../common/fullAccessHost';
import { convertOffsetToPosition } from '../common/positionUtils';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FunctionNode, MemberAccessNode } from '../parser/parseNodes';
import { KeywordType } from '../parser/tokenizerTypes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

let testFileIndex = 0;

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
    const testDir = path.join(__dirname, '__define_const__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, `define_const_${testFileIndex++}.vp`);
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

    return { program, configOptions, parseResults, uri, serviceProvider };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag) => {
        const line = diag.range ? diag.range.start.line + 1 : -1;
        return `[category=${diag.category}][line=${line}] ${diag.message}`;
    });
}

test('define NAME: 类型 = 值 / define NAME = 值 解析为普通声明，值大小可存入类型', () => {
    const code = `import t

define MAX_SIZE: int = 1024
define PAGE_SIZE = 4096
define PAGE_BYTES: t.CUInt64T = 18446744073709551615
define SMALL: t.CInt8T = -128
define TINY: t.i8 = 127

def use() -> int:
    a: int = MAX_SIZE
    b: int = PAGE_SIZE
    return a + b
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    // define 常量声明被解析为普通赋值语句（不是函数定义）。
    const functions: number[] = [];
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const lines = parseResults.parserOutput.lines;
    class Collector extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            functions.push(convertOffsetToPosition(node.start, lines).line + 1);
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    assert.deepStrictEqual(functions, [9], `define 常量声明不应被当作函数定义：${JSON.stringify(functions)}`);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));

    const bad = diagnostics.filter((d) => /未定义|undefined|not defined|未使用|no effect|unused|无法正确存储/i.test(d));
    assert.strictEqual(bad.length, 0, `不应报未定义/未使用/位宽错误：${JSON.stringify(diagnostics, undefined, 2)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('define 宏函数（define f(...)）仍解析为函数定义', () => {
    const code = `define square(x: int) -> int:
    return x * x

def use() -> int:
    return square(3)
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const lines = parseResults.parserOutput.lines;
    const functions: { line: number; isDefineKeyword: boolean }[] = [];
    class Collector extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            functions.push({
                line: convertOffsetToPosition(node.start, lines).line + 1,
                isDefineKeyword: (node.d.firstToken as any).keywordType === KeywordType.Define,
            });
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    // L1 的 define 宏函数 + L4 的普通 def 都应解析为函数；只有 define 那个带 isDefine 标记。
    assert.strictEqual(functions.length, 2, `应解析出 2 个函数：${JSON.stringify(functions)}`);
    assert(functions[0].isDefineKeyword, `define 宏函数应保留 define 关键字标记：${JSON.stringify(functions)}`);
    assert(!functions[1].isDefineKeyword, `普通 def 不应带 define 标记：${JSON.stringify(functions)}`);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.includes('category=0') || d.includes('category=1'));
    assert.strictEqual(errors.length, 0, `不应有错误：${JSON.stringify(diagnostics, undefined, 2)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('字面量超出声明类型位宽时报错（define 与普通声明都报）', () => {
    const code = `import t

define BIG_INT: int = 10000000000000000000000000000000
PLAIN_BIG: int = 10000000000000000000000000000000
define SMALL_ENUM: t.CInt8T = 200
define OK_BIG: t.CUInt64T = 18446744073709551615
define OK_NEG: int = -2147483648
define OK_POS: int = 2147483647

def use() -> int:
    return 0
`;
    const { program, configOptions, uri, serviceProvider } = buildProgramForCode(code);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));

    const rangeErrors = diagnostics.filter((d) => d.includes('需要扩容'));
    const errorLines = rangeErrors.map((d) => d.match(/\[line=(\d+)\]/)?.[1]);
    assert.deepStrictEqual(
        errorLines.sort(),
        ['3', '4', '5'],
        `应只在 L3（define 超长）/L4（普通声明超长）/L5（CInt8T 存不下 200）报错：${JSON.stringify(
            diagnostics,
            undefined,
           2
        )}`
    );
    assert(rangeErrors.every((d) => d.includes('10000000000000000000000000000000') || d.includes('200')), JSON.stringify(rangeErrors));

    program.dispose();
    serviceProvider.dispose();
});

test('define 常量与普通常量在引用处类型正确', () => {
    const code = `import t

define MAX_SIZE: int = 1024
define FLAG = 1

def use() -> int:
    a: int = MAX_SIZE
    b: int = FLAG
    return a + b
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const lines = parseResults.parserOutput.lines;
    const types: { line: number; type: string }[] = [];
    class Collector extends ParseTreeWalker {
        override visitMemberAccess(node: MemberAccessNode) {
            return true;
        }
        override visitName(node: any) {
            if (node.d.value === 'MAX_SIZE' || node.d.value === 'FLAG') {
                const type = evaluator!.getType(node);
                types.push({
                    line: convertOffsetToPosition(node.start, lines).line + 1,
                    type: type ? program.printType(type) : '(undefined)',
                });
            }
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    console.log('=== 常量引用类型 ===');
    types.forEach((t) => console.log(`  L${t.line}: ${t.type}`));

    const usageTypes = types.filter((t) => t.line >= 7);
    assert.strictEqual(usageTypes.length, 2, `应收集到 2 处引用：${JSON.stringify(types)}`);
    usageTypes.forEach((t) => {
        assert(!t.type.includes('Unknown') && !t.type.includes('Unbound'), `引用类型不应退化：${JSON.stringify(t)}`);
    });

    program.dispose();
    serviceProvider.dispose();
});
