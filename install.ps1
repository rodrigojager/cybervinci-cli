[CmdletBinding()]
param(
  [string] $Repository,
  [string] $Version,
  [string] $InstallerUrl,
  [string] $ChecksumUrl,
  [string] $InstallerPath,
  [string] $ExpectedSha256,
  [switch] $RequireAuthenticode,
  [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$embeddedRepository = '__CYBERVINCI_RELEASE_REPOSITORY__'
if (-not $Repository -and $embeddedRepository -ne '__CYBERVINCI_RELEASE_REPOSITORY__') {
  $Repository = $embeddedRepository
}
if (-not $Repository -and $env:CYBERVINCI_RELEASE_REPOSITORY) {
  $Repository = $env:CYBERVINCI_RELEASE_REPOSITORY
}

if ($env:OS -ne 'Windows_NT') {
  throw 'This installer supports native Windows PowerShell only.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'CYBERVINCI requires a 64-bit Windows installation.'
}
if ($Repository -and $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "Repository must use OWNER/REPOSITORY syntax: $Repository"
}
if ($InstallerPath -and ($InstallerUrl -or $Repository)) {
  throw 'Use only one source: -InstallerPath, -InstallerUrl, or -Repository.'
}
if ($InstallerUrl -and $Repository) {
  throw 'Use only one remote source: -InstallerUrl or -Repository.'
}

$temporaryDirectory = $null
$downloadedInstaller = $false

try {
  if ($InstallerPath) {
    $resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
  }
  else {
    $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('cybervinci-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
    $resolvedInstaller = Join-Path $temporaryDirectory 'CYBERVINCI-Setup-windows-x64.exe'
    $downloadedInstaller = $true

    if ($Repository) {
      $tag = if ($Version) { '/tags/v' + $Version.TrimStart('v') } else { '/latest' }
      $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'CYBERVINCI-Installer' }
      $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases$tag"
      $setupAsset = $release.assets | Where-Object { $_.name -eq 'CYBERVINCI-Setup-windows-x64.exe' } | Select-Object -First 1
      if (-not $setupAsset) {
        throw "Release '$($release.tag_name)' does not contain CYBERVINCI-Setup-windows-x64.exe."
      }
      $hashAsset = $release.assets | Where-Object { $_.name -eq 'CYBERVINCI-Setup-windows-x64.exe.sha256' } | Select-Object -First 1
      if (-not $hashAsset) {
        throw "Release '$($release.tag_name)' does not contain the required installer checksum."
      }
      $InstallerUrl = $setupAsset.browser_download_url
      $ChecksumUrl = $hashAsset.browser_download_url
      if (-not $Version) {
        $Version = $release.tag_name.TrimStart('v')
      }
    }

    if (-not $InstallerUrl) {
      throw 'No release source is configured. Use -Repository OWNER/REPOSITORY, -InstallerUrl, or -InstallerPath.'
    }
    if (-not $ChecksumUrl -and -not $ExpectedSha256) {
      throw 'Remote installation requires -ChecksumUrl or -ExpectedSha256.'
    }

    Write-Host "Downloading CYBERVINCI from $InstallerUrl"
    Invoke-WebRequest -UseBasicParsing -Uri $InstallerUrl -OutFile $resolvedInstaller

    if ($ChecksumUrl) {
      $checksumFile = Join-Path $temporaryDirectory 'CYBERVINCI-Setup-windows-x64.exe.sha256'
      Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUrl -OutFile $checksumFile
      $checksumText = Get-Content -LiteralPath $checksumFile -Raw
      if ($checksumText -notmatch '(?i)([a-f0-9]{64})') {
        throw 'The downloaded checksum file does not contain a SHA-256 value.'
      }
      $ExpectedSha256 = $Matches[1]
    }
  }

  if (-not (Test-Path -LiteralPath $resolvedInstaller -PathType Leaf)) {
    throw "Installer not found: $resolvedInstaller"
  }

  $actualSha256 = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ExpectedSha256 -and $actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "CYBERVINCI installer checksum mismatch. Expected $ExpectedSha256, got $actualSha256."
  }
  if (-not $ExpectedSha256 -and $downloadedInstaller) {
    throw 'Downloaded installers must have a verified SHA-256 checksum.'
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
  if ($signature.Status -ne 'Valid' -and $signature.Status -ne 'NotSigned') {
    throw "CYBERVINCI installer has an invalid Authenticode status: $($signature.Status)."
  }
  if ($RequireAuthenticode -and $signature.Status -ne 'Valid') {
    throw 'CYBERVINCI installer is not signed by a trusted Authenticode certificate.'
  }
  if ($signature.Status -eq 'NotSigned') {
    Write-Warning 'This local CYBERVINCI build is not Authenticode-signed. SHA-256 verification still passed.'
  }

  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-')
  if ($Force) {
    $arguments += '/FORCECLOSEAPPLICATIONS'
  }
  $process = Start-Process -FilePath $resolvedInstaller -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "CYBERVINCI Setup failed with exit code $($process.ExitCode)."
  }

  $installBin = Join-Path $HOME '.cybervinci\bin'
  $installedBinary = Join-Path $installBin 'cybervinci.exe'
  if (-not (Test-Path -LiteralPath $installedBinary -PathType Leaf)) {
    throw "CYBERVINCI Setup completed but the global binary is missing: $installedBinary"
  }

  $pathEntries = @($env:PATH -split ';' | Where-Object { $_ })
  if (-not ($pathEntries | Where-Object { $_.TrimEnd('\') -ieq $installBin.TrimEnd('\') })) {
    $env:PATH = $installBin + ';' + $env:PATH
  }

  $installedVersion = (& $installedBinary --version | Select-Object -First 1).Trim()
  if ($Version -and $installedVersion -ne $Version.TrimStart('v')) {
    throw "Installed CYBERVINCI version is '$installedVersion', expected '$Version'."
  }

  Write-Host "CYBERVINCI $installedVersion installed successfully."
  Write-Host "Global command: cybervinci"
  Write-Host "Installed binary: $installedBinary"
}
finally {
  if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
