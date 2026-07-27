import { ReadOnlyFileSystem } from '../common/fileSystem';
import { configFileName, pyprojectTomlName, viperConfigFileName, viperProjectFileExt, viperProjectFileName } from '../common/pathConsts';
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
    // Viper 模式优先：先查找 viperconfig.json，未找到时回退到 pyrightconfig.json。
    // 调用方（service.ts）依据返回文件名决定是否将 dialect 设为 'viper'。
    const viperFileName = searchPath.resolvePaths(viperConfigFileName);
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
    // 否则跳过到 pyrightconfig.json，避免误判其他工具的 project.json。
    const projectFileName = searchPath.resolvePaths(viperProjectFileName);
    if (fs.existsSync(projectFileName) && isViperProjectConfig(fs, projectFileName)) {
        return fs.realCasePath(projectFileName);
    }

    const pyrightFileName = searchPath.resolvePaths(configFileName);
    if (fs.existsSync(pyrightFileName)) {
        return fs.realCasePath(pyrightFileName);
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
