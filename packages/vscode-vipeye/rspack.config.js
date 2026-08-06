const path = require('path');
const { createRequire } = require('module');
const { monorepoResourceNameMapper, tsconfigResolveAliases } = require('../../build/lib/webpack');

const rspack = createRequire(__filename)('@rspack/core');
const outPath = path.resolve(__dirname, 'dist');
const typeshedFallback = path.resolve(__dirname, '..', 'vipeye-internal', 'typeshed-fallback');
const vipershedFallback = path.resolve(__dirname, '..', 'vipeye-internal', 'vipershed-fallback');
const viperCore = path.resolve(__dirname, '..', 'viper');

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
                ],
            }),
        ],
    };
};
