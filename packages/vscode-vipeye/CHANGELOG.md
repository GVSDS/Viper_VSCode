# Change Log

## 1.1.412

- 语义高亮：不存在的模块名与未解析的导入符号（如 `from .visitor import ASTVisitor`）标为 undefined（白色）
- 诊断：Viper 方言下 `reportMissingImports` 降级为 warning（黄色波浪线），与 `reportAttributeAccessIssue` 一致
- 语义高亮：import 别名按实际类型着色（类/函数/模块/常量）
- 语义高亮：`t.CDefine` 常量显示为常量色（variable + readonly）
- 类型检查：CArray → CPtr 数组名退化、CPtr → CArray 形参调整
- 类型检查：派生类实例 → 基类指针 upcast（`CPtr[Expression]` → `CPtr[AST]`）
- 类型检查：`os._win32` 等子模块合并解析，多子模块访问不再误报未知属性

## 0.1.0

- Initial release of Vipeye (Viper language support for VS Code)
