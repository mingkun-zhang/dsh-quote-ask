<#
.SYNOPSIS
  Build a release ZIP that users can extract and install as a DSH plugin.

.DESCRIPTION
  Produces dist/dsh-quote-ask-<version>.zip with the plugin package plus the
  Windows install/uninstall scripts and docs (no tests, CI config, or .git).
  Upload the ZIP as a GitHub Release asset if you want a one-click download;
  the repository ZIP also works.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
#>
[CmdletBinding()]
param(
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $repo 'dist' }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-quote-ask-pack-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  $rootFiles = @(
    'package.json', 'cordis.patch.yml', 'icon.svg',
    'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md',
    'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'RELEASING.md'
  )
  foreach ($file in $rootFiles) {
    $source = Join-Path $repo $file
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $staging }
  }
  foreach ($dir in @('lib', 'locale', 'scripts', 'docs')) {
    $source = Join-Path $repo $dir
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $staging -Recurse }
  }
  # Do not ship the packaging script inside a release archive.
  $packScript = Join-Path $staging 'scripts\package-windows.ps1'
  if (Test-Path -LiteralPath $packScript) { Remove-Item -LiteralPath $packScript -Force }

  $zip = Join-Path $OutputDir ("dsh-quote-ask-$version.zip")
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
  Write-Host "Built: $zip"
  Write-Host ''
  Write-Host 'Users can extract it, open the extracted folder in PowerShell, and run:'
  Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1'
  Write-Host 'Then fully quit and relaunch DeepSeek Harness Desktop.'
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
