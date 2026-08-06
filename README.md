![Vipeye](docs/img/PyrightLarge.png)

# Static Type Checker for Viper

Vipeye is a full-featured, standards-based static type checker for Viper, written in TypeScript. It is designed for high performance and can be used with large Viper source bases.

Vipeye includes both a [command-line tool](docs/command-line.md) and an [extension for Visual Studio Code](packages/vscode-vipeye). It is built on the Pyright codebase, adapted from the ground up to Viper semantics (AOT compilation, C-style types, pointer and memory semantics), and no longer type-checks Python.

## Packages

- **`packages/vipeye-internal`** — Core analysis engine: parser, binder, type evaluator, checker, and language service. All logic lives here.
- **`packages/vipeye`** — CLI wrapper. Bundles `vipeye-internal` into a distributable npm package with `vipeye` and `vipeye-langserver` entry points.
- **`packages/vipeye-typeserver`** — Type server process for long-running editor sessions.
- **`packages/vscode-vipeye`** — VS Code extension client (Vipeye LSP), with the Viper core source (`packages/viper`) bundled at build time.
- **`packages/viper`** — Viper core source library: project (`.vpj`) management, toolchain, and the activity bar UI (Project / Toolchain / Settings).

## Key Differences from Pyright

- Viper dialect: `viperconfig.json` instead of `pyrightconfig.json`; config namespace `viper.*`.
- Viper stdlib stubs bundled in `vipeye-internal/vipershed-fallback`.
- Type semantics follow Viper rules: implicit conversions, pointer (`CPtr`/`CArray`), `t.CTypedef`/`t.CDefine`/`t.CEnum`, `T | t.CPtr` pointer folding, global-variable access rules, and more.
- Semantic highlighting and diagnostics are tailored to Viper syntax.

## Building and Testing

See [docs/build-debug.md](docs/build-debug.md).

## Documentation

Refer to [the documentation](docs/README.md) for installation, configuration, and usage details.

## Environment variables

If Vipeye fails to create a temporary directory (for example in remote/server environments where the OS temp directory doesn't exist or isn't writable), you can override the temp directory root:

- `VIPEYE_TMPDIR`: Absolute path to a directory that Vipeye can use for temporary files/directories. Vipeye will create it if needed.

Vipeye otherwise relies on the platform temp directory (for example `TMPDIR`, `TMP`, `TEMP`, or the OS default).

## License

MIT
