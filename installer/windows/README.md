# CYBERVINCI Windows installer

This directory builds the per-user CYBERVINCI CLI Setup. It installs the executable into `%USERPROFILE%\.cybervinci\bin`, adds that directory to the user `PATH` exactly once, and registers an uninstaller in Windows Installed Apps.

The Setup contains both the normal Windows x64 binary and the non-AVX2 baseline binary. It selects the correct executable during installation.

## Build locally

Install Bun `1.3.14` and Inno Setup 6, then run from the repository root:

```powershell
$version = "1.17.18-cybervinci.1"
$env:CYBERVINCI_VERSION = $version

bun run packages/cybervinci/script/build.ts --single --baseline --skip-install
./installer/windows/build.ps1 `
  -Version $version `
  -Repository "OWNER/REPOSITORY" `
  -OutputDirectory "./dist/windows-installer"
```

`-Repository` embeds the owned GitHub repository in the release copy of `install.ps1`. It does not change the source template.

## Release assets

The build produces:

- `CYBERVINCI-Setup-windows-x64.exe` for the stable latest-release URL.
- A versioned copy of the Setup.
- `cybervinci-windows-x64.zip` and `cybervinci-windows-x64-baseline.zip`.
- Per-asset `.sha256` files and `SHA256SUMS.txt`.
- A repository-configured `install.ps1` release asset.

Create a draft release first, upload every file from the output directory, validate it on a clean Windows machine, and only then publish it. The dedicated `Windows installer` GitHub workflow performs the build, installation smoke test, and draft upload without invoking the fork's broader npm/container/Desktop release pipeline.

After the release is public, the native Windows installation command is:

```powershell
irm https://github.com/OWNER/REPOSITORY/releases/latest/download/install.ps1 | iex
```

The bootstrap requires a matching external SHA-256 asset. It rejects invalid Authenticode signatures and can enforce a trusted signature with `-RequireAuthenticode`. Local unsigned builds emit a warning; production release assets should be signed before publication.
