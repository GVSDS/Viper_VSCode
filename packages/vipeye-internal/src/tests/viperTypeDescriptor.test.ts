/*
 * viperTypeDescriptor.test.ts
 *
 * 验证 Viper 类型描述符 `const T` / `volatile T`（`a: const int` / `a: volatile int`）。
 *
 * 实现取舍：const / volatile 是**硬关键字**（tokenizer 生成 ViperTypeDescriptor），
 * 语法上只允许「类型注解前缀」一种用法，其余位置报语法错误。解析层脱糖为等价的
 * 联合类型注解 `CConst | T` / `CVolatile | T`，完全复用既有 TypeSet 修饰符语义：
 *   - 注解保留修饰符（CConst / CVolatile），无诊断
 *   - `const T*` ≡ `(CConst | T)*` → `CConst | CPtr[T]`（指针后缀绑定到修饰后的类型，
 *     不因 `*` 之后是行尾还是下一行内容而在两条解析路径间摇摆）
 *   - 脱糖目标 CConst / CVolatile 是 builtins stub 别名，不要求源码 import t
 *   - 硬关键字边界：`const = 1`、`a: const`（不跟类型）报语法错误
 *
 * 运行：npx jest src/tests/viperTypeDescriptor.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { Program } from '../analyzer/program';
import { EvalFlags, TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { isClass, isUnion } from '../analyzer/types';
import { convertToInstance } from '../analyzer/typeUtils';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { FullAccessHost } from '../common/fullAccessHost';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FunctionNode, ParseNodeType } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

// 按「注解求值」的方式求类型（EvalFlags.TypeExpression + convertToInstance），
// 与 typeEvaluator.getTypeOfAnnotation 的处理一致，避免把 `X | Y` 当成值表达式
// （此时 printType 只会打印 specialForm 名 "UnionType"）。
function evaluateAnnotation(evaluator: TypeEvaluator, annotation: any): any {
    const raw = evaluator.getTypeOfExpression(annotation, EvalFlags.TypeExpression).type;
    return raw ? convertToInstance(raw) : undefined;
}

// 结构化描述类型：联合 → 子类型名列表；单一 → 类名。不依赖 printType 格式。
function describeType(type: any): string {
    if (!type) {
        return '(undefined)';
    }
    if (isUnion(type)) {
        return type.priv.subtypes.map((sub: any) => describeType(sub)).join(' | ');
    }
    if (isClass(type)) {
        const typeArgs = type.priv.typeArgs;
        if (typeArgs && typeArgs.length > 0) {
            return `${type.shared.name}[${typeArgs.map((a: any) => describeType(a)).join(', ')}]`;
        }
        return type.shared.name;
    }
    return String(type.category);
}

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__type_descriptor__');
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

function getDiagnostics(program: Program, configOptions: ConfigOptions, uri: any): string[] {
    return (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );
}

// 收集函数内「变量注解」的解析类型（结构化描述，不依赖 printType 格式）。
function collectVarAnnotationTypes(program: Program, parseResults: any): Map<string, string> {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    const ev = evaluator;
    const result = new Map<string, string>();

    class VarCollector extends ParseTreeWalker {
        override visitAssignment(node: any) {
            const left = node.d.leftExpr;
            if (left?.nodeType === ParseNodeType.TypeAnnotation && left.d.annotation) {
                const name = left.d.valueExpr?.d?.value;
                if (name) {
                    result.set(name, describeType(evaluateAnnotation(ev, left.d.annotation)));
                }
            }
            return true;
        }
    }
    new VarCollector().walk(parseResults.parserOutput.parseTree);

    return result;
}

// 收集函数内「变量注解」的展示形态（printType，即 hover / 诊断里给用户看的文本）。
function collectVarAnnotationDisplays(program: Program, parseResults: any): Map<string, string> {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    const ev = evaluator;
    const result = new Map<string, string>();

    class DisplayCollector extends ParseTreeWalker {
        override visitAssignment(node: any) {
            const left = node.d.leftExpr;
            if (left?.nodeType === ParseNodeType.TypeAnnotation && left.d.annotation) {
                const name = left.d.valueExpr?.d?.value;
                if (name) {
                    const type = evaluateAnnotation(ev, left.d.annotation);
                    result.set(name, type ? program.printType(type, { expandTypeAlias: true }) : '(undefined)');
                }
            }
            return true;
        }
    }
    new DisplayCollector().walk(parseResults.parserOutput.parseTree);

    return result;
}

// 收集函数参数 / 返回注解的解析类型。
function collectFunctionAnnotationTypes(program: Program, parseResults: any): Map<string, string[]> {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator);
    const ev = evaluator;
    const result = new Map<string, string[]>();

    class FuncCollector extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            const funcName = node.d.name.d.value;
            const list: string[] = [];
            for (const param of node.d.params) {
                const ann = (param as any).d?.annotation;
                if (ann) {
                    list.push(describeType(evaluateAnnotation(ev, ann)));
                }
            }
            if (node.d.returnAnnotation) {
                list.push('->' + describeType(evaluateAnnotation(ev, node.d.returnAnnotation)));
            }
            result.set(funcName, list);
            return true;
        }
    }
    new FuncCollector().walk(parseResults.parserOutput.parseTree);

    return result;
}

test('const int / volatile int 注解：保留修饰符且无诊断', () => {
    const source = `import t

def f() -> int:
    a: const int = 5
    b: volatile int = 6
    c: t.CConst | int = 5
    d: t.CVolatile | int = 6
    return a + b + c + d
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(errors.length, 0, `const/volatile 注解不应有错误，实际: ${JSON.stringify(diagnostics)}`);

    const types = collectVarAnnotationTypes(program, parseResults!);
    const aType = types.get('a') ?? '';
    const bType = types.get('b') ?? '';
    const cType = types.get('c') ?? '';
    const dType = types.get('d') ?? '';
    assert(
        aType === cType,
        `\`const int\` 应与手写 \`t.CConst | int\` 完全等价，实际: ${aType} vs ${cType}`
    );
    assert(bType === dType, `\`volatile int\` 应与手写 \`t.CVolatile | int\` 完全等价，实际: ${bType} vs ${dType}`);
    assert(aType.includes('CConst'), `a: const int 应保留 CConst 修饰符，实际: ${aType}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__type_descriptor__'), { recursive: true, force: true });
});

test('const/volatile 支持指针、联合与参数/返回值位置', () => {
    const source = `import t

def f(p: const t.CPtr, p2: t.CConst | t.CPtr, p3: const int*, p4: t.CConst | int*) -> volatile int:
    q: const int | t.CPtr = p
    r: volatile int* = p3
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(errors.length, 0, `描述符组合写法不应有错误，实际: ${JSON.stringify(diagnostics)}`);

    const funcTypes = collectFunctionAnnotationTypes(program, parseResults!);
    const fTypes = funcTypes.get('f') ?? [];
    assert.strictEqual(
        fTypes[0],
        fTypes[1],
        `p: const t.CPtr 应与手写 t.CConst | t.CPtr 完全等价，实际: ${fTypes[0]} vs ${fTypes[1]}`
    );
    assert(
        fTypes[0] && fTypes[0].includes('CConst') && fTypes[0].includes('CPtr'),
        `p: const t.CPtr 应为 CConst + CPtr，实际: ${fTypes[0]}`
    );
    // 指针后缀写法与手写等价（该组合在既有实现中即为 Unknown，此处只保证两者一致，
    // 不引入新的分叉；是否让 `const T*` 折叠为 CPtr[const T] 见后续讨论）。
    assert.strictEqual(
        fTypes[2],
        fTypes[3],
        `p: const int* 应与手写 t.CConst | int* 完全等价，实际: ${fTypes[2]} vs ${fTypes[3]}`
    );
    assert(
        fTypes.some((t) => t.startsWith('->') && t.includes('CVolatile')),
        `-> volatile int 应保留 CVolatile，实际: ${JSON.stringify(fTypes)}`
    );

    const varTypes = collectVarAnnotationTypes(program, parseResults!);
    assert(
        (varTypes.get('q') ?? '').includes('CConst') && (varTypes.get('q') ?? '').includes('CPtr'),
        `q: const int | t.CPtr 应保留 CConst + CPtr，实际: ${varTypes.get('q')}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__type_descriptor__'), { recursive: true, force: true });
});

test('类型描述符不依赖源码 import t（合成 t 静默退化）', () => {
    const source = `a: const int = 1
b: volatile int = 2
`;
    const { program, configOptions, uri, serviceProvider } = buildProgram(source);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const undefinedDiags = diagnostics.filter((d) => d.includes('未定义') || d.includes('undefined'));
    assert.strictEqual(
        undefinedDiags.length,
        0,
        `描述符不应要求 import t（合成 t 须静默退化），实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__type_descriptor__'), { recursive: true, force: true });
});

test('展示形态：修饰符作为前缀限定符（const rawptr[int]），不暴露联合成员名', () => {
    const source = `import t

def f() -> int:
    a: const int = 5
    b: volatile int = 6
    c: const int* = None
    d: const char* = None
    e: const volatile int = 7
    return a + b + e
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
    assert.strictEqual(errors.length, 0, `描述符注解不应有错误，实际: ${JSON.stringify(diagnostics)}`);

    const displays = collectVarAnnotationDisplays(program, parseResults!);
    assert.strictEqual(displays.get('a'), 'const int', `a 展示形态应为 const int，实际: ${displays.get('a')}`);
    assert.strictEqual(displays.get('b'), 'volatile int', `b 展示形态应为 volatile int，实际: ${displays.get('b')}`);
    assert.strictEqual(
        displays.get('c'),
        'const rawptr[int]',
        `c 展示形态应为 const rawptr[int]，实际: ${displays.get('c')}`
    );
    assert.strictEqual(
        displays.get('d'),
        'const rawptr[char]',
        `d 展示形态应为 const rawptr[char]，实际: ${displays.get('d')}`
    );
    assert.strictEqual(
        displays.get('e'),
        'const volatile int',
        `e 展示形态应为 const volatile int，实际: ${displays.get('e')}`
    );

    // 内部表示名（CConst / CVolatile）不得泄漏到展示文本里
    for (const [name, text] of displays) {
        assert(
            !text.includes('CConst') && !text.includes('CVolatile'),
            `${name} 展示形态不应暴露内部修饰符名，实际: ${text}`
        );
    }

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__type_descriptor__'), { recursive: true, force: true });
});

test('const / volatile 是硬关键字：只能作类型注解前缀，其余用法报语法错误', () => {
    const source = `const = 1
volatile = 2
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(source);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    // 硬关键字：不再是普通标识符，赋值语句必然解析失败。
    const syntaxErrors = diagnostics.filter((d) => d.startsWith('[category=0]'));
    assert(
        syntaxErrors.length > 0,
        `const/volatile 作普通标识符应报语法错误（硬关键字），实际: ${JSON.stringify(diagnostics)}`
    );

    // 形状校验：不应再出现左值为 NameNode 'const' / 'volatile' 的普通赋值。
    const assigned = new Set<string>();
    class ShapeCollector extends ParseTreeWalker {
        override visitAssignment(node: any) {
            const left = node.d.leftExpr;
            if (left?.nodeType === ParseNodeType.Name) {
                assigned.add(left.d.value);
            }
            return true;
        }
    }
    new ShapeCollector().walk(parseResults!.parserOutput.parseTree);
    assert(!assigned.has('const'), `\`const = 1\` 不应被解析为普通赋值（硬关键字）`);
    assert(!assigned.has('volatile'), `\`volatile = 2\` 不应被解析为普通赋值（硬关键字）`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__type_descriptor__'), { recursive: true, force: true });
});

test('类型描述符后不跟类型时报语法错误', () => {
    const source = `import t

def f() -> int:
    a: const = 1
    return 0
`;
    const { program, configOptions, uri, serviceProvider } = buildProgram(source);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    assert(
        diagnostics.some((d) => d.includes('类型描述符') && d.includes('const')),
        `\`a: const\` 应报「类型描述符后必须跟类型」，实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__type_descriptor__'), { recursive: true, force: true });
});

test('T* / const T* 不依赖源码 import t', () => {
    const source = `a: int*
b: const int*
c: int**
d: const int**
`;
    const { program, configOptions, uri, serviceProvider } = buildProgram(source);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    const undefinedDiags = diagnostics.filter((d) => d.includes('未定义') || d.includes('undefined'));
    assert(
        !undefinedDiags.some((d) => d.includes('未定义“t”')),
        `T* / const T* 不应要求 import t（rawptr 内建回退），实际: ${JSON.stringify(diagnostics)}`
    );
    const errors = diagnostics.filter((d) => d.startsWith('[category=0]'));
    assert.strictEqual(
        errors.length,
        0,
        `T* / const T* 不应产生错误（未 import t），实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__type_descriptor__'), { recursive: true, force: true });
});
