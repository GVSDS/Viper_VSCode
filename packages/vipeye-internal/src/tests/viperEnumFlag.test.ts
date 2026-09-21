/*
 * viperEnumFlag.test.ts
 *
 * 验证 Viper 的 `enum X:` 语法（等价 `class X(t.CEnum):`）：
 *   - 成员可以只写成员名（裸名 / 逗号分隔的裸名），不报"未定义变量/未使用表达式"；
 *   - 取值由编译期从 0 递增推导，中间可显式赋值（显式赋值后从该值 + 1 继续）；
 *   - 推导值或显式赋值超出成员声明类型（如 i1）的可表示范围时报错；
 *   - `enum X: a, b, c` 之后可换行 + TAB 继续写成员。
 *
 * 运行：npx jest src/tests/viperEnumFlag.test.ts --runInBand
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
import { FullAccessHost } from '../common/fullAccessHost';
import { convertOffsetToPosition } from '../common/positionUtils';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { MemberAccessNode } from '../parser/parseNodes';
import { HoverProvider } from '../languageService/hoverProvider';

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
    const testDir = path.join(__dirname, '__enum_flag__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, `enum_flag_${testFileIndex++}.vp`);
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

// 收集文件中所有成员访问表达式（形如 `ASTFlag.IsAsync`）的类型。
function collectMemberAccessTypes(program: Program, parseResults: any, memberNames: string[]) {
    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;
    const lines = parseResults.parserOutput.lines;
    const results: { line: number; member: string; type: string }[] = [];

    class Collector extends ParseTreeWalker {
        override visitMemberAccess(node: MemberAccessNode) {
            const memberName = (node.d.member as any)?.d?.value ?? '';
            if (memberNames.includes(memberName)) {
                const pos = convertOffsetToPosition(node.start, lines);
                const type = ev.getType(node as any);
                results.push({
                    line: pos.line + 1,
                    member: memberName,
                    type: type ? program.printType(type) : '(undefined)',
                });
            }
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);
    return results;
}

function assertNoUndefinedOrUnused(diagnostics: string[]) {
    const bad = diagnostics.filter(
        (d) => /未定义|undefined|not defined|未使用|no effect|unused/i.test(d)
    );
    assert.strictEqual(bad.length, 0, `不应报未定义/未使用：${JSON.stringify(diagnostics, undefined, 2)}`);
}

// 取指定位置的 hover 文本（Markdown）。
function getHoverText(program: Program, uri: any, line: number, character: number): string {
    const provider = new HoverProvider(
        program as any,
        uri,
        { line, character } as Position,
        MarkupKind.Markdown,
        CancellationToken.None
    );
    const hover = provider.getHover();
    return hover ? (hover.contents as MarkupContent).value : '(无 hover)';
}

test('枚举成员 hover 显示枚举类型与推导值', () => {
    const code = `import t

class CEnumRef(t.CEnum):
    RED: t.State = 0
    GREEN = 1

enum ASTFlag:
    IsAsync
    Simple
    HasStar: int

enum Mid:
    a
    b = 5
    c: t.u8

def use() -> int:
    v: int = ASTFlag.IsAsync
    return 0
`;
    const { program, uri, serviceProvider } = buildProgramForCode(code);

    const hovers: Record<string, string> = {
        '旧写法 RED: t.State = 0': getHoverText(program, uri, 3, 4),
        '旧写法 GREEN = 1': getHoverText(program, uri, 4, 4),
        '新写法裸名 IsAsync': getHoverText(program, uri, 7, 4),
        '新写法 Simple': getHoverText(program, uri, 8, 4),
        '新写法 HasStar: int': getHoverText(program, uri, 9, 4),
        '显式赋值 b = 5': getHoverText(program, uri, 13, 4),
        '显式赋值 + 类型 c: t.u8': getHoverText(program, uri, 14, 4),
        '使用点 ASTFlag.IsAsync': getHoverText(program, uri, 17, 21),
    };
    Object.entries(hovers).forEach(([key, value]) => {
        console.log(`=== ${key} ===`);
        console.log(value);
    });

    // `enum X:` 成员：显示枚举类型 + 编译期推导值（裸名成员不再显示 Unbound）。
    assert(hovers['新写法裸名 IsAsync'].includes('IsAsync: ASTFlag = 0'), hovers['新写法裸名 IsAsync']);
    assert(hovers['新写法 Simple'].includes('Simple: ASTFlag = 1'), hovers['新写法 Simple']);
    assert(hovers['新写法 HasStar: int'].includes('HasStar: ASTFlag = 2'), hovers['新写法 HasStar: int']);
    // 显式赋值后从该值 +1 继续（b = 5 ⇒ c = 6）。
    assert(hovers['显式赋值 b = 5'].includes('b: Mid = 5'), hovers['显式赋值 b = 5']);
    assert(hovers['显式赋值 + 类型 c: t.u8'].includes('c: Mid = 6'), hovers['显式赋值 + 类型 c: t.u8']);
    // 使用点同样显示推导值（同一份声明）。
    assert(hovers['使用点 ASTFlag.IsAsync'].includes('IsAsync: ASTFlag = 0'), hovers['使用点 ASTFlag.IsAsync']);
    // 旧写法（CEnum 子类）保持原样，不受影响。
    assert(hovers['旧写法 RED: t.State = 0'].includes('RED: t.State'), hovers['旧写法 RED: t.State = 0']);

    program.dispose();
    serviceProvider.dispose();
});

test('enum X: 裸名成员被识别为枚举成员，取值从 0 递增', () => {
    const code = `import t

enum ASTFlag:
    IsAsync
    Simple
    HasStar: int

def use_enum() -> int:
    a: int = ASTFlag.IsAsync
    b: int = ASTFlag.Simple
    c: int = ASTFlag.HasStar
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const memberTypes = collectMemberAccessTypes(program, parseResults, ['IsAsync', 'Simple', 'HasStar']);
    console.log('=== 成员访问类型 ===');
    memberTypes.forEach((m) => console.log(`  L${m.line} .${m.member}: ${m.type}`));
    assert.strictEqual(memberTypes.length, 3, `成员访问未全部收集：${JSON.stringify(memberTypes)}`);
    memberTypes.forEach((m) => {
        assert(m.type.includes('ASTFlag'), `成员 .${m.member} 应解析为 ASTFlag 枚举类型：${m.type}`);
    });

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));
    assertNoUndefinedOrUnused(diagnostics);

    const errors = diagnostics.filter((d) => d.includes('category=0') || d.includes('category=1'));
    assert.strictEqual(errors.length, 0, `不应有错误：${JSON.stringify(diagnostics, undefined, 2)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('enum X: a, b, c 同行使 + 换行 TAB 续写', () => {
    const code = `import t

enum X: a, b, c
    d

def use_x() -> int:
    v: int = X.d
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const memberTypes = collectMemberAccessTypes(program, parseResults, ['a', 'b', 'c', 'd']);
    console.log('=== 成员访问类型 ===');
    memberTypes.forEach((m) => console.log(`  L${m.line} .${m.member}: ${m.type}`));
    assert.strictEqual(memberTypes.length, 1, `应收集到 1 个成员访问：${JSON.stringify(memberTypes)}`);
    assert(memberTypes[0].type.includes('X'), `成员 .d 应解析为 X 枚举类型：${memberTypes[0].type}`);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));
    assertNoUndefinedOrUnused(diagnostics);

    const errors = diagnostics.filter((d) => d.includes('category=0') || d.includes('category=1'));
    assert.strictEqual(errors.length, 0, `不应有错误：${JSON.stringify(diagnostics, undefined, 2)}`);

    program.dispose();
    serviceProvider.dispose();
});

test('enum X: 推导值超出成员声明类型（i1 存不下 2）报错', () => {
    const code = `import t

enum Small:
    a
    b
    c: t.i1

def use_small() -> int:
    v: int = Small.a
    return 0
`;
    const { program, configOptions, uri, serviceProvider } = buildProgramForCode(code);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));
    assertNoUndefinedOrUnused(diagnostics);

    const rangeErrors = diagnostics.filter((d) => d.includes('i1') && d.includes('2'));
    assert.strictEqual(
        rangeErrors.length,
        1,
        `应恰好报 1 个 i1 溢出错误：${JSON.stringify(diagnostics, undefined, 2)}`
    );
    assert(rangeErrors[0].includes('line=6'), `应报在 c 所在行（第 6 行）：${rangeErrors[0]}`);

    program.dispose();
    serviceProvider.dispose();
});

test('enum X: 中间显式赋值后继续递增，取值在范围内不报错', () => {
    const code = `import t

enum Mid:
    a
    b = 5
    c: t.u8

def use_mid() -> int:
    v: int = Mid.c
    return 0
`;
    const { program, configOptions, uri, serviceProvider } = buildProgramForCode(code);

    const diagnostics = getDiagnostics(program, configOptions, uri);
    console.log('=== 诊断 ===');
    diagnostics.forEach((d) => console.log(`  ${d}`));
    assertNoUndefinedOrUnused(diagnostics);

    const errors = diagnostics.filter((d) => d.includes('category=0') || d.includes('category=1'));
    assert.strictEqual(errors.length, 0, `不应有错误：${JSON.stringify(diagnostics, undefined, 2)}`);

    program.dispose();
    serviceProvider.dispose();
});
