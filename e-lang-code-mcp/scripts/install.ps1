[CmdletBinding()]
param(
    [string]$EasyLangRoot = 'D:\software\eyy',
    [switch]$Force,
    [switch]$SkipMcp
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$source = Join-Path $repo 'fne\dist\elang_mcp.fne'
$libDirectory = Join-Path $EasyLangRoot 'lib'
$target = Join-Path $libDirectory 'elang_mcp.fne'
$legacyTarget = Join-Path $libDirectory 'codex_bridge.fne'

# 安装前必须关闭易语言，否则 .fne 被占用、无法覆盖或删除。
$running = Get-Process -Name 'e', 'e5', 'e8' -ErrorAction SilentlyContinue
if ($running) {
    throw "检测到易语言正在运行。请先保存并关闭易语言，再运行安装脚本。"
}

if (-not (Test-Path -LiteralPath $source)) {
    throw "未找到 $source，请先运行 scripts\build-native.ps1"
}
if (-not (Test-Path -LiteralPath $libDirectory)) {
    throw "易语言 lib 目录不存在: $libDirectory"
}
if ((Test-Path -LiteralPath $target) -and -not $Force) {
    throw "目标已存在，如需覆盖请加 -Force: $target"
}

# 安装支持库前建议关闭易语言，否则文件可能被占用。
Copy-Item -LiteralPath $source -Destination $target -Force

# 清理旧的 Codex 命名版本，避免两个桥接同时加载、抢占同一个管道。
if (Test-Path -LiteralPath $legacyTarget) {
    try {
        Remove-Item -LiteralPath $legacyTarget -Force -ErrorAction Stop
        Write-Output "已移除旧版支持库: $legacyTarget"
    } catch {
        Write-Warning "无法删除旧版支持库（文件被占用或需要管理员权限）: $legacyTarget"
        Write-Warning "请关闭易语言后重跑，或以管理员身份运行，或手动删除该文件。否则两个桥接会抢同一个管道。"
    }
}

Write-Output "已安装支持库: $target"

# 同步安装界面运行时 DLL（生成的程序会在运行时加载它）。
$runtimeSource = Join-Path $repo 'fne\dist\eui_runtime.dll'
$runtimeTarget = Join-Path $libDirectory 'eui_runtime.dll'
if (Test-Path -LiteralPath $runtimeSource) {
    Copy-Item -LiteralPath $runtimeSource -Destination $runtimeTarget -Force
    Write-Output "已安装界面运行时: $runtimeTarget"
} else {
    Write-Warning "未找到 $runtimeSource（阶段 2 的运行时 DLL 尚未构建）"
}

# 工程模板（project_new 用；模板就在仓库里，不需要复制）
$template = Join-Path $repo 'templates\windows-ui.e'
if (Test-Path -LiteralPath $template) {
    Write-Output "已就绪工程模板: $template"
} else {
    Write-Warning "缺少工程模板 $template —— project_new 将无法新建工程。制作方法见 templates\README.md"
}

# .ec 易模块搜索是“按需解析”，无需额外安装，直接可用。

Write-Output "请打开易语言 -> 工具 -> 支持库配置 -> 勾选「易语言 MCP 桥接支持库」-> 重启易语言。"

if ($SkipMcp) { return }

# 打包并注册 MCP 服务（可选）
$server = Join-Path $repo 'server'
$bundle = Join-Path $server 'dist\server.mjs'
if (-not (Test-Path -LiteralPath $bundle)) {
    Write-Output ""
    Write-Output "尚未打包 MCP 服务。请先执行："
    Write-Output "  cd `"$server`""
    Write-Output "  npm install"
    Write-Output "  npm run bundle"
    return
}

$codex = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codex) { $codex = Get-Command codex -ErrorAction SilentlyContinue }

if ($codex) {
    & $codex.Source mcp remove e-lang 2>$null | Out-Null
    & $codex.Source mcp add e-lang -- node $bundle
    if ($LASTEXITCODE -eq 0) {
        Write-Output "已注册 Codex MCP 服务: e-lang -> node $bundle"
    } else {
        Write-Output "自动注册失败，请手动注册: codex mcp add e-lang -- node $bundle"
    }
} else {
    Write-Output "未找到 codex.cmd，请手动把以下命令登记到你的 MCP 客户端："
    Write-Output "  node `"$bundle`""
}
