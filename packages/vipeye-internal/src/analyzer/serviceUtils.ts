import { ReadOnlyFileSystem } from '../common/fileSystem';
import { configFileName, pyprojectTomlName, viperProjectFileExt, viperProjectFileName } from '../common/pathConsts';
import { Uri } from '../common/uri/uri';
import { forEachAncestorDirectory } from '../common/uri/uriUtils';

export function findPyprojectTomlFileHereOrUp(fs: ReadOnlyFileSystem, searchPath: Uri): Uri | undefined {
    return forEachAncestorDirectory(searchPath, (ancestor) => findPyprojectTomlFile(fs, ancestor));
}

export function findPyprojectTomlFile(fs: ReadOnlyFileSystem, searchPath: Uri) {
    const fileName = searchPath.resolvePaths(pyprojectTomlName);
    if (fs.existsSync(fileName)) {
        return fs.realCasePath(fileName);
    }
    return undefined;
}

export function findConfigFileHereOrUp(fs: ReadOnlyFileSystem, searchPath: Uri): Uri | undefined {
    return forEachAncestorDirectory(searchPath, (ancestor) => findConfigFile(fs, ancestor));
}

export function findConfigFile(fs: ReadOnlyFileSystem, searchPath: Uri): Uri | undefined {
    // 只查找 viperconfig.json（完全切换后不再回退 pyrightconfig.json）。
    // 调用方（service.ts）依据返回文件名决定是否将 dialect 设为 'viper'。
    const viperFileName = searchPath.resolvePaths(configFileName);
    if (fs.existsSync(viperFileName)) {
        return fs.realCasePath(viperFileName);
    }

    // .vpj 文件（Viper Project）：遍历目录查找任意 *.vpj 文件。
    // .vpj 是 Viper 特有扩展名，误判概率低，但仍用 isViperProjectConfig 校验 schema。
    // 优先于 project.json：当目录中同时存在 project.vpj 和 project.json 时，优先使用 .vpj。
    const vpjFile = findVpjFileInDir(fs, searchPath);
    if (vpjFile) {
        return fs.realCasePath(vpjFile);
    }

    // TransPyC project.json：仅当 schema 匹配（含 source_dir / compiler / linker 之一）时才返回，
    // 避免误判其他工具的 project.json。
    const projectFileName = searchPath.resolvePaths(viperProjectFileName);
    if (fs.existsSync(projectFileName) && isViperProjectConfig(fs, projectFileName)) {
        return fs.realCasePath(projectFileName);
    }

    return undefined;
}

// 在目录中查找任意 .vpj 文件（Viper Project 配置）。
// 遍历目录条目，返回第一个匹配 .vpj 扩展名且 schema 校验通过的文件。
// 失败时返回 undefined。
export function findVpjFileInDir(fs: ReadOnlyFileSystem, dirUri: Uri): Uri | undefined {
    try {
        if (!fs.existsSync(dirUri)) {
            return undefined;
        }
        const entries = fs.readdirEntriesSync(dirUri);
        for (const entry of entries) {
            const name = entry.name;
            if (name.endsWith(viperProjectFileExt) && entry.isFile()) {
                const fileUri = dirUri.resolvePaths(name);
                if (isViperProjectConfig(fs, fileUri)) {
                    return fileUri;
                }
            }
        }
    } catch {
        // 读取目录失败：跳过
    }
    return undefined;
}

// Viper 扩展：递归查找工作区下所有 Viper 项目配置文件（*.vpj / project.json）。
// 用于 LSP 模式下工作区根（如 TransPyC）未直接包含配置文件，
// 但子目录（如 TransPyV/、Test/G4/）包含 Viper 项目配置的场景。
// 每个子项目的 source_dir（如 ./App）都应作为全局导入根，
// includes 作为额外搜索路径 —— App 根级全局可导入。
// 递归深度限制 + 跳过常见非项目目录，避免深层遍历开销。
// 失败或未找到时返回空数组。
const _viperConfigScanMaxDepth = 6;
const _viperConfigSkipDirs = new Set(['.git', 'node_modules', '__pycache__', '.tpv_build', 'build', 'dist']);

export function findViperProjectConfigsInChildDirs(fs: ReadOnlyFileSystem, dirUri: Uri): Uri[] {
    return _findViperProjectConfigsRecursive(fs, dirUri, 1);
}

function _findViperProjectConfigsRecursive(fs: ReadOnlyFileSystem, dirUri: Uri, depth: number): Uri[] {
    const configs: Uri[] = [];
    try {
        if (!fs.existsSync(dirUri) || depth > _viperConfigScanMaxDepth) {
            return configs;
        }
        const entries = fs.readdirEntriesSync(dirUri);
        // 第一轮：只收集直接子目录中的项目配置（保持原有主配置优先级，
        // 即 configs[0] 仍是工作区根下第一个含配置的直接子目录）。
        const nonProjectDirs: Uri[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (_viperConfigSkipDirs.has(entry.name)) {
                continue;
            }
            const childDir = dirUri.resolvePaths(entry.name);
            // 优先 .vpj（Viper Project）：当目录同时存在 project.vpj 与 project.json 时，优先使用 .vpj。
            const vpjFile = findVpjFileInDir(fs, childDir);
            if (vpjFile) {
                configs.push(vpjFile);
                continue;
            }
            // TransPyC project.json：仅当 schema 匹配（含 source_dir / compiler / linker 之一）时收集。
            const projectFileName = childDir.resolvePaths(viperProjectFileName);
            if (fs.existsSync(projectFileName) && isViperProjectConfig(fs, projectFileName)) {
                configs.push(fs.realCasePath(projectFileName));
                continue;
            }
            nonProjectDirs.push(childDir);
        }
        // 第二轮：对非项目目录递归深入，查找嵌套项目（如 TransPyC/Test/G4）。
        for (const childDir of nonProjectDirs) {
            configs.push(..._findViperProjectConfigsRecursive(fs, childDir, depth + 1));
        }
    } catch {
        // 读取目录失败：跳过
    }
    return configs;
}

// 校验 project.json / project.vpj 是否为 Viper（TransPyC）项目配置。
// project.json 是常见文件名，仅当含 source_dir / compiler / linker 之一时才视为 Viper 配置。
// 读取或解析失败时按非 Viper 项目处理，返回 false。
export function isViperProjectConfig(fs: ReadOnlyFileSystem, uri: Uri): boolean {
    try {
        const content = fs.readFileSync(uri, 'utf8');
        const obj = JSON.parse(content);
        if (obj && typeof obj === 'object') {
            return 'source_dir' in obj || 'compiler' in obj || 'linker' in obj;
        }
    } catch (e) {
        // 解析失败或读取失败：按非 Viper 项目处理。
    }
    return false;
}
