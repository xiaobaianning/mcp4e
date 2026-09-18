[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$EasyLangRoot = 'D:\software\eyy'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$sdk = Join-Path $EasyLangRoot 'sdk\cpp\elib'
$generated = Join-Path $repo 'fne\generated-sdk'

if (-not (Test-Path -LiteralPath $sdk)) {
    throw "未找到易语言 SDK 目录: $sdk（可用 -EasyLangRoot 指定安装目录）"
}

# --- 1. 把 GBK 的 SDK 头文件转成 UTF-8，并去掉 MSVC 不接受的内联默认参数 ---
New-Item -ItemType Directory -Force -Path $generated | Out-Null
$gbk = [Text.Encoding]::GetEncoding(936)
$utf8 = [Text.UTF8Encoding]::new($false)

foreach ($header in @('lib2.h', 'PublicIDEFunctions.h', 'lang.h')) {
    $source = Join-Path $sdk $header
    if (-not (Test-Path -LiteralPath $source)) { throw "缺少 SDK 头文件: $source" }
    $text = [IO.File]::ReadAllText($source, $gbk)
    if ($header -eq 'lib2.h') {
        $text = $text.Replace('DWORD dwParam1 = 0', 'DWORD dwParam1')
        $text = $text.Replace('DWORD dwParam2 = 0', 'DWORD dwParam2')
        $text = $text.Replace('HWND hDesignWnd = 0', 'HWND hDesignWnd')
        $text = $text.Replace('BOOL blInDesignMode = FALSE', 'BOOL blInDesignMode')
        $text = $text.Replace('BOOL* pblModified = NULL', 'BOOL* pblModified')
        $text = $text.Replace('LPVOID pResultExtraData = NULL', 'LPVOID pResultExtraData')
        $text = $text.Replace('LPTSTR* ppszTipText = NULL', 'LPTSTR* ppszTipText')
    }
    [IO.File]::WriteAllText((Join-Path $generated $header), $text, $utf8)
}
Write-Output "已生成 UTF-8 SDK 头文件: $generated"

# --- 2. 定位 MSBuild ---
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw '未找到 vswhere.exe，请安装 Visual Studio（含“使用 C++ 的桌面开发”）。'
}
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw '未安装 Visual C++ x86 生成工具（易语言是 32 位，必须装 x86 工具集）。' }
$msbuild = Join-Path $installation 'MSBuild\Current\Bin\amd64\MSBuild.exe'
if (-not (Test-Path -LiteralPath $msbuild)) { throw "未找到 MSBuild: $msbuild" }

# --- 3. 编译 FNE ---
& $msbuild (Join-Path $repo 'fne\elang_mcp.sln') /m /nologo /verbosity:minimal `
    /p:Configuration=$Configuration /p:Platform=Win32 /p:EasyLangRoot=$EasyLangRoot
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

Write-Output "编译完成: $repo\fne\dist\elang_mcp.fne"
Write-Output "编译完成: $repo\fne\dist\eui_runtime.dll"
Write-Output "下一步: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -EasyLangRoot `"$EasyLangRoot`""
