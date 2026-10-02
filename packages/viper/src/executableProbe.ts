/*
 * executableProbe.ts
 * VET 未启用时的**本地**编译器校验（VET check 通道的 TypeScript 模拟）。
 *
 * 背景：手动「选择编译器…」原先只能经 VET 的 check 通道（stdin 请求 → stdout 回执），
 * 而该通道依附常驻进程与心跳看门狗 —— VET 被禁用 / 手动停止 / 启动失败 / 未开
 * confirmSeconds 时，选编译器直接失败。本模块用 TS 复刻同一条口径，使 VET 缺席时仍可选用：
 *   ① 读 PE：DOS/PE 头 → 节表 → `.PRVERSN` 段 → 版本串；COFF Machine → arch
 *      （与 VET/App/lib/VPe.vp 的 TryReadPeInfo + ParsePeHead 逐条同口径，小端读取用
 *       逐字节"或 + 移位"的位操作，不用 Buffer 的 LE 读取）
 *   ② 执行 `<exe> --version`：合并捕获 stdout+stderr，**5 秒超时**（与 VProc.RunVersionProbe
 *      的 VERSION_PROBE_TIMEOUT_MS 一致），输出前 5 字符必须是 "Viper"
 *
 * 失败原因串与 VET 的 check_msg **逐字一致**（NOT_FOUND / NO_PERMISSION / NOT_EXE /
 * NO_PRVERSN / PRVERSN_ERR / PREFIX_ERR / TIMEOUT / EXE_ERR,0x<HEX>），故调用方沿用
 * 同一套文案（extension.DescribeCheckMessage）即可，不必区分"校验来自 VET 还是本地"。
 *
 * 只读不写：本地检查不落盘、不入库（VET 会把它写进自己的缓存文件，这里没有缓存）。
 */

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

import type { ViperCheckResult } from './types';

// ===== PE/COFF 常量（与 VET/App/lib/VPe.vp 一一对应） =====

const DosSignature = 0x5a4d; // "MZ" 小端
const NtSignature = 0x00004550; // "PE\0\0" 小端
const OptMagicPe32 = 0x10b;
const OptMagicPe32Plus = 0x20b;
const SecEntrySize = 40;

const ELfanewOffset = 0x3c; // DOS 头 e_lfanew
const CoffMachineOffset = 4; // PE签名(4) + COFF: Machine @ COFF+0
const CoffNumSectionsOffset = 6; // PE签名(4) + COFF: NumberOfSections @ COFF+2
const CoffOptSizeOffset = 20; // PE签名(4) + COFF: SizeOfOptionalHeader @ COFF+16
const OptMagicOffset = 24; // PE签名(4) + COFF(20) 之后为可选头 Magic

const SecNameOffset = 0;
const SecRawSizeOffset = 16;
const SecRawPtrOffset = 20;
const VersionSectionName = '.PRVERSN';

const PeHeadRead = 8192; // 头部窗口（DOS + COFF + 可选头 + 节表），与 VPe.PE_HEAD_READ 同值
const VersionCap = 128; // .PRVERSN 版本串上限（VPe.VER_CAP）
const VersionProbeCap = 4096; // --version 捕获上限（VProc.VERSION_PROBE_DIAG_CAP）
const VersionProbeTimeoutMs = 5000; // --version 探测超时（VProc.VERSION_PROBE_TIMEOUT_MS）
const VersionPrefix = 'Viper'; // --version 输出前缀（VProc.VERSION_PREFIX）

/** check 失败原因串（与 VET VCheck 的 CK_* 常量逐字一致）。 */
export const CheckReason = {
    NotFound: 'NOT_FOUND',
    NoPermission: 'NO_PERMISSION',
    NotExe: 'NOT_EXE',
    NoPrversn: 'NO_PRVERSN',
    PrversnErr: 'PRVERSN_ERR',
    PrefixErr: 'PREFIX_ERR',
    Timeout: 'TIMEOUT',
} as const;

// ===== 小端读取（逐字节位操作，与 VPe.ReadU16 / ReadU32 同口径） =====

/** 小端读 u16。 */
function ReadU16(buf: Buffer, offset: number): number {
    return buf[offset] | (buf[offset + 1] << 8);
}

/** 小端读 u32（`>>> 0` 归为无符号，避免最高位为 1 时按有符号数参与比较）。 */
function ReadU32(buf: Buffer, offset: number): number {
    return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

/** COFF Machine → arch 字符串（与 VPe.FillArch 的不同取值分支一致）。 */
function MachineToArch(machine: number): string {
    switch (machine) {
        case 0x8664:
            return 'x86_64';
        case 0x14c:
            return 'x86';
        case 0xaa64:
            return 'arm64';
        case 0x1c0:
        case 0x1c4:
            return 'arm';
        default:
            // 与 VPe 的 snprintf("unknown(0x%X)") 同格式：大写十六进制、不补零
            return `unknown(0x${machine.toString(16).toUpperCase()})`;
    }
}

/**
 * PE 解析失败码 → 固定原因串（与 VET VCheck.MapPeFailure 同口径）。
 * 本模块只发出 rc=6/7（.PRVERSN 段越界/读取失败）与 100+prc（ParsePeHead 的解析码）。
 */
function MapPeFailure(rc: number): string {
    if (rc === 6 || rc === 7) {
        return CheckReason.PrversnErr;
    }
    if (rc >= 100) {
        const parseRc = rc - 100;
        if (parseRc === 7) {
            return CheckReason.NoPrversn; // 未找到 .PRVERSN
        }
        if (parseRc === 6) {
            return CheckReason.PrversnErr; // 节表超出头部窗口（无法定位段）
        }
    }
    return CheckReason.NotExe;
}

/** 打开失败 → NOT_FOUND / NO_PERMISSION（与 VET 的 OpenErr 口径：找不到文件才算 NOT_FOUND，其余归无权限）。 */
function MapOpenFailure(error: unknown): string {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? CheckReason.NotFound : CheckReason.NoPermission;
}

/** 取段内容里到第一个 NUL 为止的版本串（长度上限 VersionCap-1 = 127，与 VPe.CopyVersion 一致）。 */
function CopyVersion(buf: Buffer, offset: number, length: number): string {
    let n = 0;
    while (n < length && n < VersionCap - 1) {
        if (buf[offset + n] === 0) {
            break;
        }
        n++;
    }
    return buf.toString('utf8', offset, offset + n);
}

/** 从头部窗口解析 PE：节表里找 `.PRVERSN`，取段位置（raw_ptr / raw_size）与 arch。 */
function ParsePeHead(
    head: Buffer,
    got: number
): { Ok: true; RawPtr: number; RawSize: number; Arch: string } | { Ok: false; Message: string } {
    // 各失败码与 VPe.ParsePeHead 的 prc 编码一致（101=窗口不足 … 107=未找到 .PRVERSN）
    if (got < 0x40) {
        return { Ok: false, Message: MapPeFailure(101) };
    }
    if (ReadU16(head, 0) !== DosSignature) {
        return { Ok: false, Message: MapPeFailure(102) };
    }
    const lfanew = ReadU32(head, ELfanewOffset);
    if (lfanew + 24 > got) {
        return { Ok: false, Message: MapPeFailure(103) };
    }
    if (ReadU32(head, lfanew) !== NtSignature) {
        return { Ok: false, Message: MapPeFailure(104) };
    }

    const numSections = ReadU16(head, lfanew + CoffNumSectionsOffset);
    const optSize = ReadU16(head, lfanew + CoffOptSizeOffset);
    const magic = ReadU16(head, lfanew + OptMagicOffset);
    if (magic !== OptMagicPe32 && magic !== OptMagicPe32Plus) {
        return { Ok: false, Message: MapPeFailure(105) };
    }
    const machine = ReadU16(head, lfanew + CoffMachineOffset);

    const sectionTableOffset = lfanew + 24 + optSize;
    if (sectionTableOffset + numSections * SecEntrySize > got) {
        return { Ok: false, Message: MapPeFailure(106) };
    }

    for (let index = 0; index < numSections; index++) {
        const entry = sectionTableOffset + index * SecEntrySize;
        // 节名恰为 8 字节的 ".PRVERSN"（与 VPe 的 strncmp(name, ".PRVERSN", 8) 等价）
        const name = head.toString('latin1', entry + SecNameOffset, entry + SecNameOffset + 8);
        if (name === VersionSectionName) {
            return {
                Ok: true,
                RawPtr: ReadU32(head, entry + SecRawPtrOffset),
                RawSize: ReadU32(head, entry + SecRawSizeOffset),
                Arch: MachineToArch(machine),
            };
        }
    }
    return { Ok: false, Message: MapPeFailure(107) };
}

/**
 * 读一个 exe 的 `.PRVERSN` 版本串与 arch（check 的第 ① 步）。
 * 成功返回版本串 + arch；失败返回固定原因串（可直接作为 check_msg 展示）。
 *
 * 与 VET 的差别只在"段内容不在头部窗口时怎么拿"：VET 因 Win32 seek 传参缺陷改走整文件读，
 * 这里按段位置定位读（得到同一段字节，且不必把上百 MB 的 exe 读进内存）。
 */
function ReadPeVersionInfo(
    exePath: string
): { Ok: true; Version: string; Arch: string } | { Ok: false; Message: string } {
    let fd: number;
    try {
        fd = fs.openSync(exePath, 'r');
    } catch (error) {
        return { Ok: false, Message: MapOpenFailure(error) };
    }

    try {
        const fileSize = fs.fstatSync(fd).size;
        if (fileSize < 0x40) {
            return { Ok: false, Message: CheckReason.NotExe };
        }

        const headCap = Math.min(PeHeadRead, fileSize);
        const head = Buffer.alloc(headCap);
        const got = fs.readSync(fd, head, 0, headCap, 0);
        if (got < 0x40) {
            // 文件在"取大小"与"读头部"之间被改小等极端情形：读不出头部即非有效 PE
            // （VET 用 rc=5，其 MapPeFailure 归到 NO_PRVERSN；这里按语义归 NOT_EXE）
            return { Ok: false, Message: CheckReason.NotExe };
        }

        const parsed = ParsePeHead(head, got);
        if (!parsed.Ok) {
            return { Ok: false, Message: parsed.Message };
        }

        const { RawPtr, RawSize, Arch } = parsed;
        if (RawSize === 0 || RawPtr + RawSize > fileSize) {
            return { Ok: false, Message: MapPeFailure(6) };
        }

        let section = head;
        let sectionOffset = RawPtr;
        if (RawPtr + RawSize > got) {
            section = Buffer.alloc(RawSize);
            const readBytes = fs.readSync(fd, section, 0, RawSize, RawPtr);
            if (readBytes < RawSize) {
                return { Ok: false, Message: MapPeFailure(7) };
            }
            sectionOffset = 0;
        }

        const version = CopyVersion(section, sectionOffset, RawSize);
        if (version.length === 0) {
            // 段在但内容为空（首字节即 NUL）——与 VET CheckExecutable 的判据一致
            return { Ok: false, Message: CheckReason.PrversnErr };
        }
        return { Ok: true, Version: version, Arch };
    } catch {
        return { Ok: false, Message: CheckReason.NoPermission };
    } finally {
        try {
            fs.closeSync(fd);
        } catch {
            // 关闭失败无关紧要（进程会释放句柄）
        }
    }
}

/** 拉起失败 → `EXE_ERR,0x<大写十六进制>`（与 VET VCheck.FormatExeErr 同格式）。 */
function FormatExeErr(error: unknown): string {
    const err = error as NodeJS.ErrnoException;
    let code = 0;
    if (err.code === 'ENOENT') {
        code = 2; // Win32 ERROR_FILE_NOT_FOUND
    } else if (err.code === 'EACCES' || err.code === 'EPERM') {
        code = 5; // Win32 ERROR_ACCESS_DENIED
    } else if (typeof err.errno === 'number' && err.errno > 0) {
        code = err.errno;
    }
    return `EXE_ERR,0x${code.toString(16).toUpperCase()}`;
}

/**
 * 从捕获输出里取**第一行有效内容**：跳过以 `[` 开头的诊断行（以及空行）后继续往下读。
 *
 * 为什么需要：编译器是带 ASan 运行时的构建，`<exe> --version` 会先在 stderr 打几行
 * `[traceback] …`（如 `[traceback] ready: Ctrl+C prints stack then exits, …`），
 * 之后才在 stdout 打真正的 `Viper 1.0.5-dev.970 …`。VET 把两条流接到同一个管道，
 * 靠"整个缓冲前 5 字符"判定；Node 侧两条流分开、到达顺序不定，故显式跳过 `[` 开头的行，
 * 再对第一行有效内容判前缀（同时对行首空白宽容，避免缩进导致误判）。
 */
function FirstMeaningfulLine(output: string): string {
    for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        if (trimmed.length === 0 || trimmed.startsWith('[')) {
            continue;
        }
        return trimmed;
    }
    return '';
}

/**
 * 执行 `<exe> --version`（check 的第 ② 步）：合并捕获 stdout+stderr、5 秒超时、
 * 第一行有效内容的前 5 字符必须是 "Viper"（`[` 开头的诊断行跳过，见 FirstMeaningfulLine）。
 *
 * 与 VET 的差别：VET 把 stdout 与 stderr 接到**同一个**管道；Node 做不到，故按到达顺序
 * 追加到同一缓冲。只判第一行有效内容，两种接法结论一致。
 */
function ProbeVersion(exePath: string): Promise<{ Ok: true } | { Ok: false; Message: string }> {
    let child: ChildProcess;
    try {
        child = spawn(exePath, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        return Promise.resolve({ Ok: false, Message: FormatExeErr(error) });
    }

    return new Promise((resolve) => {
        let output = '';
        let settled = false;
        let timedOut = false;

        const Finish = (result: { Ok: true } | { Ok: false; Message: string }): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            } catch {
                // 进程可能已退出：忽略
            }
            Finish({ Ok: false, Message: CheckReason.Timeout });
        }, VersionProbeTimeoutMs);

        const Capture = (chunk: Buffer): void => {
            if (output.length >= VersionProbeCap) {
                return;
            }
            output = (output + chunk.toString('utf8')).slice(0, VersionProbeCap);
        };

        child.stdout?.on('data', Capture);
        child.stderr?.on('data', Capture);
        child.on('error', (error) => Finish({ Ok: false, Message: FormatExeErr(error) }));
        child.on('close', () => {
            if (timedOut) {
                return; // 超时已回执，忽略随后的 close
            }
            Finish(
                FirstMeaningfulLine(output).startsWith(VersionPrefix)
                    ? { Ok: true }
                    : { Ok: false, Message: CheckReason.PrefixErr }
            );
        });
    });
}

/**
 * 本地校验一个编译器：读 PE/.PRVERSN + `<exe> --version`（VET check 通道的 TS 模拟）。
 * 失败原因串与 VET 的 check_msg 一致，调用方可直接用同一套文案解释。
 * 返回的 Id 固定 0：本地检查不经"请求 id / 回执配对"。
 *
 * @param log 可选的日志出口（接进 "Vipeye VET" 输出通道），用于留下"这一步做了什么"。
 */
export async function LocalCheckExecutable(
    exePath: string,
    log?: (line: string) => void
): Promise<ViperCheckResult> {
    const pe = ReadPeVersionInfo(exePath);
    if (!pe.Ok) {
        log?.(`[probe] PE 检查未通过: ${pe.Message}`);
        return { Ok: false, Id: 0, Message: pe.Message };
    }

    const probe = await ProbeVersion(exePath);
    if (!probe.Ok) {
        log?.(`[probe] --version 检查未通过: ${probe.Message}`);
        return { Ok: false, Id: 0, Message: probe.Message };
    }

    log?.(`[probe] 检查通过: Viper ${pe.Version}（${pe.Arch}）`);
    return {
        Ok: true,
        Id: 0,
        Environment: {
            Id: randomUUID(),
            Executable: exePath,
            Version: pe.Version,
            Arch: pe.Arch,
            // 与 VET check 命中入库时的 source 取值一致（同一语义：本次答复的来源）
            Source: 'check',
            DisplayName: `Viper ${pe.Version}`,
        },
    };
}
