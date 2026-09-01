param(
    [ValidateRange(1, 100)]
    [int]$Cycles = 3,

    [string]$OutputDirectory = '',

    [string]$Vst1 = 'C:\Program Files\Common Files\VST3\Dexed.vst3',

    [string]$Vst2 = 'C:\Program Files\Common Files\VST3\Vital.vst3'
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$executable = Join-Path $prototypeRoot 'build\minihub_tracktion_probe_artefacts\Release\minihub_tracktion_probe.exe'
if (-not (Test-Path -LiteralPath $executable)) {
    $fallback = Join-Path $prototypeRoot 'build-final\minihub_tracktion_probe_artefacts\Release\minihub_tracktion_probe.exe'
    if (Test-Path -LiteralPath $fallback) { $executable = $fallback }
}
if (-not (Test-Path -LiteralPath $executable)) {
    throw "Prototype executable not found. Run scripts/build.ps1 first."
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $prototypeRoot 'artifacts\validation-run'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$transcript = Join-Path $OutputDirectory 'probe-console.txt'
& $executable --cycles $Cycles --vst1 $Vst1 --vst2 $Vst2 --output $OutputDirectory 2>&1 |
    Tee-Object -FilePath $transcript
$nativeExitCode = $LASTEXITCODE

$metadata = [ordered]@{
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    executable = $executable
    cycles = $Cycles
    vst1 = [IO.Path]::GetFullPath($Vst1)
    vst2 = [IO.Path]::GetFullPath($Vst2)
    nativeExitCode = $nativeExitCode
    nativeExitHex = ('0x{0:X8}' -f ($nativeExitCode -band 0xFFFFFFFFL))
    cleanProcessExit = ($nativeExitCode -eq 0 -or $nativeExitCode -eq 2)
    resultsFile = Join-Path $OutputDirectory 'prototype-results.json'
    transcript = $transcript
}
$metadata | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $OutputDirectory 'process-exit.json') -Encoding utf8

if (-not $metadata.cleanProcessExit) { exit 1 }
exit $nativeExitCode
