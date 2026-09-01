param(
    [ValidateSet('Release', 'RelWithDebInfo', 'Debug')][string]$Configuration = 'Release',
    [switch]$Asan,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildName = if ($Asan) { 'build-asan' } else { 'build' }
$build = Join-Path $root $buildName
$temp = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $temp | Out-Null

if ($Clean -and (Test-Path -LiteralPath $build)) {
    $resolvedBuild = [IO.Path]::GetFullPath($build)
    if (-not $resolvedBuild.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe build path: $resolvedBuild"
    }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
}

$asanValue = if ($Asan) { 'ON' } else { 'OFF' }
$cmake = (Get-Command cmake -ErrorAction Stop).Source
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$cleanPath = @($machinePath, $userPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

function Invoke-CleanCMake {
    param([string[]]$Arguments)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $cmake
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    $start.Environment.Clear()
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        if ($entry.Key -inotmatch '^(Path|TEMP|TMP)$') { $start.Environment[$entry.Key] = $entry.Value }
    }
    $start.Environment['Path'] = ($cleanPath -join ';')
    $start.Environment['TEMP'] = $temp
    $start.Environment['TMP'] = $temp
    $process = [Diagnostics.Process]::Start($start)
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "CMake failed: $($process.ExitCode)" }
}

Invoke-CleanCMake @('-S', $root, '-B', $build, '-G', 'Visual Studio 18 2026', '-A', 'x64', "-DENGINE2_ENABLE_ASAN=$asanValue")
Invoke-CleanCMake @('--build', $build, '--config', $Configuration, '--target', 'minihub_engine2', '--parallel', '4')

Write-Host (Join-Path $build "$Configuration\minihub_engine2.exe")
