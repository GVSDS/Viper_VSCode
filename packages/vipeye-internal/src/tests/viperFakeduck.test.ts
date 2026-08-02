/*
 * viperFakeduck.test.ts
 *
 * 临时验证测试（非生产代码，验证完可删除）：
 * 复现用户真实场景 —— 分析真实文件 _fakeduck.vp 中 _str.split 方法：
 *
 *     def split(self, delimiter: str) -> list[str]:
 *         result = list[str](self.__mbuddy__)
 *         ...
 *         result.append(str(sub))
 *         return result
 *
 * 其中 self.__mbuddy__: memhub.MemBuddy | t.CPtr（联合类型）。
 *
 * 验证目标：
 *   1. result 变量的类型是否为 list[str] 实例（而不是 None / Unknown）
 *   2. split 中是否有 "Cannot access attribute" 类错误
 *   3. _list.vp / memhub.vp / string.vp 是否能被 importLookup 解析
 *   4. 若 result 为 None / Unknown，定位根因（list 泛型特化 / __init__ 参数校验 /
 *      memhub.MemManager 解析 / 级联模块加载失败）
 *
 * 运行：npx jest src/tests/viperFakeduck.test.ts --runInBand
 * 注意：不要执行 webpack build。
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import * as AnalyzerNodeInfo from '../analyzer/analyzerNodeInfo';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { Uri } from '../common/uri/uri';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { CallNode, ClassNode, FunctionNode, ParseNode } from '../parser/parseNodes';

// 与 testUtils 一致：允许 vipershed-fallback（t.vpi/c.vpi 存根）被定位。
(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';
const FAKEDUCK_PATH = path.join(TRANSPYC_INCLUDES, '_fakeduck.vp');
const LIST_PATH = path.join(TRANSPYC_INCLUDES, '_list.vp');
const MEMHUB_PATH = path.join(TRANSPYC_INCLUDES, 'memhub.vp');
const STRING_PATH = path.join(TRANSPYC_INCLUDES, 'string.vp');

function describeType(t: any): string {
    if (!t) return '(undefined)';
    const cat = t.category;
    const flags = t.flags;
    const name = t.shared?.name ?? t.priv?.name ?? '';
    const moduleName = t.shared?.moduleName ?? t.priv?.moduleName ?? '';
    const typeArgs = t.priv?.typeArgs;
    const isInstance = (flags & 2 /* TypeFlags.Instance */) !== 0;
    return `category=${cat} flags=${flags} isInstance=${isInstance} name=${name} module=${moduleName}${
        typeArgs ? ` typeArgs=[${typeArgs.map((a: any) => describeType(a)).join(', ')}]` : ''
    }`;
}

test('reproduce user scenario: _fakeduck.vp split result type', () => {
    // 1. 构建 ConfigOptions（Viper 方言），把真实 includes 目录放进 extraPaths
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

    // 2. 创建 Program（真实文件系统）
    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    const fakeduckUri = UriEx.file(FAKEDUCK_PATH);

    // 3. 探测 import 解析：_list / memhub / string / t / c 是否可解析
    for (const modName of ['_list', 'memhub', 'string', 't', 'c']) {
        const resolved = importResolver.resolveImport(fakeduckUri, execEnv, {
            leadingDots: 0,
            nameParts: [modName],
            importedSymbols: undefined,
        });
        console.log(
            `=== resolveImport "${modName}": isImportFound=${resolved.isImportFound}, uris=${JSON.stringify(
                resolved.resolvedUris.map((u) => u.getFilePath())
            )}`
        );
    }

    program.setTrackedFiles([fakeduckUri]);
    while (program.analyze()) {
        // 循环直到分析完成
    }

    // 4. 获取 _fakeduck.vp 的诊断
    const sourceFile = program.getSourceFile(fakeduckUri);
    assert(sourceFile, '_fakeduck.vp source file not found');
    const diagnostics = (sourceFile.getDiagnostics(configOptions) || []).map(
        (diag) => `[category=${diag.category}] ${diag.message}`
    );
    console.log('=== _fakeduck.vp diagnostics ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));

    // 5. 检查依赖模块是否被加载（_list.vp / memhub.vp / string.vp / t.vpi / c.vpi）
    const depFiles: Array<{ label: string; uri: Uri | undefined }> = [];
    for (const [label, p] of [
        ['_list.vp', LIST_PATH],
        ['memhub.vp', MEMHUB_PATH],
        ['string.vp', STRING_PATH],
    ] as const) {
        const resolved = importResolver.resolveImport(fakeduckUri, execEnv, {
            leadingDots: 0,
            nameParts: [path.basename(p, '.vp')],
            importedSymbols: undefined,
        });
        const resolvedUri = resolved.resolvedUris[resolved.resolvedUris.length - 1];
        const sf = program.getSourceFile(resolvedUri);
        const diags = sf ? (sf.getDiagnostics(configOptions) || []).map((d) => `[${d.category}] ${d.message}`) : [];
        console.log(`=== ${label}: loaded=${!!sf}, diagnostics=${JSON.stringify(diags)}`);
        depFiles.push({ label, uri: resolvedUri });
        if (sf && diags.length > 0) {
            console.log(`  --- ${label} diagnostics ---`);
            diags.forEach((d) => console.log(`    ${d}`));
        }
    }

    // 6. 从 parse tree 找到 _str.split 方法，取其 scope，查 result 符号
    const parseResults = sourceFile.getParseResults();
    assert(parseResults, 'parse results not found');

    let splitFunctionNode: FunctionNode | undefined;
    class FunctionFinder extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            if (node.d.name.d.value === 'split') {
                splitFunctionNode = node;
                return false;
            }
            return true;
        }
    }
    new FunctionFinder().walk(parseResults.parserOutput.parseTree);
    assert(splitFunctionNode, 'split function not found');

    const splitScope = AnalyzerNodeInfo.getScope(splitFunctionNode!);
    assert(splitScope, 'split scope not found');

    const resultSymbol = splitScope.lookUpSymbol('result');
    assert(resultSymbol, 'result symbol not found in split scope');

    const resultType = program.getTypeOfSymbol(resultSymbol);
    console.log('=== result type ===');
    console.log(`  printed: ${resultType ? program.printType(resultType) : '(undefined)'}`);
    console.log(`  detail: ${describeType(resultType)}`);
    assert(resultType, 'result type is undefined');

    // 7. 用 evaluator 求值 list[str](self.__mbuddy__) 构造调用，检查其返回类型
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');

    const callNodes: CallNode[] = [];
    let listCallNode: CallNode | undefined;
    class CallCollector extends ParseTreeWalker {
        override visitCall(node: CallNode) {
            callNodes.push(node);
            return true;
        }
    }
    new CallCollector().walk(splitFunctionNode!);

    for (const callNode of callNodes) {
        const callType = evaluator.getType(callNode as any);
        const printed = callType ? program.printType(callType) : '(undefined)';
        // 打印 split 内所有调用节点的类型
        const leftExpr = callNode.d?.leftExpr as any;
        const calleeName = leftExpr?.nodeType === 'Name' ? leftExpr?.d?.value : undefined;
        console.log(`=== call node type (range ${callNode.start}-${callNode.start + callNode.length}, callee=${calleeName}): ${printed}`);
        if (calleeName === 'list') {
            listCallNode = callNode;
        }
    }

    // 8. 检查 _list.vp 的 list 类定义（泛型类是否被正确识别）
    const listResolvedUri = depFiles.find((d) => d.label === '_list.vp')?.uri;
    if (listResolvedUri) {
        const listSf = program.getSourceFile(listResolvedUri);
        const listParse = listSf?.getParseResults();
        if (listParse) {
            const listModuleScope = AnalyzerNodeInfo.getScope(listParse.parserOutput.parseTree);
            const listClassSymbol = listModuleScope?.lookUpSymbol('list');
            if (listClassSymbol) {
                const listClassType = program.getTypeOfSymbol(listClassSymbol);
                console.log('=== _list.list class type ===');
                console.log(`  printed: ${program.printType(listClassType)}`);
                console.log(`  detail: ${describeType(listClassType)}`);
            } else {
                console.log('=== _list.list class symbol NOT found ===');
            }

            // 检查 list 的 __init__ / __new__ 签名
            class ClassFinder extends ParseTreeWalker {
                override visitClass(node: ClassNode) {
                    if (node.d.name.d.value === 'list') {
                        const clsScope = AnalyzerNodeInfo.getScope(node);
                        for (const fnName of ['__init__', '__new__', 'append']) {
                            const fnSym = clsScope?.lookUpSymbol(fnName);
                            if (fnSym) {
                                const fnType = program.getTypeOfSymbol(fnSym);
                                console.log(`=== _list.list.${fnName} type: ${program.printType(fnType)}`);
                            } else {
                                console.log(`=== _list.list.${fnName} symbol NOT found`);
                            }
                        }
                        return false;
                    }
                    return true;
                }
            }
            new ClassFinder().walk(listParse.parserOutput.parseTree);
        }
    }

    // 9. 检查 memhub.MemManager 是否可解析
    {
        const memhubResolvedUri = depFiles.find((d) => d.label === 'memhub.vp')?.uri;
        const memhubSf = memhubResolvedUri ? program.getSourceFile(memhubResolvedUri) : undefined;
        const memhubParse = memhubSf?.getParseResults();
        if (memhubParse) {
            const memhubModuleScope = AnalyzerNodeInfo.getScope(memhubParse.parserOutput.parseTree);
            for (const name of ['MemManager', 'MemBuddy']) {
                const sym = memhubModuleScope?.lookUpSymbol(name);
                if (sym) {
                    const t = program.getTypeOfSymbol(sym);
                    console.log(`=== memhub.${name}: ${program.printType(t)}`);
                } else {
                    console.log(`=== memhub.${name} symbol NOT found`);
                }
            }
        } else {
            console.log('=== memhub.vp NOT loaded / no parse results');
        }
    }

    // 10. 统计关键诊断
    const attributeErrors = diagnostics.filter(
        (d) => d.includes('Cannot access attribute') || d.includes('is not assignable')
    );
    console.log('=== attribute / assignability errors ===');
    attributeErrors.forEach((d) => console.log(`  ${d}`));

    const resultTypeStr = program.printType(resultType);
    const resultIsNoneOrUnknown =
        resultTypeStr.includes('None') || resultTypeStr.includes('Unknown') || resultTypeStr === '()';

    console.log('=== SUMMARY ===');
    console.log(`  result type: ${resultTypeStr}`);
    console.log(`  result is None/Unknown/empty: ${resultIsNoneOrUnknown}`);
    console.log(`  "Cannot access attribute" errors: ${attributeErrors.length}`);
    console.log(`  _list.vp loaded: ${!!depFiles.find((d) => d.label === '_list.vp')?.uri && !!program.getSourceFile(depFiles.find((d) => d.label === '_list.vp')!.uri!)}`);
    console.log(`  memhub.vp loaded: ${!!depFiles.find((d) => d.label === 'memhub.vp')?.uri && !!program.getSourceFile(depFiles.find((d) => d.label === 'memhub.vp')!.uri!)}`);
    console.log(`  string.vp loaded: ${!!depFiles.find((d) => d.label === 'string.vp')?.uri && !!program.getSourceFile(depFiles.find((d) => d.label === 'string.vp')!.uri!)}`);

    // 验证目标断言：无论 result 是否正常，测试都必须输出完整诊断；用宽松断言保证测试通过以收集信息
    assert(resultTypeStr.length > 0, 'result type string is empty');

    program.dispose();
    serviceProvider.dispose();
});
