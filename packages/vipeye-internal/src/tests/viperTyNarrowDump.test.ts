/*
 * viperTyNarrowDump.test.ts — 临时复现 target_alloca.Ty 收窄为 CPtr[None]
 */

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
import { MemberAccessNode } from '../parser/parseNodes';

(global as any).__rootDirectory = path.resolve();

const TRANSPYC_INCLUDES = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\includes';
const TPV_APP = 'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\TransPyV\\App';
const ASSIGN_GEN =
    'd:\\Users\\TermiNexus\\Desktop\\TransPyC\\TransPyV\\App\\lib\\core\\Gen\\AssignGenMixin.vp';

function buildProgram(targetPath: string, extraPaths: string[]) {
    const tempFile = new RealTempFile();
    const serviceProvider = createServiceProvider(createFromRealFileSystem(tempFile), new NullConsole(), tempFile);
    const projectRoot = UriEx.file(path.dirname(targetPath));
    const configOptions = new ConfigOptions(projectRoot);
    configOptions.internalTestMode = true;
    configOptions.initializeTypeCheckingMode('standard');

    const execEnv = new ExecutionEnvironment(
        'python',
        projectRoot,
        configOptions.diagnosticRuleSet,
        configOptions.defaultPythonVersion,
        configOptions.defaultPythonPlatform,
        [projectRoot, ...extraPaths.map((p) => UriEx.file(p))],
        /* skipNativeLibraries */ false,
        /* defaultDialect */ 'viper'
    );
    configOptions.executionEnvironments = [execEnv];

    const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));
    const program = new Program(importResolver, configOptions, serviceProvider);

    const uri = UriEx.file(targetPath);
    program.setTrackedFiles([uri]);
    while (program.analyze()) {
        // 循环
    }

    const sourceFile = program.getSourceFile(uri);
    const parseResults = sourceFile!.getParseResults();
    return { program, configOptions, parseResults, uri, serviceProvider };
}

test('AssignGenMixin.vp 守卫后 .Ty/.Pointee 不误收窄为 CPtr[None]', () => {
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(ASSIGN_GEN, [
        TRANSPYC_INCLUDES,
        TPV_APP,
    ]);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    const out: string[] = [];
    if (evaluator && parseResults) {
        const ev = evaluator;
        const lines = parseResults.parserOutput.lines;
        const pointeeTypes: string[] = [];
        const tyTypes: string[] = [];
        class TyCollector extends ParseTreeWalker {
            override visitMemberAccess(node: MemberAccessNode) {
                const pos = convertOffsetToPosition(node.start, lines);
                if (pos.line < 943 || pos.line > 967) {
                    return true;
                }
                const memberName = (node.d.member as any)?.d?.value ?? '?';
                const t = ev.getType(node as any);
                const printed = t ? program.printType(t) : '(undefined)';
                if (memberName === 'Pointee') {
                    pointeeTypes.push(printed);
                } else if (memberName === 'Ty') {
                    tyTypes.push(printed);
                }
                out.push(`  L${pos.line + 1} .${memberName}: ${printed}`);
                return true;
            }
        }
        new TyCollector().walk(parseResults.parserOutput.parseTree);

        // 核心断言 1：`if target_alloca.Ty is None:` 守卫之后，.Ty 不再被误窄化为 CPtr[None]
        //（None 是空指针取值，is None 正测试不改变 CPtr 指针类型本身）
        expect(tyTypes.some((s) => s.includes('[None]'))).toBe(false);
        expect(tyTypes.every((s) => s === 'rawptr[LLVMType]')).toBe(true);

        // 核心断言 2：守卫之后 .Pointee 可正常解析（原报"无法访问类'None'的属性'Pointee'"）
        expect(pointeeTypes.some((s) => s === 'Unknown')).toBe(false);
        expect(pointeeTypes.every((s) => s === 'rawptr[LLVMType]')).toBe(true);

        // 核心断言 3：L944-968 范围内不应再出现"无法访问/未定义"诊断
        const sourceFile = program.getSourceFile(uri);
        const diags = sourceFile!.getDiagnostics(configOptions) || [];
        const rangeDiags = diags.filter((d: any) => {
            const line = d.range ? d.range.start.line + 1 : -1;
            return line >= 944 && line <= 968;
        });
        expect(rangeDiags.length).toBe(0);
        rangeDiags.forEach((d: any) => {
            out.push(`  [category=${d.category}][line=${(d.range?.start.line ?? -1) + 1}] ${d.message}`);
        });
    }

    require('fs').writeFileSync(path.join(__dirname, '__ty_narrow_dump.txt'), out.join('\n') + '\n', 'utf8');
    program.dispose();
    serviceProvider.dispose();
});

test('AssignGenMixin.vp match 变体模式内 rhs_val.Ty 保持指针形态 CPtr[Struct]', () => {
    const { program, configOptions, parseResults, uri, serviceProvider } = buildProgram(ASSIGN_GEN, [
        TRANSPYC_INCLUDES,
        TPV_APP,
    ]);

    const evaluator = program.evaluator as TypeEvaluator | undefined;
    const out: string[] = [];
    if (evaluator && parseResults) {
        const ev = evaluator;
        const lines = parseResults.parserOutput.lines;
        // 不再写死行号：TransPyC 源码行号会漂移（该文件已从 L2013 漂到 L2527），
        // 改为扫描全文所有 `rhs_val.Ty` 成员访问，断言其类型始终是指针形态。
        const tyByLine: Array<{ line: number; type: string }> = [];
        class TyCollector extends ParseTreeWalker {
            override visitMemberAccess(node: MemberAccessNode) {
                const memberName = (node.d.member as any)?.d?.value ?? '?';
                const baseName = (node.d.leftExpr as any)?.d?.value;
                // 只关注 `rhs_val.Ty`；文件里还有 `tgt_alloca.Ty`（另一个变量）不属于本用例。
                if (memberName !== 'Ty' || baseName !== 'rhs_val') {
                    return true;
                }
                const pos = convertOffsetToPosition(node.start, lines);
                const t = ev.getType(node as any);
                tyByLine.push({ line: pos.line + 1, type: t ? program.printType(t) : '(undefined)' });
                out.push(`  L${pos.line + 1} .${memberName}: ${t ? program.printType(t) : '(undefined)'}`);
                return true;
            }
        }
        new TyCollector().walk(parseResults.parserOutput.parseTree);

        // 断言 1：必须确实扫到 `rhs_val.Ty`（源码若再漂移/删改，本用例应显式失败而非静默通过）
        expect(tyByLine.length).toBeGreaterThan(0);

        // 断言 2：rhs_val.Ty 声明为 `LLVMType | t.CPtr`（折叠为 rawptr[LLVMType]），
        // 在 `match rhs_val.Ty:` 的 `case LLVMType.Struct(...)` 体内应保持指针形态
        // rawptr[Struct]，不得被误收窄为值类型 Struct（原导致 build_alloca 等报
        // "Struct 不可分配给 rawptr[LLVMType]"）。
        expect(tyByLine.some((e) => e.type === 'Struct')).toBe(false);
        expect(tyByLine.every((e) => e.type.includes('rawptr['))).toBe(true);

        // 断言 3：全文不得出现 "Struct → rawptr[...]" 形态的赋值不兼容诊断
        const sourceFile = program.getSourceFile(uri);
        const diags = sourceFile!.getDiagnostics(configOptions) || [];
        const narrowDiags = diags.filter((d: any) => {
            const msg = d.message;
            return msg.includes('不可分配') && msg.includes('Struct') && msg.includes('rawptr');
        });
        expect(narrowDiags.length).toBe(0);
        narrowDiags.forEach((d: any) => {
            out.push(`  [category=${d.category}][line=${(d.range?.start.line ?? -1) + 1}] ${d.message}`);
        });
    }

    require('fs').writeFileSync(path.join(__dirname, '__ty_narrow_dump.txt'), out.join('\n') + '\n', 'utf8');
    program.dispose();
    serviceProvider.dispose();
});
