# Change Log

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
