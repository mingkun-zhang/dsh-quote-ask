<#
.SYNOPSIS
  Remove the dsh-quote-ask package from the DSH Desktop "desktop" profile.

.PARAMETER DshRoot
  Optional DSH Desktop installation directory.

.PARAMETER DryRun
  Print the command without running it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1
#>
[CmdletBinding()]
param(
  [string]$DshRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

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
  throw "Could not find the DSH Desktop installation. Pass -DshRoot to its folder."
}

$cli = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
$cliArgs = @('plugin', '--profile', 'desktop', 'remove', 'dsh-quote-ask')

if ($DryRun) {
  Write-Host "Dry run. Command:"
  $pretty = ($cliArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  Write-Host ("  `"{0}`" {1}" -f $cli, $pretty)
  exit 0
}

Write-Host "Removing dsh-quote-ask from the desktop profile..."
& $cli @cliArgs
if ($LASTEXITCODE -ne 0) {
  throw "DSH CLI failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'Removed. Fully quit and relaunch DeepSeek Harness Desktop.'
Write-Host 'Your main conversations and workspace files were not touched.'
