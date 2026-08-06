<#
.SYNOPSIS
    一键打包 Vipeye VS Code 扩展（vscode-vipeye → 根目录 Vipeye.vsix）

.DESCRIPTION
    1. 检查 rspack --watch 进程（其占用 dist 目录会导致打包失败）
    2. 在 packages/vscode-vipeye 执行 npm run package
    3. 将最新生成的 vsix 复制到仓库根目录 Vipeye.vsix

.EXAMPLE
    .\pack.ps1          # 标准打包（含 watch 进程检查）
    .\pack.ps1 -Force   # 跳过 watch 进程检查直接打包
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

$Root = $PSScriptRoot
$VipeyePkg = Join-Path $Root 'packages\vscode-vipeye'
$PackageJson = Join-Path $VipeyePkg 'package.json'
$DestVsix = Join-Path $Root 'Vipeye.vsix'

# 1. 读取版本号
Write-Step '读取版本号'
if (-not (Test-Path $PackageJson)) {
    throw "未找到 $PackageJson"
}
$Pkg = Get-Content $PackageJson -Raw | ConvertFrom-Json
$Version = $Pkg.version
Write-Host "  vscode-vipeye v$Version"

# 2. 检查 rspack --watch 进程（dist 占用会导致打包失败）
if (-not $Force) {
    Write-Step '检查 rspack --watch 进程'
    $WatchProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -match 'rspack' -and $_.CommandLine -match 'watch'
    }
    if ($WatchProcs) {
        Write-Warning '检测到 rspack --watch 进程占用 dist 目录：'
        $WatchProcs | ForEach-Object {
            Write-Host "  PID $($_.ProcessId): $($_.CommandLine)" -ForegroundColor Yellow
        }
        Write-Warning '请先停止 watch 进程（Stop-Process -Id <PID>）再打包，或使用 -Force 强制继续（可能因 dist 占用失败）。'
        exit 1
    }
}

# 3. 打包
Write-Step "执行 npm run package（rspack production + vsce）"
Push-Location $VipeyePkg
try {
    npm run package
    if ($LASTEXITCODE -ne 0) {
        throw "npm run package 失败（exit code $LASTEXITCODE）"
    }
}
finally {
    Pop-Location
}

# 4. 定位最新生成的 vsix 并复制到根目录
Write-Step '复制产物到根目录'
$SourceVsix = Get-ChildItem -Path $VipeyePkg -Filter '*.vsix' |
    Sort-Object LastWriteTime |
    Select-Object -Last 1
if (-not $SourceVsix) {
    throw "未找到打包产物（$VipeyePkg\*.vsix）"
}

Copy-Item -Path $SourceVsix.FullName -Destination $DestVsix -Force

$Info = Get-Item $DestVsix
Write-Host ''
Write-Host "✔ 打包完成: $DestVsix" -ForegroundColor Green
Write-Host "  来源: $($SourceVsix.Name)" -ForegroundColor Green
Write-Host "  大小: $([math]::Round($Info.Length / 1MB, 2)) MB  时间: $($Info.LastWriteTime)" -ForegroundColor Green
