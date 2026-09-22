/*
 * viperBracketArrayType.test.ts
 *
 * 验证 Viper 定长数组类型新语法 `[SIZE]T`（等价 t.CArray[T, SIZE]）与
 * 不定长写法 `[]T`（等价 t.CArray[T]）：
 *   - 注解类型与对应的 t.CArray[...] 完全一致（打印结果字符串相同）
 *   - 支持多维嵌套 `[2][3]T`、指针元素 `[4]T*`、t.CDefine 常量长度 `[BUF]T`
 *   - 不再产生"List 表达式"/"语句必须用换行符或分号分隔"等误报
 *   - 语义高亮不出现 undefined（合成 t / CArray 为零长度名字，不参与高亮）
 *
 * 运行：npx jest src/tests/viperBracketArrayType.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';
import { CancellationToken, MarkupContent, MarkupKind, Position } from 'vscode-languageserver';

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
import { HoverProvider } from '../languageService/hoverProvider';
import { SemanticTokenTypes } from '../languageService/semanticTokenTypes';
import { FunctionNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__bracket_array_type__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const filePath = path.join(testRoot, 'main.vp');
    fs.writeFileSync(filePath, source, 'utf8');

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
        [],
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

    const sourceFile = program.getSourceFile(uri);
    const parseResults = sourceFile!.getParseResults();
    return { program, configOptions, parseResults, uri, serviceProvider };
}

function cleanup(program: Program, serviceProvider: any) {
    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__bracket_array_type__'), { recursive: true, force: true });
}

// 收集函数第一个参数注解的打印类型（展开类型别名）
function collectFirstParamTypes(program: Program, parseResults: any): Map<string, string> {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    const ev = evaluator;
    const result = new Map<string, string>();

    class ParamCollector extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            const firstParam = node.d.params[0];
            const ann = (firstParam as any)?.d?.annotation;
            if (ann) {
                const type = ev.getType(ann as any);
                result.set(node.d.name.d.value, type ? program.printType(type, { expandTypeAlias: true }) : '(undefined)');
            }
            return true;
        }
    }
    new ParamCollector().walk(parseResults!.parserOutput.parseTree);
    return result;
}

const SOURCE = `import t

BUF: t.CDefine = 8

def fa(x: [4]t.CInt) -> t.CInt:
    return x[0]

def fb(x: t.CArray[t.CInt, 4]) -> t.CInt:
    return x[0]

def fc(x: []t.CInt) -> t.CInt:
    return x[0]

def fd(x: t.CArray[t.CInt]) -> t.CInt:
    return x[0]

def fe(x: [2][3]t.CInt) -> t.CInt:
    return x[0][0]

def ff(x: [4]int) -> int:
    return x[0]

def fg(x: [BUF]t.CInt) -> t.CInt:
    return x[0]

def fh(x: [4]t.CInt*) -> t.CInt:
    return x[0][0]

def fi(x: t.Callable[[], t.CInt]) -> t.CInt:
    return 0

def fj(x: [4]t.CArray[t.CInt, 2]) -> t.CInt:
    return x[0][0]

def fk(x: list[[4]int]) -> int:
    return x[0][0]

def fl(x: list[[2][3]int]) -> int:
    return x[0][0][0]

def fm(x: t.Callable[[int, str], t.CInt]) -> t.CInt:
    return 0

def fn(x: list[t.CArray[int, 4]]) -> int:
    return x[0][0]

def fo(x: list[t.CArray[t.CArray[int, 3], 2]]) -> int:
    return x[0][0][0]
`;

test('[SIZE]T 数组语法：类型与 t.CArray[T, SIZE] 完全一致且无诊断', () => {
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(SOURCE);

    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}][line=${d.range ? d.range.start.line + 1 : -1}] ${d.message.split('\n')[0]}`
    );
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(errors.length, 0, `不应有 error/warning，实际: ${JSON.stringify(errors)}`);

    const types = collectFirstParamTypes(program, parseResults!);
    // 定长：与 t.CArray[t.CInt, 4] 打印结果相同
    assert.strictEqual(types.get('fa'), types.get('fb'), `[4]t.CInt 应等于 t.CArray[t.CInt, 4]，实际: ${types.get('fa')} vs ${types.get('fb')}`);
    assert(types.get('fa')!.includes('CArray'), `[4]t.CInt 应为 CArray，实际: ${types.get('fa')}`);
    // 不定长（省略 SIZE）：与 t.CArray[t.CInt] 相同
    assert.strictEqual(types.get('fc'), types.get('fd'), `[]t.CInt 应等于 t.CArray[t.CInt]，实际: ${types.get('fc')} vs ${types.get('fd')}`);
    // 多维嵌套
    assert(
        types.get('fe')!.includes('CArray[CArray['),
        `[2][3]t.CInt 应为嵌套 CArray，实际: ${types.get('fe')}`
    );
    // 元素类型为 int（长度以 Literal 形式保留，与 t.CArray[int, 4] 一致）
    assert(
        types.get('ff')!.includes('CArray[int, Literal[4]]'),
        `[4]int 应为 CArray[int, 4]，实际: ${types.get('ff')}`
    );
    // 长度为 t.CDefine 常量
    assert(
        types.get('fg')!.includes('CArray[CInt, '),
        `[BUF]t.CInt 长度应为定义常量，实际: ${types.get('fg')}`
    );
    // 元素类型为指针
    assert(
        types.get('fh')!.includes('CArray[rawptr[') || types.get('fh')!.includes('CArray[CPtr['),
        `[4]t.CInt* 元素应为指针，实际: ${types.get('fh')}`
    );
    // 回归：下标实参以 '[' 开头的注解（t.Callable[[], T]）不得被当成数组语法
    // （解析为函数类型，展开别名后形如 type[() -> CInt]）
    assert(
        types.get('fi')!.includes('->'),
        `t.Callable[[], t.CInt] 应正常解析为函数类型，实际: ${types.get('fi')}`
    );
    // 元素类型为普通下标类型
    assert(
        types.get('fj')!.includes('CArray[CArray['),
        `[4]t.CArray[t.CInt, 2] 应解析为嵌套 CArray，实际: ${types.get('fj')}`
    );
    // 泛型实参位置（list[[4]int]）与等价的显式写法（list[t.CArray[int, 4]]）一致
    assert.strictEqual(
        types.get('fk'),
        types.get('fn'),
        `list[[4]int] 应与 list[t.CArray[int, 4]] 同类型，实际: ${types.get('fk')} vs ${types.get('fn')}`
    );
    assert.strictEqual(
        types.get('fl'),
        types.get('fo'),
        `list[[2][3]int] 应与 list[t.CArray[t.CArray[int, 3], 2]] 同类型，实际: ${types.get('fl')} vs ${types.get('fo')}`
    );
    // 回归：带逗号的实参列表（t.Callable[[int, str], T]）不得被当成数组语法
    assert(
        types.get('fm')!.includes('->'),
        `t.Callable[[int, str], t.CInt] 应正常解析为函数类型，实际: ${types.get('fm')}`
    );

    cleanup(program, serviceProvider);
});

test('[SIZE]T 数组语法：语义高亮不出现 undefined', () => {
    const { program, parseResults, uri, serviceProvider } = buildProgram(SOURCE);

    const { SemanticTokenProvider } = require('../languageService/semanticTokenProvider');
    const { LogTracker } = require('../common/logTracker');
    const provider = new SemanticTokenProvider(new LogTracker());
    const result = provider.provideFull(program, uri);
    assert(result, 'no semantic tokens produced');

    const lines = parseResults!.text.split('\n');
    const tokens: { line: number; text: string; type: number }[] = [];
    let cursorLine = 0;
    let cursorChar = 0;
    for (let i = 0; i < result.data.length; i += 5) {
        cursorLine += result.data[i];
        cursorChar = result.data[i] === 0 ? cursorChar + result.data[i + 1] : result.data[i + 1];
        tokens.push({
            line: cursorLine + 1,
            text: (lines[cursorLine] || '').substring(cursorChar, cursorChar + result.data[i + 2]),
            type: result.data[i + 3],
        });
    }

    const undefinedTokens = tokens.filter((t) => t.type === SemanticTokenTypes.undefined);
    assert.strictEqual(
        undefinedTokens.length,
        0,
        `不应有 undefined 高亮（合成 t/CArray 为零长度，不参与高亮），实际: ${JSON.stringify(undefinedTokens)}`
    );
    // `t.CInt` 里的 CInt 仍按类型（class）着色
    assert(
        tokens.some((t) => t.text === 'CInt' && t.type === SemanticTokenTypes.class),
        `CInt 应显示为 class，实际: ${JSON.stringify(tokens.filter((t) => t.text === 'CInt'))}`
    );
    // 长度数字仍按 number 着色
    assert(
        tokens.some((t) => t.text === '4' && t.type === SemanticTokenTypes.number),
        `长度 4 应显示为 number，实际: ${JSON.stringify(tokens.filter((t) => t.text === '4'))}`
    );

    cleanup(program, serviceProvider);
});

test('[SIZE]T 数组语法：hover 按源码原形显示', () => {
    const source = `import t

buf: [4]t.CInt = []
grid: [2][3]t.CInt = []


def f(x: [8]t.CInt) -> t.CInt:
    return x[0]
`;
    const { program, uri, serviceProvider } = buildProgram(source);

    const getHoverText = (line: number, character: number): string => {
        const provider = new HoverProvider(
            program as any,
            uri,
            { line, character } as Position,
            MarkupKind.Markdown,
            CancellationToken.None
        );
        const hover = provider.getHover();
        return hover ? (hover.contents as MarkupContent).value : '(无 hover)';
    };

    const bufHover = getHoverText(2, 1);
    assert(bufHover.includes('[4]t.CInt'), `buf hover 应显示源码原形 [4]t.CInt，实际: ${bufHover}`);
    const gridHover = getHoverText(3, 1);
    assert(
        gridHover.includes('[2][3]t.CInt'),
        `grid hover 应显示源码原形 [2][3]t.CInt，实际: ${gridHover}`
    );
    const paramHover = getHoverText(6, 6);
    assert(paramHover.includes('[8]t.CInt'), `参数 hover 应显示源码原形 [8]t.CInt，实际: ${paramHover}`);

    cleanup(program, serviceProvider);
});

test('[SIZE]T 数组语法：源文件未 import t 时静默退化（不报未定义 t/成员访问失败）', () => {
    const source = `a: [4]int = []
b: [8]bool = []
`;
    const { program, configOptions, uri, serviceProvider } = buildProgram(source);

    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}][line=${d.range ? d.range.start.line + 1 : -1}] ${d.message.split('\n')[0]}`
    );
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(errors.length, 0, `未 import t 时不应报错，实际: ${JSON.stringify(errors)}`);

    cleanup(program, serviceProvider);
});
