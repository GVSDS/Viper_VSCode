/*
 * viperBuiltinsVpTypedef.test.ts
 *
 * 验证 Viper 方言下注解名解析对 includes/builtins.vp（真实源码，非 .vpi 存根）
 * 中 t.CTypedef 类型别名的兜底搜索（"builtins 最后匹配"，对齐 TransPyC
 * TypeAnnotationResolver / TPV _lookup_builtins_typedef）：
 *   - `rowptr[int]` 注解 → rowptr 为 builtins.vp 中的 typedef，可解析为 CPtr[int]
 *   - `size_t` 注解 → 解析为 t.CSizeT
 *   - `int8` 注解 → 解析为 t.CInt8T
 *   - 均无需显式 import builtins（builtins 不在用户文件 import 闭包内）
 *   - 不报"未定义 rowptr/size_t/int8"
 *
 * 运行：npx jest src/tests/viperBuiltinsVpTypedef.test.ts --runInBand
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
import { FunctionNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__builtins_vp_typedef__');
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
        [UriEx.file(TRANSPYC_INCLUDES)],
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

// 收集函数参数注解类型（打印名，expandTypeAlias 展开别名）
function collectParamAnnotationTypes(
    program: Program,
    parseResults: any
): Map<string, string[]> {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    const ev = evaluator;
    const result = new Map<string, string[]>();

    class ParamCollector extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            const funcName = node.d.name.d.value;
            for (const param of node.d.params) {
                const ann = (param as any).d?.annotation;
                if (ann) {
                    const t = ev.getType(ann as any);
                    const list = result.get(funcName) ?? [];
                    list.push(t ? program.printType(t, { expandTypeAlias: true }) : '(undefined)');
                    result.set(funcName, list);
                }
            }
            return true;
        }
    }
    new ParamCollector().walk(parseResults.parserOutput.parseTree);

    return result;
}

test('builtins.vp（includes 版本）typedef 在注解中可直接解析', () => {
    const source = `import t

def f(x: rowptr[int]) -> int:
    return 0

def g() -> size_t:
    return 0

def h(a: int8) -> int:
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    // 1. 无未定义诊断
    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    const undefinedDiags = diagnostics.filter((d) => d.includes('未定义') || d.includes('undefined'));
    assert.strictEqual(
        undefinedDiags.length,
        0,
        `builtins.vp typedef 不应报未定义，实际: ${JSON.stringify(undefinedDiags)}`
    );

    // 2. 参数注解类型解析：rowptr[int] → CPtr[int]
    const types = collectParamAnnotationTypes(program, parseResults!);
    const fTypes = types.get('f');
    assert(fTypes && fTypes.some((t) => t.includes('CPtr') && t.includes('int')), `f(x) 应为 CPtr[int]，实际: ${JSON.stringify(fTypes)}`);

    // 3. 返回注解 size_t → CSizeT
    const gReturn = (() => {
        const evaluator = program.evaluator as TypeEvaluator | undefined;
        assert(evaluator);
        const ev = evaluator;
        let retType: string | undefined;
        class RetCollector extends ParseTreeWalker {
            override visitFunction(node: FunctionNode) {
                if (node.d.name.d.value === 'g' && node.d.returnAnnotation) {
                    const t = ev.getType(node.d.returnAnnotation as any);
                    retType = t ? program.printType(t, { expandTypeAlias: true }) : '(undefined)';
                }
                return true;
            }
        }
        new RetCollector().walk(parseResults!.parserOutput.parseTree);
        return retType;
    })();
    assert(
        gReturn && (gReturn === 'CSizeT' || gReturn.includes('CSizeT')),
        `g() 返回注解 size_t 应为 CSizeT，实际: ${gReturn}`
    );

    // 4. 参数注解 int8 → CInt8T
    const hTypes = types.get('h');
    assert(hTypes && hTypes.some((t) => t.includes('CInt8T')), `h(a) 应为 CInt8T，实际: ${JSON.stringify(hTypes)}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__builtins_vp_typedef__'), { recursive: true, force: true });
});

test('builtins.vp typedef 与 builtins.vpi 内建并存（int/str 等不被破坏）', () => {
    const source = `import t

def f(x: rowptr[int]) -> str:
    s: str = "ok"
    return s
`;
    const { program, configOptions, uri, serviceProvider } = buildProgram(source);

    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(
        errors.length,
        0,
        `builtins.vpi 内建（str 等）应与 builtins.vp typedef 并存，实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__builtins_vp_typedef__'), { recursive: true, force: true });
});

test('builtins.vp 同名声明优先覆盖 builtins.vpi（ord 参数为 t.CChar）', () => {
    const source = `import t

def f() -> int:
    c: t.CChar = ord("a")
    return c
`;
    const { program, parseResults, serviceProvider } = buildProgram(source);

    // ord 在 builtins.vp 中声明为 ord(s: t.CChar) -> int，
    // 覆盖 builtins.vpi 的 ord(c: str | bytes | bytearray, /) -> int。
    // 通过 main 文件作用域链（含 builtin 作用域）解析 ord 符号。
    const AnalyzerNodeInfo = require('../analyzer/analyzerNodeInfo');
    const mainScope = AnalyzerNodeInfo.getScope(parseResults!.parserOutput.parseTree);
    const ordSymbol = mainScope?.lookUpSymbolRecursive?.('ord')?.symbol;
    assert(ordSymbol, 'ord 符号未找到（builtins.vp 覆盖未生效）');

    const ordType = program.getTypeOfSymbol(ordSymbol);
    const ordSignature = program.printType(ordType, { expandTypeAlias: true });
    assert(
        ordSignature.includes('CChar'),
        `ord 应使用 builtins.vp 的 t.CChar 签名，实际: ${ordSignature}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__builtins_vp_typedef__'), { recursive: true, force: true });
});
