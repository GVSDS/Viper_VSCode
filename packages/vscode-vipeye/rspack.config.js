const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const { monorepoResourceNameMapper, tsconfigResolveAliases } = require('../../build/lib/webpack');

const rspack = createRequire(__filename)('@rspack/core');
const outPath = path.resolve(__dirname, 'dist');
const typeshedFallback = path.resolve(__dirname, '..', 'vipeye-internal', 'typeshed-fallback');
const vipershedFallback = path.resolve(__dirname, '..', 'vipeye-internal', 'vipershed-fallback');
const viperCore = path.resolve(__dirname, '..', 'viper');

/**
 * 找 mermaid 的预构建 UMD 产物（暴露全局 mermaid），供「函数流程图」Webview 用 <script src> 加载。
 * 刻意用 node_modules 里的成品而不是自己打包：mermaid 内部有动态 import 的 diagram chunk，
 * 自行打包会引入额外 chunk 与资源路径问题。
 *
 * 不用 require.resolve('mermaid/dist/...')：包的 package.json 若声明了 exports，该子路径可能未被
 * 导出，会误报 MODULE_NOT_FOUND。这里只按目录找文件，覆盖「本包内安装」与「仓库根提升安装」两种情况。
 */
function findMermaidBundle() {
    const packageRoots = [
        path.join(__dirname, 'node_modules', 'mermaid'),
        path.join(__dirname, '..', '..', 'node_modules', 'mermaid'),
    ];
    const bundleNames = ['mermaid.min.js', 'mermaid.js'];
    const tried = [];

    for (const root of packageRoots) {
        if (!fs.existsSync(root)) {
            continue;
        }
        for (const name of bundleNames) {
            const candidate = path.join(root, 'dist', name);
            tried.push(candidate);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    throw new Error(
        '找不到 mermaid 的预构建产物（函数跳转图的 Webview 需要它）。\n' +
            '请先安装依赖：在 packages/vscode-vipeye（或仓库根）执行 npm install。\n' +
            `已尝试以下路径：\n  ${tried.join('\n  ')}`
    );
}

/** @type {(env: any, argv: { mode: 'production' | 'development' | 'none' }) => any} */
module.exports = (_, { mode }) => {
    return {
        context: __dirname,
        entry: {
            extension: './src/extension.ts',
            server: './src/server.ts',
        },
        target: 'node',
        output: {
            filename: '[name].js',
            path: outPath,
            library: {
                type: 'commonjs2',
            },
            devtoolModuleFilenameTemplate:
                mode === 'development' ? '../[resource-path]' : monorepoResourceNameMapper('vscode-vipeye'),
            clean: true,
        },
        devtool: mode === 'development' ? 'source-map' : 'nosources-source-map',
        cache: mode === 'development',
        stats: {
            all: false,
            errors: true,
            warnings: true,
            publicPath: true,
            timings: true,
        },
        resolve: {
            extensions: ['.ts', '.js'],
            alias: tsconfigResolveAliases('tsconfig.json'),
        },
        externals: {
            vscode: 'commonjs vscode',
            fsevents: 'commonjs2 fsevents',
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    loader: 'ts-loader',
                    options: {
                        configFile: path.resolve(__dirname, 'tsconfig.json'),
                    },
                },
            ],
        },
        plugins: [
            new rspack.CopyRspackPlugin({
                patterns: [
                    { from: typeshedFallback, to: 'typeshed-fallback' },
                    { from: vipershedFallback, to: 'vipershed-fallback' },
                    // Viper 核心（packages/viper）的静态资源：
                    // .vpj 图标与语法文件（活动栏图标复用本包 images/viper-icon.svg）。
                    // 源码不复制，仅构建产物引用。
                    { from: path.join(viperCore, 'images', 'vpj-icon.svg'), to: 'images/vpj-icon.svg' },
                    { from: path.join(viperCore, 'syntaxes', 'vpj.tmLanguage.json'), to: 'syntaxes/vpj.tmLanguage.json' },
                    // mermaid 的预构建产物，见 findMermaidBundle。
                    { from: findMermaidBundle(), to: 'media/mermaid.min.js' },
                    // 「函数流程图」Webview 的渲染脚本（外部脚本，避免内联脚本受 CSP nonce 限制）。
                    { from: path.join(__dirname, 'media', 'flowChartWebview.js'), to: 'media/flowChartWebview.js' },
                ],
            }),
        ],
    };
};
