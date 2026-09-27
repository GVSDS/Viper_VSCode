/*
 * viperVirtualModifier.test.ts
 *
 * 验证 Viper 的 vtable 声明修饰关键字：
 *   virtual class X     —— 类级：启用多态 vtable（等价 @t.CVTable class X）
 *   novirtual class X   —— 类级：非多态，字段展平嵌入（等价 @t.NoVTable class X）
 *   virtual def f(...)  —— 方法级：必须在 class / virtual class 内（不能在 novirtual class 内）
 *   novirtual def f(..) —— 方法级：必须在 class / virtual class / novirtual class 内
 *
 * 语义取舍：这些关键字是给编译器的代码生成提示，类型层无额外语义，
 * 解析器只记录在节点上（ClassNode.d.viperClassModifier / FunctionNode.d.viperModifier），
 * 并校验方法级修饰的出现位置；语法高亮由 TextMate grammar 负责。
 *
 * 运行：npx jest src/tests/viperVirtualModifier.test.ts --runInBand
 */

import assert from 'assert';
import path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { ClassNode, FunctionNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';

function buildProgram(source: string) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__virtual_modifier__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    const filePath = path.join(testRoot, 'main.vp');
    fs.writeFileSync(filePath, source, 'utf8');

    const projectRoot = UriEx.file(testRoot);
    const configOptions = new ConfigOptions(projectRoot);
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');
    configOptions.executionEnvironments = [
        new ExecutionEnvironment(
            'python',
            projectRoot,
            configOptions.diagnosticRuleSet,
            configOptions.defaultPythonVersion,
            configOptions.defaultPythonPlatform,
            [UriEx.file(TRANSPYC_INCLUDES)],
            /* skipNativeLibraries */ false,
            /* defaultDialect */ 'viper'
        ),
    ];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);
    const uri = UriEx.file(filePath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const parseResults = program.getSourceFile(uri)!.getParseResults();
    const diagnostics = (program.getSourceFile(uri)?.getDiagnostics(configOptions) || []).map(
        (d) => `[category=${d.category}] ${d.message}`
    );

    return { program, configOptions, parseResults, uri, serviceProvider, diagnostics };
}

function collectClassModifiers(parseResults: any): Map<string, string | undefined> {
    const result = new Map<string, string | undefined>();
    class Collector extends ParseTreeWalker {
        override visitClass(node: ClassNode) {
            result.set(node.d.name.d.value, node.d.viperClassModifier);
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    return result;
}

function collectMethodModifiers(parseResults: any): Map<string, string | undefined> {
    const result = new Map<string, string | undefined>();
    class Collector extends ParseTreeWalker {
        override visitFunction(node: FunctionNode) {
            result.set(node.d.name.d.value, node.d.viperModifier);
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    return result;
}

function errorsOf(diagnostics: string[]): string[] {
    return diagnostics.filter((d) => d.startsWith('[category=0]') || d.startsWith('[category=1]'));
}

test('virtual class / novirtual class 记录修饰形态且不报错', () => {
    const source = `import t

virtual class A():
    val: t.CInt
    def get(self) -> t.CInt:
        return self.val

novirtual class B():
    val: t.CInt

class C():
    val: t.CInt
`;
    const { program, serviceProvider, parseResults, diagnostics } = buildProgram(source);

    const errors = errorsOf(diagnostics);
    assert.strictEqual(errors.length, 0, `vtable 类声明不应报错，实际: ${JSON.stringify(diagnostics)}`);

    const classModifiers = collectClassModifiers(parseResults!);
    assert.strictEqual(classModifiers.get('A'), 'virtual', `A 应为 virtual class，实际: ${classModifiers.get('A')}`);
    assert.strictEqual(classModifiers.get('B'), 'novirtual', `B 应为 novirtual class，实际: ${classModifiers.get('B')}`);
    assert.strictEqual(classModifiers.get('C'), undefined, `C 是普通 class，不应有修饰，实际: ${classModifiers.get('C')}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__virtual_modifier__'), { recursive: true, force: true });
});

test('virtual def / novirtual def 在允许的类形态内不报错', () => {
    const source = `import t

class Plain():
    virtual def a(self) -> int:
        return 1
    novirtual def b(self) -> int:
        return 2

virtual class V():
    virtual def c(self) -> int:
        return 3
    novirtual def d(self) -> int:
        return 4

novirtual class N():
    novirtual def e(self) -> int:
        return 5
`;
    const { program, serviceProvider, parseResults, diagnostics } = buildProgram(source);

    const errors = errorsOf(diagnostics);
    assert.strictEqual(errors.length, 0, `合法位置的 vtable 方法不应报错，实际: ${JSON.stringify(diagnostics)}`);

    const methodModifiers = collectMethodModifiers(parseResults!);
    for (const [name, expected] of [
        ['a', 'virtual'],
        ['b', 'novirtual'],
        ['c', 'virtual'],
        ['d', 'novirtual'],
        ['e', 'novirtual'],
    ] as const) {
        assert.strictEqual(
            methodModifiers.get(name),
            expected,
            `${name} 应为 ${expected} 方法，实际: ${methodModifiers.get(name)}`
        );
    }

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__virtual_modifier__'), { recursive: true, force: true });
});

test('virtual def 不能位于 novirtual class 内，也不能位于类外', () => {
    const source = `import t

novirtual class N():
    virtual def bad(self) -> int:
        return 1

virtual def topLevel() -> int:
    return 2

def outer() -> int:
    virtual def nested() -> int:
        return 3
    return 0
`;
    const { program, serviceProvider, diagnostics } = buildProgram(source);

    assert(
        diagnostics.some((d) => d.includes('不能位于 novirtual class 内')),
        `novirtual class 内的 virtual def 应报错，实际: ${JSON.stringify(diagnostics)}`
    );
    assert(
        diagnostics.filter((d) => d.includes('"virtual def" 必须位于 class 或 virtual class 内')).length >= 2,
        `类外的 virtual def（模块级 / 函数体内）应各报一次，实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__virtual_modifier__'), { recursive: true, force: true });
});

test('novirtual def 位于类外时报错', () => {
    const source = `import t

novirtual def topLevel() -> int:
    return 1
`;
    const { program, serviceProvider, diagnostics } = buildProgram(source);

    assert(
        diagnostics.some((d) => d.includes('"novirtual def" 必须位于 class、virtual class 或 novirtual class 内')),
        `类外的 novirtual def 应报错，实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__virtual_modifier__'), { recursive: true, force: true });
});

test('virtual / novirtual 不搭配 class、def 时报错', () => {
    const source = `import t

virtual val: t.CInt

novirtual def f(x: t.CInt) -> t.CInt:
    return x
`;
    const { program, serviceProvider, diagnostics } = buildProgram(source);

    assert(
        diagnostics.some((d) => d.includes('必须与 class 或 def 搭配使用')),
        `virtual 不搭配 class/def 应报错，实际: ${JSON.stringify(diagnostics)}`
    );

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__virtual_modifier__'), { recursive: true, force: true });
});

test('装饰器后的 virtual class 同样成立，且类成员可正常访问', () => {
    const source = `import t

@t.Object
virtual class Widget():
    val: t.CInt
    def __init__(self, v: t.CInt):
        self.val = v
    def get(self) -> t.CInt:
        return self.val

export def main() -> int:
    w = Widget(7)
    return w.get()
`;
    const { program, serviceProvider, parseResults, diagnostics } = buildProgram(source);

    const errors = errorsOf(diagnostics);
    assert.strictEqual(errors.length, 0, `装饰器 + virtual class 不应报错，实际: ${JSON.stringify(diagnostics)}`);

    const classModifiers = collectClassModifiers(parseResults!);
    assert.strictEqual(classModifiers.get('Widget'), 'virtual', `Widget 应为 virtual class，实际: ${classModifiers.get('Widget')}`);

    program.dispose();
    serviceProvider.dispose();
    require('fs').rmSync(path.join(__dirname, '__virtual_modifier__'), { recursive: true, force: true });
});
