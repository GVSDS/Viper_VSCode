/*
 * viperREnumKind.test.ts
 *
 * 验证 Viper REnum（t.REnum）自带 kind() 方法：
 *   - REnum 内存布局为 { i32 __tag, <max_variant_payload> }，
 *     kind() 读取 __tag 判别值，返回 t.CInt（与 ast.AST.kind() 一致）。
 *   - 所有 REnum 类实例（含 `MyEnum | t.CPtr` 折叠的 CPtr[MyEnum]）均可
 *     访问 .kind 成员（解析为 `() -> int` 函数）并调用 .kind()（返回 int）。
 *
 * 运行：npx jest src/tests/viperREnumKind.test.ts --runInBand
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
import { convertOffsetToPosition } from '../common/positionUtils';
import { CallNode, MemberAccessNode } from '../parser/parseNodes';

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
    const testDir = path.join(__dirname, '__renum_kind__');
    fs.mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, 'renum_kind.vp');
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

/**
 * 语义 token 辅助：解码 SemanticTokens 相对编码，返回 line 级 token 映射。
 * 返回 Map<line, Array<{start, text, tokenType, tokenModifiers}>>
 */
function getSemanticTokens(program: Program, uri: any): Map<number, any[]> {
    const { SemanticTokenProvider } = require('../languageService/semanticTokenProvider');
    const { LogTracker } = require('../common/logTracker');
    const provider = new SemanticTokenProvider(new LogTracker());
    const result = provider.provideFull(program, uri);
    assert(result, 'no semantic tokens produced');

    const sourceFile = program.getSourceFile(uri);
    const lines = sourceFile!.getParseResults()!.text.split('\n');

    const map = new Map<number, any[]>();
    let cursorLine = 0;
    let cursorChar = 0;
    for (let i = 0; i < result.data.length; i += 5) {
        const deltaLine = result.data[i];
        const deltaStart = result.data[i + 1];
        const length = result.data[i + 2];
        const tokenType = result.data[i + 3];
        const tokenMod = result.data[i + 4];
        cursorLine += deltaLine;
        cursorChar = deltaLine === 0 ? cursorChar + deltaStart : deltaStart;
        const lineText = lines[cursorLine] || '';
        const text = lineText.substring(cursorChar, cursorChar + length);
        const entry = { start: cursorChar, text, tokenType, tokenModifiers: tokenMod };
        if (!map.has(cursorLine)) {
            map.set(cursorLine, []);
        }
        map.get(cursorLine)!.push(entry);
    }
    return map;
}

test('REnum 自带 kind() 返回 t.CInt（读取 __tag 判别值）', () => {
    const code = `import t, c

class MyEnum(t.REnum):
    class Int:
        Bits: t.CInt

    class Ptr:
        Pointee: MyEnum | t.CPtr

def test_enum(e: MyEnum | t.CPtr) -> int:
    k: t.CInt = e.kind()
    k2: t.CInt = e.kind
    return k + k2

def test_assign() -> int:
    e: MyEnum | t.CPtr = MyEnum.Int(32)
    if e.kind() == 1:
        return 1
    return 0
`;
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgramForCode(code);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    assert(evaluator, 'evaluator not available');
    const ev = evaluator;
    const lines = parseResults.parserOutput.lines;

    // 收集 kind 成员访问与调用类型
    const memberTypes: { line: number; type: string }[] = [];
    const callTypes: { line: number; type: string }[] = [];
    class Collector extends ParseTreeWalker {
        override visitMemberAccess(node: MemberAccessNode) {
            const memberName = (node.d.member as any)?.d?.value ?? '?';
            if (memberName !== 'kind') {
                return true;
            }
            const pos = convertOffsetToPosition(node.start, lines);
            const t = ev.getType(node as any);
            memberTypes.push({
                line: pos.line + 1,
                type: t ? program.printType(t) : '(undefined)',
            });
            return true;
        }
        override visitCall(node: CallNode) {
            const pos = convertOffsetToPosition(node.start, lines);
            const t = ev.getType(node as any);
            callTypes.push({
                line: pos.line + 1,
                type: t ? program.printType(t) : '(undefined)',
            });
            return true;
        }
    }
    new Collector().walk(parseResults.parserOutput.parseTree);

    // 断言 1：e.kind 成员访问解析为函数 () -> int（L11/L12/L17）
    const kindMembers = memberTypes.filter((m) => m.type.includes('->'));
    console.log('=== .kind 成员类型 ===');
    memberTypes.forEach((m) => console.log(`  L${m.line}: ${m.type}`));
    assert(kindMembers.length >= 3, `kind member should resolve to function type: ${JSON.stringify(memberTypes)}`);

    // 断言 2：e.kind() 调用（L11/L17）返回 int
    const kindCalls = callTypes.filter((c) => c.line === 11 || c.line === 17);
    console.log('=== kind() 调用类型 ===');
    callTypes.forEach((c) => console.log(`  L${c.line}: ${c.type}`));
    assert(kindCalls.length >= 2, `kind() calls not found: ${JSON.stringify(callTypes)}`);
    kindCalls.forEach((c) => {
        assert(c.type.includes('int'), `kind() should return int: ${JSON.stringify(c)}`);
    });

    // 断言 3：不得有 category=0/1 错误（kind 不报 unknown member / not callable）
    const diagnostics = getDiagnostics(program, configOptions, uri);
    const errors = diagnostics.filter((d) => d.includes('category=0') || d.includes('category=1'));
    console.log('=== 错误诊断 ===');
    errors.forEach((d) => console.log(`  ${d}`));
    assert.strictEqual(errors.length, 0, `REnum kind should produce no errors: ${JSON.stringify(diagnostics)}`);

    // 断言 4：kind 语义 token 应为 function（2，黄色），而非 variable（3）/property（13）
    const tokensByLine = getSemanticTokens(program, uri);
    for (const line of [11, 12, 17]) {
        const tokens = tokensByLine.get(line - 1);
        assert(tokens, `expected tokens on L${line}: ${JSON.stringify([...tokensByLine.keys()])}`);
        const kindToken = tokens.find((t) => t.text === 'kind');
        assert(kindToken, `expected "kind" token on L${line}: ${JSON.stringify(tokens)}`);
        assert.strictEqual(
            kindToken.tokenType,
            2,
            `"kind" on L${line} should be function(2), got ${kindToken.tokenType} (${JSON.stringify(kindToken)})`
        );
    }

    program.dispose();
    serviceProvider.dispose();
});
