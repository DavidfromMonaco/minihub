param(
    [string]$Destination = (Join-Path $PSScriptRoot '..\third_party\tracktion_engine')
)

$ErrorActionPreference = 'Stop'
$destinationPath = [IO.Path]::GetFullPath($Destination)

if (-not (Test-Path (Join-Path $destinationPath '.git'))) {
    git clone --branch develop https://github.com/Tracktion/tracktion_engine.git $destinationPath
}

git -c submodule.modules/juce.url=https://github.com/juce-framework/JUCE.git `
    -C $destinationPath submodule update --init --recursive

Write-Host "Tracktion Engine: $(git -C $destinationPath rev-parse HEAD)"
Write-Host "JUCE: $(git -C (Join-Path $destinationPath 'modules\juce') rev-parse HEAD)"

