<#
  Build the full package: app + Node runtime + llama.cpp + models.

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\build-full.ps1 `
      -LlamaDir D:\llama-translate\llama.cpp -ModelsDir D:\llama-translate\models
#>
param(
  [string]$LlamaDir = '',
  [string]$ModelsDir = '',
  [string]$NodeExe = '',
  [string]$OutDir = '',
  [switch]$Store
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not $LlamaDir) { $LlamaDir = Join-Path $root 'llama.cpp' }
if (-not $ModelsDir) { $ModelsDir = Join-Path $root 'models' }
if (-not (Test-Path -LiteralPath (Join-Path $LlamaDir 'llama-server.exe'))) {
  throw "llama-server.exe not found under $LlamaDir"
}
if (-not (Test-Path -LiteralPath $ModelsDir)) { throw "models dir not found: $ModelsDir" }

if (-not $NodeExe) {
  $candidates = @(
    (Join-Path $root 'runtime\node.exe'),
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  )
  $NodeExe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}
if (-not $NodeExe) { throw 'node.exe not found; pass -NodeExe <path>' }

$stage = Join-Path ([IO.Path]::GetTempPath()) ('llama-translate-full-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$exclude = @('models', 'llama.cpp', 'runtime', 'logs', 'dist', '.git', 'tools', 'node_modules')
Get-ChildItem -LiteralPath $root -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime') | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $stage 'runtime\node.exe') -Force
Copy-Item -LiteralPath $LlamaDir -Destination (Join-Path $stage 'llama.cpp') -Recurse -Force
Copy-Item -LiteralPath $ModelsDir -Destination (Join-Path $stage 'models') -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'logs') | Out-Null

$sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
$zip = Join-Path $OutDir 'llama-translate-full-win64.zip'
$seven = Join-Path $OutDir 'llama-translate-full-win64.7z'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
if (Test-Path -LiteralPath $seven) { Remove-Item -LiteralPath $seven -Force }

if ($sevenZip) {
  $mode = if ($Store) { '-mx=0' } else { '-mx=1' }
  & $sevenZip a $mode $seven (Join-Path $stage '*') | Out-Null
  Write-Output ('ok: ' + $seven + ' (' + [math]::Round((Get-Item -LiteralPath $seven).Length / 1MB, 1) + ' MB)')
} else {
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Fastest
  Write-Output ('ok: ' + $zip + ' (' + [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1) + ' MB)')
}
Remove-Item -LiteralPath $stage -Recurse -Force
