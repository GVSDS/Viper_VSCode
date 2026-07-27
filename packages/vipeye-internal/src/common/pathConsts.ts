/*
 * pathConsts.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Path-related constants.
 */

export const typeshedFallback = 'typeshed-fallback';

// Viper 自有标准库 stub 目录（vipershed），结构与 typeshed-fallback 对齐。
// 在 Viper 模式下优先使用 vipershed-fallback，缺失时回退到 typeshed-fallback。
export const vipershedFallback = 'vipershed-fallback';

export const lib = 'lib';
export const libAlternate = 'Lib';
export const lib64 = 'lib64';
export const sitePackages = 'site-packages';
export const distPackages = 'dist-packages';
export const src = 'src';
export const stubsSuffix = '-stubs';
export const defaultStubsDirectory = 'typings';
export const requirementsFileName = 'requirements.txt';
export const pyprojectTomlName = 'pyproject.toml';
export const dotPythonVersionName = '.python-version';
export const configFileName = 'pyrightconfig.json';

// Viper 模式下的配置文件名（替代 pyrightconfig.json）。
export const viperConfigFileName = 'viperconfig.json';

// Viper 项目配置文件名（TransPyC 编译器使用）。
// schema 与 viperconfig.json 不同：含 source_dir / includes / compiler / linker 等字段。
export const viperProjectFileName = 'project.json';

// Viper 项目配置文件扩展名（.vpj，Viper Project）。
// 优先于 project.json：当目录中同时存在 project.vpj 和 project.json 时，优先使用 .vpj。
export const viperProjectFileExt = '.vpj';
