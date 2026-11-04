# Deploy this working copy into the DSH Desktop profile.
#
# The profile installs plugins through pnpm, which hard-links files from its
# content-addressed store. Overwriting a file in place would modify that shared
# store, so every target is removed first and then copied (breaking the link).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\deploy-local.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\deploy-local.ps1 -ProfileDir "C:\Users\you\.dsh\profiles\desktop"
param(
  [string]$ProfileDir = $env:DSH_PROFILE_DIR
)

$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
  $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
}
$targetRoot = Join-Path $ProfileDir 'node_modules\dsh-quote-ask'

if (-not (Test-Path -LiteralPath $targetRoot)) {
  throw "dsh-quote-ask is not installed in $ProfileDir. Install it once through DSH's plugin manager, then re-run this script."
}

$files = @(
  'lib\index.js',
  'lib\client\index.js',
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'README.en.md',
  'locale\zh.json',
  'locale\en.json'
)

$resolvedRoot = (Resolve-Path -LiteralPath $targetRoot).Path
foreach ($relative in $files) {
  $from = Join-Path $source $relative
  $to = Join-Path $targetRoot $relative
  if (-not (Test-Path -LiteralPath $from)) { throw "missing source file: $from" }
  if (-not (Test-Path -LiteralPath $to)) { throw "missing installed file: $to" }
  $resolvedTarget = (Resolve-Path -LiteralPath $to).Path
  if (-not $resolvedTarget.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to write outside the plugin directory: $resolvedTarget"
  }
  Remove-Item -LiteralPath $to -Force
  Copy-Item -LiteralPath $from -Destination $to -Force
  Write-Host "updated $relative"
}

Write-Host ''
Write-Host 'Deployed to:' $targetRoot
Write-Host 'Fully quit DSH Desktop (including the tray process), then relaunch it.'
