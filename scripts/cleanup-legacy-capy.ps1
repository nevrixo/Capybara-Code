[CmdletBinding()]
param(
  [switch]$Apply
)

# Removes only the verified legacy Capybara Code install. It deliberately leaves Bun,
# WSL's Windows-PATH interoperability, and /usr/bin/cbc (the Coin-OR solver) alone.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Normalize-PathSegment([string]$Value) {
  return $Value.Trim().Trim('"').TrimEnd([char[]]@('\', '/'))
}

function Write-Plan([string]$Message) {
  if ($Apply) {
    Write-Host "APPLY  $Message"
  } else {
    Write-Host "DRY RUN  $Message"
  }
}

$bunBin = Join-Path $env:USERPROFILE '.bun\bin'
$shimPaths = @(
  (Join-Path $bunBin 'capy'),
  (Join-Path $bunBin 'capy.cmd')
)
$legacyRoot = Join-Path $env:LOCALAPPDATA 'Programs\capybara-code'
$legacyBin = Join-Path $legacyRoot 'bin'
$sourceMarker = 'Capybara-Code[\\/]+apps[\\/]+cbc[\\/]+src[\\/]+main\.ts'

$verifiedShims = @()
foreach ($shim in $shimPaths) {
  if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) {
    continue
  }
  $contents = Get-Content -Raw -LiteralPath $shim
  if ($contents -notmatch $sourceMarker) {
    throw "Refusing to remove '$shim': it is not the verified checkout-source capy shim."
  }
  $verifiedShims += $shim
}

$removeLegacyRoot = $false
if (Test-Path -LiteralPath $legacyRoot -PathType Container) {
  $manifestPath = Join-Path $legacyRoot 'manifest.json'
  $legacyExecutable = Join-Path $legacyBin 'capy.exe'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Refusing to remove '$legacyRoot': manifest.json is missing."
  }
  if (-not (Test-Path -LiteralPath $legacyExecutable -PathType Leaf)) {
    throw "Refusing to remove '$legacyRoot': bin\\capy.exe is missing."
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $hasExpectedName = $manifest.name -is [string] -and $manifest.name -like 'capybara-code-*'
  $hasExpectedExecutable = @($manifest.files | Where-Object {
    $_.path -eq 'bin/capy.exe' -or $_.path -eq 'bin\\capy.exe'
  }).Count -gt 0
  if (-not $hasExpectedName -or -not $hasExpectedExecutable) {
    throw "Refusing to remove '$legacyRoot': manifest does not identify the legacy Capybara Code package."
  }
  $removeLegacyRoot = $true
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$legacyBinNormalized = Normalize-PathSegment $legacyBin
$pathSegments = [string[]]($userPath -split ';')
$removedPathSegments = @($pathSegments | Where-Object {
  [String]::Equals((Normalize-PathSegment $_), $legacyBinNormalized, [StringComparison]::OrdinalIgnoreCase)
})
$keptPathSegments = [string[]]@($pathSegments | Where-Object {
  -not [String]::Equals((Normalize-PathSegment $_), $legacyBinNormalized, [StringComparison]::OrdinalIgnoreCase)
})
$newUserPath = [string]::Join(';', $keptPathSegments)

foreach ($shim in $verifiedShims) {
  Write-Plan "remove verified legacy shim $shim"
}
if ($removeLegacyRoot) {
  Write-Plan "remove verified manual install $legacyRoot"
}
foreach ($segment in $removedPathSegments) {
  Write-Plan "remove User PATH segment $segment"
}
if ($verifiedShims.Count -eq 0 -and -not $removeLegacyRoot -and $removedPathSegments.Count -eq 0) {
  Write-Host 'Nothing to clean: the verified legacy Capybara Code artifacts are absent.'
}

if ($Apply) {
  foreach ($shim in $verifiedShims) {
    Remove-Item -LiteralPath $shim -Force
  }
  if ($removeLegacyRoot) {
    Remove-Item -LiteralPath $legacyRoot -Recurse -Force
  }
  if ($removedPathSegments.Count -gt 0) {
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
  }
  Write-Host 'Cleanup complete. Open a new Windows terminal before checking command resolution.'
} else {
  Write-Host 'No files or PATH entries were changed. Re-run with -Apply after package-install verification.'
}

Write-Host 'WSL note: this script does not modify WSL. Its old capy came from Windows PATH; install native Linux Node/Bun after cleanup.'
Write-Host 'Safety note: /usr/bin/cbc is the Coin-OR solver and is intentionally untouched.'
