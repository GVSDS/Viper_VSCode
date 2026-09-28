# Vipeye

Vipeye 是面向 Viper 语言的 VS Code 扩展，提供完整的语言服务支持。

Viper 是一门基于 CPython 语法的 AOT 静态类型语言（编译器为 TransPyC / TPV），与 Python 的语义完全不同。Vipeye 在 Pyright 基础上深度改造而来，现已全面切换为 Viper 语义。

## 功能特性

- **语法高亮**：`.vp` / `.vpi` 文件的完整 Viper 语法高亮（关键字、类型、装饰器 `@`、f-string、常量、未定义符号等语义化区分）
- **语义高亮**：基于 LSP 3.16 SemanticTokens 协议，区分已定义/未定义符号、类/函数/变量/模块/参数/常量
- **类型检查与诊断**：遵循 Viper 语义的类型推断与静态检查
  - 指针语义：`CPtr` / `CArray`（数组名退化、形参调整）、指针隐式转换规则（级数须相同且 pointee 兼容：`void*` 双向放行、基本类型按自身规则、结构体仅允许上转型）
  - 声明/注解修饰符：`const` / `volatile` 类型描述符、`static`（C internal linkage，禁止跨模块取参）、`export` / `extern` 变量（`extern` 不允许初始值）、`virtual` / `novirtual`、`__attribute__(...)`（装饰器与注解修饰器两种写法）
  - `virtual class` 方法槽赋值：`obj.method = func` 按 vtable 槽语义校验（self 为泛指针或该类/父类指针，其余签名相同）
  - `[SIZE]T` 定长数组类型、`typedef T1 = T2`、C 风格强转 `(T)x` / `(T*)x` / `(T*)(x)` / `T*(x)`
  - 类型别名与 C 类型系统：`t.CInt` / `t.CTypedef` / `t.CDefine` / `t.CEnum` 等
  - Viper 特有的 `T | t.CPtr` 指针折叠表示
  - 全局变量访问规则（读/写/global 声明判定）
- **项目支持**：`.vpj` 项目配置文件、`viperconfig.json` 配置
- **代码补全与悬停信息**（`__attribute__(...)` 括号内可直接补全/悬停查看可用属性名）
- **状态栏分析进度**：分析期间显示当前文件与 `N / M` 进度；`viper.countLines` 命令可统计 `.vpj` 项目的代码行数（KPI、分语言图表、明细表）
- **导航**：定义跳转、查找引用、重命名

## 项目架构

- `vscode-vipeye`：LSP 客户端扩展（本包，**已集成 Viper 核心**）
- `vipeye`：Viper 语言命令行类型检查器（pyright 命令行工具改造）
- `vipeye-internal`：核心分析引擎（类型推断、语义高亮、诊断）
- `vipeye-typeserver`：类型服务进程
- `viper`（packages/viper）：Viper 核心源码库（侧边栏活动栏 Project/Toolchain/Settings、.vpj 项目管理、工具链），源码单一，由本包构建时引用打包，不单独发布

## 配置

在 `.vscode/settings.json` 或 `viperconfig.json` 中配置：

```json
{
    "viper.analysis.typeCheckingMode": "standard",
    "viper.analysis.extraPaths": ["d:/path/to/includes"],
    "viper.analysis.diagnosticSeverityOverrides": {
        "reportMissingImports": "warning"
    }
}
```

## License

MIT
