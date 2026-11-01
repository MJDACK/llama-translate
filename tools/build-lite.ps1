<#
  Build the lite package: app + Node runtime + launcher, without llama.cpp and models.

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\build-lite.ps1
    powershell -ExecutionPolicy Bypass -File tools\build-lite.ps1 -NodeExe D:\node\node.exe
#>
param(
  [string]$NodeExe = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not $NodeExe) {
  $candidates = @(
    (Join-Path $root 'runtime\node.exe'),
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  )
  $NodeExe = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}
if (-not $NodeExe) { throw 'node.exe not found; pass -NodeExe <path>' }

$stage = Join-Path ([IO.Path]::GetTempPath()) ('llama-translate-lite-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$exclude = @('models', 'llama.cpp', 'runtime', 'logs', 'dist', '.git', 'tools', 'node_modules')
Get-ChildItem -LiteralPath $root -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime') | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $stage 'runtime\node.exe') -Force

$zip = Join-Path $OutDir 'llama-translate-lite-win64.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Output ('ok: ' + $zip + ' (' + [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1) + ' MB)')
