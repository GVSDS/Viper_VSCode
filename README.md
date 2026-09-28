![Vipeye](Viper.png)

# Vipeye — Static Type Checker and Language Server for Viper

Vipeye is a full-featured, standards-based static type checker and language server for **Viper**, written in TypeScript. It is designed for high performance and can be used with large Viper source bases.

Vipeye ships in three forms:

- a **language server** (`vipeye-langserver`) speaking LSP over stdin/stdout;
- a **command-line type checker** (`vipeye`);
- an **extension for Visual Studio Code** (`vscode-vipeye`), which bundles both the LSP client and the Viper core UI (project / toolchain).

It is built on the Pyright codebase, adapted from the ground up to Viper semantics (AOT compilation, C-style type system, pointer and memory semantics). Python analysis is no longer supported — only the Viper dialect is checked.

## What is Viper

Viper is an ahead-of-time (AOT) compiled language whose syntax is modeled on CPython but whose semantics are entirely different:

- **TPC** — the seed compiler, itself based on CPython, used to bootstrap the toolchain.
- **TPV** — the first self-hosted compiler, written in Viper. Once `tpv --lsp` lands, it will replace the Pyright-derived analyzer in this repository.

Vipeye exists to provide type checking, diagnostics and editor intelligence for `.vp` / `.vpi` sources while TPV's own language server is under development.

## Capabilities

### Viper language semantics

- C-style type system: `t.CPtr`, `t.CArray`, `t.CVoid`, `t.CTypedef`, `t.CDefine`, `t.CEnum`, `t.REnum`, plus the compiler built-ins `char`, `double` and `rawptr` (a raw-pointer typedef).
- Pointer and memory semantics: `CPtr[T]` / `rawptr[T]`, `c.Deref`, address-of, pointer arithmetic and indexing; a `__new__` returning a raw pointer is auto-wrapped into `CPtr[T]`.
- C declaration modifiers (`t.CInline`, `t.CStatic`, `t.CConst` …) are filtered out during type merging — only the underlying data type is kept.
- Declaration modifiers on functions, with `fn` / `fun` / `func` / `function` as aliases of `def`.
- Declaration and annotation modifiers: `const` / `volatile` type descriptors (`a: const int`, `p: const t.CPtr`), `static` (C internal linkage — a static symbol cannot be used from another module), `export` / `extern` variables (`extern` takes no initializer), `virtual` / `novirtual` classes and methods, and `__attribute__(...)` in both the decorator and the annotation-modifier spelling.
- `[SIZE]T` fixed-length array types (plus `[]T` and `typedef T1 = T2`), and C-style casts in every spelling TransPyC accepts: `(T)x`, `(T*)x`, `(T*)(x)` and `T*(x)`.
- A `virtual class` method slot can be filled with a plain function (`obj.method = func`), matching how the compiler writes the vtable slot: the assigned function's `self` is a generic pointer (`rawptr` / `t.CPtr`) or a pointer to that class / one of its base classes, and the rest of the signature must match (`*args` / `**kwargs` may differ).
- `struct` / `union` / `enum` / `rnum`, including nested `t.REnum` variants destructured by field order.
- Variadic `*args` bound as `va_list` in the function body (`va_arg`, and pointer passthrough such as `vsnprintf(buf, size, fmt, args)`).
- Implicit conversion rules: integer/float convert in all directions (safe narrowing, lossless widening); integer → float requires float width ≥ integer width; float → integer is rejected; pointers convert only when the level matches **and** the pointee is compatible — either side being `void*`, identical pointees, and basic (numeric) pointees which follow the pointee's own conversion rules — while struct pointers must be the same type or an **upcast** (subclass → base class); different levels and unrelated structs are rejected; explicit casts are always allowed.
- Global/local variable rules: reading a global never errors; assigning an undeclared global without `global` does; a local redeclaration shadows the global; and so on.
- Type representations: `bool` / `t.CBool` map to `i1`; `str` / `bytes` are `i8*`, while `str | t.CPtr` / `bytes | t.CPtr` are `i8**`.
- PEP 695 syntax is pre-processed for Viper: type parameter lists are stripped and unknown `T | t.CPtr` unions are folded to `i8*`.
- Fail-fast analysis: missing type information is reported as an error instead of silently degrading to `i8*` / `void` / `i32`.

### Editor features

- Diagnostics with human-readable messages, plus Viper-tuned semantic highlighting (keywords, storage/type modifiers, decorators, `t.CDefine` constants, `__attribute__(...)` attribute names, and undefined symbols rendered in white).
- Completion, hover, go-to-definition, find references, rename, document symbols, and Organize Imports. Inside `__attribute__(...)`, both completion and hover list the available attribute names (including ones the compiler supports but that the `attr` stub does not declare).
- Activity-bar UI (Project / Toolchain / Settings), `.vpj` project files with a dedicated custom editor, and a status-bar compiler indicator.
- Analysis progress in the status bar (the file being analyzed, `N / M`, percentage) while the workspace is being checked, and a **Count Project LOC** report (KPIs, per-language chart, detail table) for `.vpj` projects.
- Import resolution over `VIPER_HOME` (stdlib), `viperconfig.json` extra paths, the workspace root, and recursively discovered child project configurations.

## Packages

- **`packages/vipeye-internal`** — Core analysis engine: parser, binder, type evaluator, checker, and language service. All logic lives here.
- **`packages/vipeye`** — CLI wrapper. Bundles `vipeye-internal` into a distributable npm package with `vipeye` and `vipeye-langserver` entry points.
- **`packages/vipeye-typeserver`** — Type server process for long-running editor sessions.
- **`packages/vscode-vipeye`** — VS Code extension client (Vipeye LSP), with the Viper core source (`packages/viper`) bundled at build time.
- **`packages/viper`** — Viper core source library: project (`.vpj`) management, toolchain, and the activity bar UI (Project / Toolchain / Settings).

## Relationship to Pyright

- Viper dialect: `viperconfig.json` instead of `pyrightconfig.json`; configuration namespace `viper.*` instead of `python.analysis.*` / `pyright.*`.
- Viper stdlib stubs bundled in `packages/vipeye-internal/vipershed-fallback`.
- Type semantics follow Viper rules: implicit conversions, pointer types (`CPtr` / `CArray`), `t.CTypedef` / `t.CDefine` / `t.CEnum` / `t.REnum`, `T | t.CPtr` pointer folding, global-variable access rules, and more.
- Diagnostics and semantic highlighting are tailored to Viper syntax.

## Building and Testing

```bash
# Install all packages (from repo root)
npm install

# Build the core library
cd packages/vipeye-internal && npm run build

# Run all tests (rebuilds the test server first)
cd packages/vipeye-internal && npm test

# Run tests without rebuilding the test server (faster iteration)
cd packages/vipeye-internal && npm run test:norebuild

# Build the CLI / VS Code extension bundles (from repo root)
npm run build:cli:dev
npm run build:extension:dev
```

See [docs/build-debug.md](docs/build-debug.md) for details.

## Documentation

Refer to [the documentation](docs/README.md) for installation, configuration, and usage details.

## Environment variables

If Vipeye fails to create a temporary directory (for example in remote/server environments where the OS temp directory doesn't exist or isn't writable), you can override the temp directory root:

- `VIPEYE_TMPDIR`: Absolute path to a directory that Vipeye can use for temporary files/directories. Vipeye will create it if needed.

Vipeye otherwise relies on the platform temp directory (for example `TMPDIR`, `TMP`, `TEMP`, or the OS default).

## License

MIT
