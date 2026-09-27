/*
 * viperCallable.test.ts
 *
 * 验证 Viper 的注解位置小写 `callable[...]` 等价 `t.Callable`：
 *   callable[[A, B], R] / callable[..., R] / callable[[], R]  ≡  t.Callable[...]
 * 实现：parser 在**类型注解位置**把裸名 `callable` 脱糖为 `Callable`
 * （parser._parseAtom，仅 `_isParsingTypeAnnotation` 为真时），
 * `Callable` 在 builtins stub 中以 `Callable: t.CTypedef = t.Callable` 声明，
 * 故不要求源码 `import t`。**值位置不受影响**：`callable(x)` 仍是内置函数。
 *
 * 运行：npx jest src/tests/viperCallable.test.ts --runInBand
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
import { FunctionNode, ParseNodeType, TypeAnnotationNode } from '../parser/parseNodes';

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
    const testDir = path.join(__dirname, '__viper_callable__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'callable.vp');
    fs.writeFileSync(testFile, code, 'utf8');

    const uri = UriEx.file(testFile);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const parseResults = program.getParseResults(uri);
    assert(parseResults, 'parse results not found');

    return { program, configOptions, uri, serviceProvider, testDir, parseResults };
}

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any) {
    const sourceFile = program.getSourceFile(uri);
    assert(sourceFile, 'source file not found');
    return (sourceFile.getDiagnostics(configOptions) || []).map((diag: any) => ({
        category: diag.category,
        line: diag.range ? diag.range.start.line + 1 : -1,
        message: diag.message,
    }));
}

/** 收集「模块级注解变量 + 函数参数注解 + 函数返回注解」的展示类型。 */
function collectAnnotationTypes(program: Program, parseResults: any): Map<string, string> {
    const evaluator = program.evaluator;
    assert(evaluator, 'evaluator not available');
    const result = new Map<string, string>();

    const record = (key: string, node: any) => {
        if (!node || result.has(key)) {
            return;
        }
        const type = evaluator!.getType(node);
        result.set(key, type ? program.printType(type) : '(undefined)');
    };

    class Collector extends ParseTreeWalker {
        override visitTypeAnnotation(node: TypeAnnotationNode) {
            if (node.d.valueExpr.nodeType === ParseNodeType.Name) {
                record(node.d.valueExpr.d.value, node.d.annotation);
            }
            return true;
        }

        override visitFunction(node: FunctionNode) {
            node.d.params.forEach((param) => {
                if (param.d.name && param.d.annotation) {
                    record(param.d.name.d.value, param.d.annotation);
                }
            });
            record(`${node.d.name.d.value}()`, node.d.returnAnnotation);
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    return result;
}

test('注解位置 callable[[A, B], R] 等价 t.Callable / Callable（无需 import t）', () => {
    const code = `A: callable[[int, str], bool] = None
B: Callable[[int], bool] = None
Dotsys: callable[..., bool] = None
Empty: callable[[], bool] = None

def f(cb: callable[[int, str], bool], cb2: callable[..., bool], cb3: callable[[], bool]) -> None:
    pass

def g() -> callable[[int], bool]:
    return None
`;
    const { program, configOptions, uri, serviceProvider, testDir, parseResults } = buildProgramForCode(code);

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== callable 注解诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const realDiagnostics = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(
            realDiagnostics.length,
            0,
            `callable[...] 注解不应产生错误/警告：${JSON.stringify(realDiagnostics)}`
        );

        const types = collectAnnotationTypes(program, parseResults);
        console.log('=== callable 注解类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));

        // 注解位置的求值结果是「可实例化」形式（type[...]），与 t.Callable[...] 完全一致
        assert.strictEqual(
            types.get('A'),
            'type[(int, str) -> bool]',
            `A 应为 type[(int, str) -> bool]，实际: ${types.get('A')}`
        );
        assert.strictEqual(types.get('B'), 'type[(int) -> bool]', `B 应为 type[(int) -> bool]，实际: ${types.get('B')}`);
        assert.strictEqual(
            types.get('Dotsys'),
            'type[(...) -> bool]',
            `Dotsys 应为 type[(...) -> bool]，实际: ${types.get('Dotsys')}`
        );
        assert.strictEqual(
            types.get('Empty'),
            'type[() -> bool]',
            `Empty 应为 type[() -> bool]，实际: ${types.get('Empty')}`
        );
        assert.strictEqual(
            types.get('cb'),
            'type[(int, str) -> bool]',
            `cb 应为 type[(int, str) -> bool]，实际: ${types.get('cb')}`
        );
        assert.strictEqual(types.get('cb2'), 'type[(...) -> bool]', `cb2 应为 type[(...) -> bool]，实际: ${types.get('cb2')}`);
        assert.strictEqual(types.get('cb3'), 'type[() -> bool]', `cb3 应为 type[() -> bool]，实际: ${types.get('cb3')}`);
        assert.strictEqual(
            types.get('g()'),
            'type[(int) -> bool]',
            `g 的返回注解应为 type[(int) -> bool]，实际: ${types.get('g()')}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});

test('值位置 callable(x) 仍是内置函数（不脱糖）', () => {
    const code = `def value_pos(x: object) -> None:
    if callable(x):
        pass

def value_pos2(x: object) -> bool:
    y: bool = callable(x)
    return y

def value_subscript(x: object) -> None:
    z = callable[[int], bool]
`;
    const { program, configOptions, uri, serviceProvider, testDir, parseResults } = buildProgramForCode(code);

    try {
        const diagnostics = getDiagnostics(program, configOptions, uri);
        console.log('=== callable 值位置诊断 ===');
        diagnostics.forEach((d) => console.log(`  L${d.line} [category=${d.category}] ${d.message}`));

        const realDiagnostics = diagnostics.filter((d) => d.category === 0 || d.category === 1);
        assert.strictEqual(
            realDiagnostics.length,
            0,
            `值位置 callable(x) 不应产生错误/警告：${JSON.stringify(realDiagnostics)}`
        );

        // 值位置的 `callable[[int], bool]` 不得变成可调用类型（说明未在值位置脱糖）
        const types = collectAnnotationTypes(program, parseResults);
        console.log('=== 值位置注解类型 ===');
        types.forEach((v, k) => console.log(`  ${k}: ${v}`));

        const xType = types.get('x') ?? '';
        assert(
            !xType.includes('->'),
            `值位置的 callable 不应被当作类型脱糖（x 的注解仍应为 object），实际: ${xType}`
        );
    } finally {
        program.dispose();
        serviceProvider.dispose();
        require('fs').rmSync(testDir, { recursive: true, force: true });
    }
});
