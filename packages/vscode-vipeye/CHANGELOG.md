# Change Log

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
