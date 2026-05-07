param(
    [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $root "extension"
if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $distDir = $OutputDir
} else {
    $distDir = Join-Path $root $OutputDir
}

$manifest = Get-Content (Join-Path $extDir "manifest.json") | ConvertFrom-Json
$version = $manifest.version
$name = $manifest.name -replace '[^\w\-]', '_'
$zipName = "${name}-v${version}.zip"

Write-Host "Packaging $name v$version ..." -ForegroundColor Cyan

if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

$files = @(
    "manifest.json",
    "background.js",
    "sidebar.html",
    "sidebar.js",
    "icon.png",
    "wasm\web_agent_ir.js",
    "wasm\web_agent_ir_bg.wasm"
)

foreach ($f in $files) {
    $src = Join-Path $extDir $f
    $dst = Join-Path $distDir $f
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    if (-not (Test-Path $src)) {
        Write-Host "  SKIP $f (not found)" -ForegroundColor Yellow
        continue
    }
    Copy-Item $src $dst -Force
    Write-Host "  + $f" -ForegroundColor Gray
}

$zipPath = Join-Path $root $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($distDir, $zipPath)

$size = [math]::Round((Get-Item $zipPath).Length / 1024, 1)
Write-Host "Created: $zipName ($size KB)" -ForegroundColor Green
Write-Host "Output:  $zipPath"
