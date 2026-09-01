param([switch]$Refresh)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$thirdParty = Join-Path $root 'third_party'
$vst = Join-Path $thirdParty 'vst3sdk'
$pa = Join-Path $thirdParty 'portaudio'
$vstRevision = '3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96'
$paRevision = '147dd722548358763a8b649b3e4b41dfffbcfbb6'

New-Item -ItemType Directory -Force -Path $thirdParty | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $vst '.git'))) {
    git clone --recursive https://github.com/steinbergmedia/vst3sdk.git $vst
}
if ($Refresh) { git -C $vst fetch --tags --recurse-submodules }
git -C $vst checkout --detach $vstRevision
git -C $vst submodule update --init --recursive

if (-not (Test-Path -LiteralPath (Join-Path $pa '.git'))) {
    git clone https://github.com/PortAudio/portaudio.git $pa
}
if ($Refresh) { git -C $pa fetch --tags }
git -C $pa checkout --detach $paRevision

$actualVst = (git -C $vst rev-parse HEAD).Trim()
$actualPa = (git -C $pa rev-parse HEAD).Trim()
if ($actualVst -ne $vstRevision -or $actualPa -ne $paRevision) {
    throw 'Dependency revision verification failed.'
}

Write-Host "VST3 SDK: $actualVst"
Write-Host "PortAudio: $actualPa"

