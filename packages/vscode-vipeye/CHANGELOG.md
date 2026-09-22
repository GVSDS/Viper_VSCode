# Change Log

## 1.1.425

- New `typedef T1 = T2` statement, fully equivalent to `T1: t.CTypedef = T2`. It desugars in the parser into the same annotated-assignment tree (synthetic zero-length `t.CTypedef`), so binding, type evaluation, hover and semantic highlighting all behave identically — and it works without the file having to `import t`. `typedef` is a soft keyword, so `typedef = 1` / `typedef(x)` still parse as before. `typedef` is also highlighted as a declaration keyword now
- `(T)x` casts are accepted alongside `(T*)x`: when the parenthesized expression is a type atom (a name, `t.CInt`, a subscript, or `T*`) and an operand follows, it is normalized into the equivalent `T(x)` call. `(T*)[i]` stays a subscript and `(a)*b` stays a multiplication

## 1.1.424

- C-style casts now accept the pointer spellings used by TransPyC: `(T*)x`, `(T*)(x)` and `T*(x)` all evaluate to the pointer type (`CPtr[T]`). Inside parentheses or call arguments `T*` is read as a pointer *type* when the operand is a type object, and a binary `*` whose left operand is a type object is read as a cast — so `2 * 3` / `offset * 2` still multiply. `(T*)a + b` groups as `((T*)a) + b`, and `(T*)[i]` remains a subscript

## 1.1.423

- Parser: the C pointer suffix (`T*` / `T**`) is now recognized in call arguments, not only inside type annotations, so `va_arg(ap, int64*)` / `short*` / `int*` (as used by TransPyC's `viperlib.vp`) parse correctly. Real multiplication and power expressions (`a * b`, `a ** b`, `N * 2`) are unaffected
- `str | t.CPtr` / `bytes | t.CPtr` now fold to `CPtr[str]` / `CPtr[bytes]` (`i8**`, e.g. `argv`), and indexing such a pointer yields the pointee (`str` / `bytes`) instead of `char` — fixes `token: str = entry[0]` being reported as `char` not assignable to `str` (`argparse.vp`)
- C-style casts targeting a plain built-in type are accepted: `char(addr, t.CPtr)` (used by `memhub.vp` / `requests.vp`) no longer fails `char.__new__`'s `base: SupportsIndex` overload. The rule requires the second argument to be a type object, so Python's `int("12", 16)` is unaffected
- `flowChartCommand` now passes a `CancellationToken` to `AnalyzerService.run`, fixing a TS2554 error that blocked five test suites
- Test maintenance: the stale `ord` signature assertion was updated (TransPyC now declares `def ord(s: char) -> int`), and the `AssignGenMixin.vp` narrowing guard no longer hard-codes line numbers, so it survives source drift

## 1.1.422

- `str` / `bytes` iteration now yields `char` as well: `for ch in s` and `Iterable` / `Iterator` argument inference (`enumerate`, `zip`, `map`, `filter`, `reversed`, `sorted`, `list()` …) bind the element type to `char`, matching subscript `s[i]` and dereference `*s`. The old `t.CChar`-aliased `int` construction is removed

## 1.1.421

- `s[i]` on `str` / `bytes` now yields `char` (`i8`) instead of `t.CChar`, matching the dereference result of `*s` (the two remain implicitly convertible). Covers both the plain subscript path and the type-set subscript path (e.g. `CConst | str | CPtr` style annotations). Iteration and `Iterable` inference were unified in 1.1.422

## 1.1.420

- Pointer semantics for `str` / `bytes` (both are C `char*`, `i8*`) now cover pointer arithmetic and writes, matching the dereference support added earlier: `p + n`, `p - n` and `n + p` return the pointer type instead of reporting `reportOperatorIssue`, and `*p = v` is accepted as an assignment target. Subscript access `p[i]` was already supported
- Built-in C basic type names extended with `short` (`t.CShort`), `ushort` (`t.CUnsignedShort`), `ulong` (`t.CUnsignedLong`) and `ulonglong` (`t.CUnsignedLongLong`), alongside the existing `long` / `longlong`

## 1.1.419

- Dereferencing `str` / `bytes` with the unary `*` operator no longer reports `reportOperatorIssue`: both are C `char*` (`i8*`) in Viper, so `*s` yields `char` (`i8`). Mirrors `t.CPtr[X]` dereferencing, which already returned the pointee type

## 1.1.418

- **Built-in C basic type names**: `long` (`t.CLong`) and `longlong` (`t.CLongLong`) are now built-in typedefs, mirroring the compiler's `_CNAME_ALIAS` table (`char`, `short`, `long`, `unsigned` and friends are language built-ins that need no import). C's `long long` cannot be spelled with a space, so Viper writes `longlong`; the unsigned form stays available as `t.CUnsignedLongLong`

## 1.1.417

- **Built-in C integer typedefs**: `sizet`, `size_t`, `uzt`, `int8`–`uint64`, `intfast*`/`uintfast*`, `intleast*`/`uintleast*` are now declared in the built-in `builtins.vpi` stub, mirroring the compiler's `includes/builtins.vp`. Any Viper project resolves them without configuring `includes`, which fixes `uint32` (and the rest) being reported as undefined in setups where the project-level `builtins.vp` cannot be located — that lookup depends on the workspace root and the set of opened files, so the same project could behave differently across editors
- When a project ships its own `includes/builtins.vp`, its declarations still win: the merge overwrites same-named built-in symbols

## 1.1.416

- **New command `Viper: Cleanup and Deactivate`**: stops the language server of the current window (terminating the server process), disposes every resource the extension registered (commands, sidebar views, status bar, file watchers, flow chart panel), and optionally purges the global semantic highlighting cache (`~/.vipeye/cache/semantic-tokens`). Run it in every window before uninstalling or updating the extension — a running server keeps its working directory inside the extension folder (undeletable on Windows) and the home-directory cache is shared across windows, so otherwise uninstall leaves a half-deleted extension and other windows keep showing stale results even after restarting the extension host. Reload the window to bring Viper back
- Syntax highlighting fix: brackets (`[]{}()`) inside strings, comments and f-string interpolations are no longer colorized by the editor's built-in bracket pair colorization (declared `balancedBracketScopes` / `unbalancedBracketScopes` on the `viper` grammar contribution)
- The semantic highlighting disk cache path is now defined once in `common/pathUtils.ts` and shared by the language server and the extension client

## 1.1.415

- **`[SIZE]T` 数组类型语法**：新增定长数组写法 `[SIZE]T`（等价 `t.CArray[T, SIZE]`）与不定长写法 `[]T`（等价 `t.CArray[T]`）；支持整数字面量 / `t.CDefine` 常量作为长度、多维嵌套 `[2][3]T`、指针元素 `[4]T*`，可用于变量、参数、返回值、类成员、`type X =` 注解以及泛型实参位置（如 `list[[4]int]`）
- `[SIZE]T` 在解析层脱糖为等价的 `t.CArray[T, SIZE]`，因此元素类型、索引返回 `T`、数组名退化为指针、字符数组降级 `str`/`bytes` 等语义与 `t.CArray` 完全一致；hover 按源码原形显示（如 `(variable) buf: [4]t.CInt`），诊断消息同样显示原形
- 修复字符串转义引号（`'\''` / `"\""`）导致 TextMate 语法作用域泄漏、后续关键字被渲染成字符串颜色的问题
- 导入解析：`includes/builtins.vp` 的 typedef 合并缓存改为按「执行环境 + 被分析文件目录」缓存，修复先绑定了工程外文件时 `uint32`/`int8`/`sizet` 等 typedef 集体报"未定义"（同一工程在不同 IDE/不同打开顺序下表现不一致）

## 1.1.414

- **enum 语法**：支持 `enum NAME:` 声明（等价 `class NAME(t.CEnum):`），成员可只写名字（裸名 / 逗号分隔，如 `enum X: a, b, c`），也支持 `enum X: a, b, c` 后换行 TAB 继续写成员
- **enum 取值推导**：成员取值按编译期规则推导（从 0 递增，中间显式赋值后从该值 +1 继续），hover 显示枚举类型与推导值（如 `(variable) IsAsync: ASTFlag = 0`），成员可隐式转换为 `int`
- **define 常量声明**：支持 `define NAME: 类型 = 值` 与 `define NAME = 值`（后者类型由字面量推导）；`define f(...)` 宏函数行为不变
- **整数字面量位宽校验**：字面量无法存入声明类型位宽时报错并提示扩容（如 `int` 为 i32 存不下 10^31），`define` 与普通声明同样适用；位宽表覆盖 `int`/`bool`/`iN`/`uN`/`t.CInt`/`t.CUInt`/`t.CLong`/`t.CInt{n}T`/`t.CUInt{n}T` 等
- 类型检查：枚举成员取值越界复用同一份范围表，避免重复报错

## 1.1.413

- **内置 char 类型**：复刻 int 定义（8 位字符/整型），与 `t.CChar`、`int` 双向隐式转换，`char → float/double` 无损
- **内置 rawptr**：编译器内置裸指针 typedef（`rawptr: t.CTypedef = t.CPtr`），任意工程可直接用 `rawptr[T]`，不依赖项目 includes 配置
- 类型检查：`-> None` 函数只允许裸 `return` / `return None`，`return` 值为 None 的表达式（如调用返回 None 的函数）报错
- 导入解析：builtins.vp 发现扩展到被分析文件祖先目录与 `includes/` 子目录，修复未显式配置 includes 时 `uint64` 等 typedef 报"未定义"
- 语法：类型注解支持下标实参内的 C 指针后缀（如 `list[ast.AST*]*`、`Node**`、`t.CInt*`），不再误报"`[` 未关闭"
- 类型显示：`t.CPtr` 统一显示为编译器内置 `rawptr`（如 `CPtr[list[CPtr[AST]]]` → `rawptr[list[rawptr[AST]]]`）
- 类型显示：无类型参数的别名被下标特化时保留类型实参（如 `rawptr[T]` 不再显示成裸 `rawptr`），修复 `Ty: rawptr[LLVMType]` 的成员访问丢失 `[LLVMType]`

## 1.1.412

- **整合 Viper 核心扩展**：侧边栏活动栏（Project/Toolchain/Settings 视图）、.vpj 项目管理、工具链选择与状态栏并入本扩展，一个包即可使用全部 Viper 功能
- **导入解析**：Viper 语义下支持同目录/上级目录模块绝对导入（如 `import circ_a`、`from flow_test import flow_test`），不再要求目录必须在 extraPaths/workspace root 中
- **函数指针**：`-> None` 函数可赋给任意返回类型的 `t.Callable`（Viper 编译 `-> None` 为 i32 返回 0，编译器对函数指针赋值无签名校验）
- **CArray 单参数**：`t.CArray[T]`（不定长数组，None 结尾）合法，不再误报"应为 2，但收到 1"
- 语义高亮：不存在的模块名与未解析的导入符号（如 `from .visitor import ASTVisitor`）标为 undefined（白色）
- 诊断：Viper 方言下 `reportMissingImports` 降级为 warning（黄色波浪线），与 `reportAttributeAccessIssue` 一致
- 语义高亮：import 别名按实际类型着色（类/函数/模块/常量）
- 语义高亮：`t.CDefine` 常量显示为常量色（variable + readonly）
- 类型检查：CArray → CPtr 数组名退化、CPtr → CArray 形参调整
- 类型检查：派生类实例 → 基类指针 upcast（`CPtr[Expression]` → `CPtr[AST]`）
- 类型检查：`os._win32` 等子模块合并解析，多子模块访问不再误报未知属性

## 0.1.0

- Initial release of Vipeye (Viper language support for VS Code)
