param(
    [string]$Dexed = 'C:\Program Files\Common Files\VST3\Dexed.vst3',
    [string]$Vital = 'C:\Program Files\Common Files\VST3\Vital.vst3',
    [switch]$SkipDevice,
    [switch]$SkipAsanBuild
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifacts = Join-Path $root 'artifacts\validation'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null

& (Join-Path $PSScriptRoot 'build.ps1') -Configuration Release
if (-not $SkipAsanBuild) {
    & (Join-Path $PSScriptRoot 'build.ps1') -Configuration Release -Asan
}

$release = Join-Path $root 'build\Release\minihub_engine2.exe'
$asan = Join-Path $root 'build-asan\Release\minihub_engine2.exe'
$runs = [Collections.Generic.List[object]]::new()

function Invoke-NativeValidation {
    param([string]$Name, [string]$Executable, [string[]]$Arguments)
    $stdout = Join-Path $artifacts "$Name-stdout.txt"
    $stderr = Join-Path $artifacts "$Name-stderr.txt"
    $started = Get-Date
    & $Executable @Arguments 1> $stdout 2> $stderr
    $code = $LASTEXITCODE
    $runs.Add([ordered]@{
        name = $Name
        exitCode = $code
        durationMs = [int]((Get-Date) - $started).TotalMilliseconds
        stdout = $stdout
        stderr = $stderr
        crashCode = if ($code -eq -1073740940) { '0xC0000374' } elseif ($code -eq -1073741819) { '0xC0000005' } else { $null }
    })
}

Invoke-NativeValidation 'core-release' $release @('self-test', '--artifacts', $artifacts)
Invoke-NativeValidation 'vst-load-unload-100' $release @('plugin-stress', '--dexed', $Dexed, '--vital', $Vital, '--cycles', '100', '--artifacts', $artifacts)
Invoke-NativeValidation 'vst-transport-100' $release @('plugin-transport-stress', '--dexed', $Dexed, '--vital', $Vital, '--cycles', '100', '--artifacts', $artifacts)
Invoke-NativeValidation 'vst-determinism' $release @('plugin-determinism', '--dexed', $Dexed, '--vital', $Vital, '--artifacts', $artifacts)
Invoke-NativeValidation 'vst-offline' $release @('plugin-offline', '--dexed', $Dexed, '--vital', $Vital, '--artifacts', $artifacts)

if (-not $SkipDevice) {
    Invoke-NativeValidation 'wasapi-deterministic-compare' $release @('device-compare', '--artifacts', $artifacts)
    Invoke-NativeValidation 'wasapi-vst-compare' $release @('plugin-device-compare', '--dexed', $Dexed, '--vital', $Vital, '--artifacts', $artifacts)
}

if (-not $SkipAsanBuild) {
    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    $vsRoot = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    $asanRuntime = Get-ChildItem -LiteralPath (Join-Path $vsRoot 'VC\Tools\MSVC') -Filter 'clang_rt.asan_dynamic-x86_64.dll' -Recurse | Select-Object -First 1
    if (-not $asanRuntime) { throw 'MSVC AddressSanitizer runtime not found.' }
    $env:Path = "$($asanRuntime.Directory.FullName);$env:Path"
    # LeakSanitizer is not implemented by MSVC on Windows; progressive leaks
    # are measured by private bytes/handles in the native stress commands.
    $env:ASAN_OPTIONS = 'halt_on_error=1:abort_on_error=1:windows_hook_rtl_allocators=true'
    Invoke-NativeValidation 'core-asan' $asan @('self-test', '--artifacts', (Join-Path $artifacts 'asan'))
    Invoke-NativeValidation 'vst-load-unload-100-asan' $asan @('plugin-stress', '--dexed', $Dexed, '--vital', $Vital, '--cycles', '100', '--artifacts', (Join-Path $artifacts 'asan'))
}

$failed = @($runs | Where-Object { $_.exitCode -ne 0 })
$summary = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    dexed = $Dexed
    vital = $Vital
    skipDevice = [bool]$SkipDevice
    runs = $runs
    pass = $failed.Count -eq 0
}
$summaryPath = Join-Path $artifacts 'validation-summary.json'
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8
Get-Content -LiteralPath $summaryPath
if ($failed.Count -ne 0) { exit 1 }
