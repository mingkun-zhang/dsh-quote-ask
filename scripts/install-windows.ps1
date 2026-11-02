<#
.SYNOPSIS
  Install this working copy into the DeepSeek Harness Desktop "desktop" profile.

.DESCRIPTION
  The repository root is the plugin package. This script locates the DSH Desktop
  installation, calls its bundled CLI (`dsh plugin --profile desktop add <path>`),
  and prints the restart reminder. It does not modify your conversations.

.PARAMETER DshRoot
  Optional DSH Desktop installation directory (the folder containing
  "DeepSeek Harness.exe"). Defaults to the standard per-user install location.

.PARAMETER DryRun
  Print the command without running it. Useful for checking path detection.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -DshRoot "D:\Apps\DeepSeek Harness"
#>
[CmdletBinding()]
param(
  [string]$DshRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repo 'package.json'

if (-not (Test-Path -LiteralPath $manifest)) {
  throw "Cannot find package.json at '$repo'. Run this script from the repository's scripts folder."
}

function Resolve-DshRoot([string]$explicit) {
  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($explicit)) { $candidates += $explicit }
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_DESKTOP_ROOT)) { $candidates += $env:DSH_DESKTOP_ROOT }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness') }
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) { $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness') }
  if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness') }

  foreach ($candidate in $candidates) {
    $cli = Join-Path $candidate 'resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path -LiteralPath $cli) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

$root = Resolve-DshRoot $DshRoot
if ($null -eq $root) {
  throw @"
Could not find the DSH Desktop installation.

Install locations checked:
  %LOCALAPPDATA%\Programs\DeepSeek Harness
  %ProgramFiles%\DeepSeek Harness
  %ProgramFiles(x86)%\DeepSeek Harness

Pass the folder that contains "DeepSeek Harness.exe" explicitly:
  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -DshRoot "D:\path\to\DeepSeek Harness"
"@
}

$cli = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
Write-Host "DSH Desktop: $root"
Write-Host "Plugin path: $repo"

$cliArgs = @('plugin', '--profile', 'desktop', 'add', $repo)
if ($DryRun) {
  Write-Host "Dry run. Command:"
  $pretty = ($cliArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  Write-Host ("  `"{0}`" {1}" -f $cli, $pretty)
  exit 0
}

Write-Host "Installing into the desktop profile..."
& $cli @cliArgs
if ($LASTEXITCODE -ne 0) {
  throw "DSH CLI failed with exit code $LASTEXITCODE. Make sure DSH Desktop is installed and the path is correct."
}

Write-Host ''
Write-Host 'Installed. Now FULLY quit and relaunch DeepSeek Harness Desktop.'
Write-Host 'A browser refresh (Ctrl+R) is not enough because the Host half must reload.'
Write-Host 'Then select text in a conversation, right-click, and choose the quote-ask action.'
