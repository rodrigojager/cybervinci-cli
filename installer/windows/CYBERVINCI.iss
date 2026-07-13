#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#ifndef SourceRoot
  #define SourceRoot "..\.."
#endif

#ifndef SourceBinary
  #define SourceBinary SourceRoot + "\packages\cybervinci\dist\cybervinci-windows-x64\bin\cybervinci.exe"
#endif

#ifndef BaselineBinary
  #define BaselineBinary SourceBinary
#endif

#ifndef OutputDir
  #define OutputDir SourceRoot + "\dist\installers"
#endif

[Setup]
AppId=CYBERVINCI.CLI
AppName=CYBERVINCI CLI
AppVersion={#MyAppVersion}
AppVerName=CYBERVINCI CLI {#MyAppVersion}
AppPublisher=CYBERVINCI
DefaultDirName={%USERPROFILE}\.cybervinci\cli
DefaultGroupName=CYBERVINCI
DisableProgramGroupPage=yes
DisableReadyMemo=no
DisableWelcomePage=no
LicenseFile={#SourceRoot}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename=CYBERVINCI-Setup-{#MyAppVersion}-windows-x64
SetupIconFile={#SourceRoot}\packages\desktop\resources\icons\icon.ico
UninstallDisplayIcon={%USERPROFILE}\.cybervinci\bin\cybervinci.exe
UninstallDisplayName=CYBERVINCI CLI {#MyAppVersion}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=yes
VersionInfoDescription=CYBERVINCI CLI installer
VersionInfoProductName=CYBERVINCI CLI
VersionInfoCompany=CYBERVINCI
VersionInfoCopyright=CYBERVINCI contributors and upstream OpenCode contributors

[Files]
Source: "{#SourceBinary}"; DestDir: "{%USERPROFILE}\.cybervinci\bin"; DestName: "cybervinci.exe"; Flags: ignoreversion; Check: HasAvx2
Source: "{#BaselineBinary}"; DestDir: "{%USERPROFILE}\.cybervinci\bin"; DestName: "cybervinci.exe"; Flags: ignoreversion; Check: not HasAvx2
Source: "{#SourceRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\CYBERVINCI.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\NOTICE"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\cybervinci.exe"; ValueType: string; ValueName: ""; ValueData: "{%USERPROFILE}\.cybervinci\bin\cybervinci.exe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\cybervinci.exe"; ValueType: string; ValueName: "Path"; ValueData: "{%USERPROFILE}\.cybervinci\bin"

[Code]
const
  ProcessorFeatureAvx2 = 40;
  UserEnvironmentKey = 'Environment';

function IsProcessorFeaturePresent(ProcessorFeature: Integer): Boolean;
  external 'IsProcessorFeaturePresent@kernel32.dll stdcall';

function HasAvx2: Boolean;
begin
  Result := IsProcessorFeaturePresent(ProcessorFeatureAvx2);
end;

function NormalizePathEntry(Value: String): String;
begin
  Result := Lowercase(Trim(Value));
  StringChangeEx(Result, '/', '\', True);
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    Delete(Result, Length(Result), 1);
end;

function UserPathContains(PathValue: String; Candidate: String): Boolean;
var
  Entry: String;
  Separator: Integer;
begin
  Result := False;
  PathValue := PathValue + ';';
  while PathValue <> '' do
  begin
    Separator := Pos(';', PathValue);
    Entry := Copy(PathValue, 1, Separator - 1);
    Delete(PathValue, 1, Separator);
    if NormalizePathEntry(Entry) = NormalizePathEntry(Candidate) then
    begin
      Result := True;
      exit;
    end;
  end;
end;

procedure AddToUserPath;
var
  CurrentPath: String;
  InstallBin: String;
begin
  InstallBin := ExpandConstant('{%USERPROFILE}\.cybervinci\bin');
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    CurrentPath := '';

  if UserPathContains(CurrentPath, InstallBin) then
    exit;

  if CurrentPath = '' then
    CurrentPath := InstallBin
  else if CurrentPath[Length(CurrentPath)] = ';' then
    CurrentPath := CurrentPath + InstallBin
  else
    CurrentPath := CurrentPath + ';' + InstallBin;

  if not RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    RaiseException('Unable to add CYBERVINCI to the user PATH.');
end;

procedure RemoveFromUserPath;
var
  CurrentPath: String;
  UpdatedPath: String;
  InstallBin: String;
  Entry: String;
  Separator: Integer;
begin
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    exit;

  InstallBin := ExpandConstant('{%USERPROFILE}\.cybervinci\bin');
  UpdatedPath := '';
  CurrentPath := CurrentPath + ';';

  while CurrentPath <> '' do
  begin
    Separator := Pos(';', CurrentPath);
    Entry := Copy(CurrentPath, 1, Separator - 1);
    Delete(CurrentPath, 1, Separator);
    if (Trim(Entry) <> '') and
       (NormalizePathEntry(Entry) <> NormalizePathEntry(InstallBin)) then
    begin
      if UpdatedPath <> '' then
        UpdatedPath := UpdatedPath + ';';
      UpdatedPath := UpdatedPath + Trim(Entry);
    end;
  end;

  if UpdatedPath = '' then
    RegDeleteValue(HKCU, UserEnvironmentKey, 'Path')
  else if not RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', UpdatedPath) then
    RaiseException('Unable to remove CYBERVINCI from the user PATH.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddToUserPath;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromUserPath;
end;
