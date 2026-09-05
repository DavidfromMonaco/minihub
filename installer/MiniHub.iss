; MiniHub -- Windows installer (Inno Setup 6.3+)
;
; This script PACKAGES an existing build; it never produces one. The
; authoritative build tree is `dist/MiniHub`, written by `scripts/sync-dist.mjs`
; -- which stamps the icon, copies the Release native engine and records a
; provenance manifest. A second packager that rebuilt the payload its own way
; (electron-builder and friends) would put two producers on one directory and
; make invariant 11, "dist/ must match src/", unverifiable.
;
; Two distribution routes, not one. The portable folder stays a supported way to
; run MiniHub: the installed copy and a copied-in folder read the SAME user
; data, because none of it lives beside the executable. Consequently the
; uninstaller removes the application and nothing else -- settings in
; %APPDATA%/minilab-hub, projects in Documents/MiniHub/Projects and recordings
; in Music/MiniHub Recordings survive it, by design.
;
; Invoked by `npm run build:installer`, which passes the version and the paths.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\MiniHub"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist\release"
#endif

[Setup]
; Never change this GUID: it is the identity Windows uses to recognise an
; earlier MiniHub and upgrade it in place instead of installing a second copy.
AppId={{080F8984-17D9-4D32-8526-ED812F1FF0E5}
AppName=MiniHub
AppVersion={#AppVersion}
AppVerName=MiniHub {#AppVersion}
AppPublisher=MiniHub
AppPublisherURL=https://minihub.site
AppSupportURL=https://minihub.site
AppUpdatesURL=https://minihub.site
VersionInfoVersion={#AppVersion}
VersionInfoProductName=MiniHub

; Per-user install under %LOCALAPPDATA%\Programs\MiniHub: no UAC prompt, and the
; application never needs to write inside its own directory anyway.
PrivilegesRequired=lowest
DefaultDirName={autopf}\MiniHub
DefaultGroupName=MiniHub
DisableProgramGroupPage=yes
UninstallDisplayName=MiniHub
UninstallDisplayIcon={app}\MiniHub.exe
LicenseFile=..\LICENSE

; MiniHub is an x64 Electron runtime hosting an x64 audio engine.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

OutputDir={#OutputDir}
OutputBaseFilename=MiniHub-{#AppVersion}-Setup
SetupIconFile=..\build\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\MiniHub"; Filename: "{app}\MiniHub.exe"
Name: "{autodesktop}\MiniHub"; Filename: "{app}\MiniHub.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\MiniHub.exe"; Description: "{cm:LaunchProgram,MiniHub}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Files a later version may add under resources/ that this one did not install.
; Bounded to directories the installer itself creates -- never {app} wholesale.
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

[Messages]
; The stock wording promises to remove "all of its components", which would be a
; lie here: the uninstaller deliberately keeps everything the user made.
ConfirmUninstall=Remove MiniHub from this computer?%n%nYour projects, recordings and settings are stored outside the application folder and will be kept.
