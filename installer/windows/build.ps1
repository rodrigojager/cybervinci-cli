[CmdletBinding()]
param(
  [string] $Version,
  [string] $BinaryPath,
  [string] $BaselineBinaryPath,
  [string] $OutputDirectory,
  [string] $Repository,
  [string] $InnoCompiler,
  [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$definition = Join-Path $PSScriptRoot 'CYBERVINCI.iss'

if (-not $BinaryPath) {
  $BinaryPath = Join-Path $repoRoot 'packages\cybervinci\dist\cybervinci-windows-x64\bin\cybervinci.exe'
}
if (-not $BaselineBinaryPath) {
  $BaselineBinaryPath = Join-Path $repoRoot 'packages\cybervinci\dist\cybervinci-windows-x64-baseline\bin\cybervinci.exe'
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repoRoot 'dist\installers'
}

$BinaryPath = [System.IO.Path]::GetFullPath($BinaryPath)
$BaselineBinaryPath = [System.IO.Path]::GetFullPath($BaselineBinaryPath)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
  throw "Missing Windows x64 binary: $BinaryPath"
}
if (-not (Test-Path -LiteralPath $BaselineBinaryPath -PathType Leaf)) {
  throw "Missing Windows x64 baseline binary: $BaselineBinaryPath"
}
if ($OutputDirectory.TrimEnd('\') -eq $repoRoot.TrimEnd('\')) {
  throw 'The installer output directory cannot be the repository root.'
}

if (-not $Version) {
  $Version = (& $BinaryPath --version | Select-Object -First 1).Trim()
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
  throw "Invalid version: $Version"
}
if ($Repository -and $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "Repository must use OWNER/REPOSITORY syntax: $Repository"
}

$binaryVersion = (& $BinaryPath --version | Select-Object -First 1).Trim()
$baselineVersion = (& $BaselineBinaryPath --version | Select-Object -First 1).Trim()
if ($binaryVersion -ne $Version) {
  throw "Windows x64 binary version is '$binaryVersion', expected '$Version'."
}
if ($baselineVersion -ne $Version) {
  throw "Windows x64 baseline binary version is '$baselineVersion', expected '$Version'."
}

if (-not $InnoCompiler) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
  )
  $InnoCompiler = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $InnoCompiler -or -not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
  throw 'Inno Setup 6 compiler not found. Install JRSoftware.InnoSetup with winget or pass -InnoCompiler.'
}

if (Test-Path -LiteralPath $OutputDirectory) {
  if (-not $Force) {
    throw "Output directory already exists. Pass -Force to replace it: $OutputDirectory"
  }
  Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null

if ($env:GITHUB_ACTIONS -eq 'true') {
  & (Join-Path $repoRoot 'script\sign-windows.ps1') $BinaryPath $BaselineBinaryPath
}

function Escape-InnoValue([string] $Value) {
  return $Value.Replace('"', '""')
}

$generatedDefinition = Join-Path $OutputDirectory 'CYBERVINCI.generated.iss'
$definitionText = @"
#define MyAppVersion "$(Escape-InnoValue $Version)"
#define SourceRoot "$(Escape-InnoValue $repoRoot)"
#define SourceBinary "$(Escape-InnoValue $BinaryPath)"
#define BaselineBinary "$(Escape-InnoValue $BaselineBinaryPath)"
#define OutputDir "$(Escape-InnoValue $OutputDirectory)"
#include "$(Escape-InnoValue $definition)"
"@
[System.IO.File]::WriteAllText($generatedDefinition, $definitionText, [System.Text.UTF8Encoding]::new($false))

& $InnoCompiler $generatedDefinition
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE."
}

$versionedSetup = Join-Path $OutputDirectory "CYBERVINCI-Setup-$Version-windows-x64.exe"
if (-not (Test-Path -LiteralPath $versionedSetup -PathType Leaf)) {
  throw "Inno Setup did not produce the expected installer: $versionedSetup"
}

if ($env:GITHUB_ACTIONS -eq 'true') {
  & (Join-Path $repoRoot 'script\sign-windows.ps1') $versionedSetup
}

$stableSetup = Join-Path $OutputDirectory 'CYBERVINCI-Setup-windows-x64.exe'
Copy-Item -LiteralPath $versionedSetup -Destination $stableSetup

$archiveDefinitions = @(
  @{ Name = 'cybervinci-windows-x64.zip'; Binary = $BinaryPath },
  @{ Name = 'cybervinci-windows-x64-baseline.zip'; Binary = $BaselineBinaryPath }
)

foreach ($archiveDefinition in $archiveDefinitions) {
  $staging = Join-Path $OutputDirectory ('.stage-' + [System.IO.Path]::GetFileNameWithoutExtension($archiveDefinition.Name))
  New-Item -ItemType Directory -Path $staging | Out-Null
  Copy-Item -LiteralPath $archiveDefinition.Binary -Destination (Join-Path $staging 'cybervinci.exe')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'README.md') -Destination $staging
  Copy-Item -LiteralPath (Join-Path $repoRoot 'CYBERVINCI.md') -Destination $staging
  Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $staging
  Copy-Item -LiteralPath (Join-Path $repoRoot 'NOTICE') -Destination $staging
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath (Join-Path $OutputDirectory $archiveDefinition.Name) -CompressionLevel Optimal
  Remove-Item -LiteralPath $staging -Recurse -Force
}

$installerScript = Get-Content -LiteralPath (Join-Path $repoRoot 'install.ps1') -Raw
if ($Repository) {
  $installerScript = $installerScript.Replace('__CYBERVINCI_RELEASE_REPOSITORY__', $Repository)
}
[System.IO.File]::WriteAllText(
  (Join-Path $OutputDirectory 'install.ps1'),
  $installerScript,
  [System.Text.UTF8Encoding]::new($false)
)

$hashTargets = @(
  $versionedSetup,
  $stableSetup,
  (Join-Path $OutputDirectory 'cybervinci-windows-x64.zip'),
  (Join-Path $OutputDirectory 'cybervinci-windows-x64-baseline.zip'),
  (Join-Path $OutputDirectory 'install.ps1')
)

$checksumLines = foreach ($target in $hashTargets) {
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  $name = Split-Path -Leaf $target
  if ($name -ne 'install.ps1') {
    Set-Content -LiteralPath ($target + '.sha256') -Value "$hash  $name" -Encoding Ascii
  }
  "$hash  $name"
}
Set-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Value $checksumLines -Encoding Ascii

Remove-Item -LiteralPath $generatedDefinition -Force

$assets = Get-ChildItem -LiteralPath $OutputDirectory -File | Sort-Object Name
$assets | Select-Object Name, Length, @{ Name = 'SHA256'; Expression = { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } }
