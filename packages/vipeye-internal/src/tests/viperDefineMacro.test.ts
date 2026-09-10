/*
 * viperDefineMacro.test.ts
 *
 * 验证 Viper define 宏函数关键字（语法与 def 完全一致，语义为编译期宏展开）：
 *   - `define square(x) -> int` 解析为 FunctionNode 且 isDefine=true（普通 def 为 false）
 *   - 宏函数名在定义处与调用处显示为 macro（深蓝色）；普通 def 函数名仍为 function
 *   - 宏函数与普通函数一样参与类型分析（无诊断错误）
 *
 * 运行：npx jest src/tests/viperDefineMacro.test.ts --runInBand
 */

import assert from 'assert';
import * as path from 'path';

import { ImportResolver } from '../analyzer/importResolver';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { RealTempFile, createFromRealFileSystem } from '../common/realFileSystem';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { UriEx } from '../common/uri/uriUtils';
import { FullAccessHost } from '../common/fullAccessHost';
import { FunctionNode } from '../parser/parseNodes';
import { SemanticTokenTypes } from '../languageService/semanticTokenTypes';

(global as any).__rootDirectory = path.resolve();

function buildProgram(files: Record<string, string>) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const fs = require('fs');
    const testRoot = path.join(__dirname, '__define_macro__');
    fs.rmSync(testRoot, { recursive: true, force: true });
    for (const [relPath, content] of Object.entries(files)) {
        const absPath = path.join(testRoot, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf8');
    }

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

    const uris = Object.keys(files).map((relPath) => UriEx.file(path.join(testRoot, relPath)));
    const urisMap: Record<string, any> = {};
    for (const relPath of Object.keys(files)) {
        urisMap[relPath] = UriEx.file(path.join(testRoot, relPath));
    }
    program.setTrackedFiles(uris);
    while (program.analyze()) {
        // 循环
    }

    return { program, configOptions, urisMap, testRoot, serviceProvider };
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
        if (!map.has(cursorLine)) {
            map.set(cursorLine, []);
        }
        map.get(cursorLine)!.push({ start: cursorChar, text, tokenType, tokenModifiers: tokenMod });
    }
    return map;
}

test('define 宏函数：解析为 FunctionNode 且 isDefine=true，普通 def 为 false，无诊断错误', () => {
    const { program, configOptions, urisMap } = buildProgram({
        'main.vp': `define A():
    pass

def B():
    A()
`,
    });

    // 1. 无诊断错误（宏函数与普通函数一样参与类型分析）
    const mainDiags = getDiagnostics(program, configOptions, urisMap['main.vp']);
    assert(
        mainDiags.length === 0,
        `main.vp 不应有诊断，实际: ${JSON.stringify(mainDiags)}`
    );

    // 2. AST：A 是 define 宏函数（isDefine=true），B 是普通函数（isDefine=false）
    const sourceFile = program.getSourceFile(urisMap['main.vp']);
    const parseResults = sourceFile!.getParseResults();
    assert(parseResults, 'parse results not found');

    const isDefineMap = new Map<string, boolean>();
    class FunctionIsDefineWalker extends ParseTreeWalker {
        override visitFunction(node: FunctionNode): boolean {
            isDefineMap.set(node.d.name.d.value, node.d.isDefine);
            return true;
        }
    }
    new FunctionIsDefineWalker().walk(parseResults.parserOutput.parseTree);
    assert(isDefineMap.get('A') === true, 'A 应标记为 define 宏函数');
    assert(isDefineMap.get('B') === false, 'B 应为普通函数（isDefine=false）');
});

test('define 宏函数：定义处与调用处的函数名显示为 macro，普通 def 仍为 function', () => {
    const { program, urisMap } = buildProgram({
        'main.vp': `define A():
    pass

def B():
    A()
`,
    });

    const tokens = getSemanticTokens(program, urisMap['main.vp']);
    const lineTokens = (line: number) => tokens.get(line) || [];

    // 第 0 行 `define A():`：A 定义处 → macro
    const defineTokens = lineTokens(0).filter((t) => t.text === 'A');
    assert(defineTokens.length === 1, '应找到 A 定义处语义 token');
    assert(defineTokens[0].tokenType === SemanticTokenTypes.macro, 'A 定义处应为 macro');

    // 第 4 行 `    A()`：A 调用处 → macro
    const callTokens = lineTokens(4).filter((t) => t.text === 'A');
    assert(callTokens.length === 1, '应找到 A 调用处语义 token');
    assert(callTokens[0].tokenType === SemanticTokenTypes.macro, 'A 调用处应为 macro');

    // 第 3 行 `def B():`：B 定义处 → function（普通函数不受影响）
    const bDef = lineTokens(3).find((t) => t.text === 'B');
    assert(bDef, '应找到 B 定义处语义 token');
    assert(bDef.tokenType === SemanticTokenTypes.function, 'B 定义处应为 function');
});
