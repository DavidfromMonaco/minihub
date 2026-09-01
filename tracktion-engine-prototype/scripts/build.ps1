param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [string]$BuildDirectory = 'build'
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildPath = Join-Path $prototypeRoot $BuildDirectory
$artifactPath = Join-Path $prototypeRoot 'artifacts'
$tempPath = Join-Path $prototypeRoot '.tmp'
$cmakePath = (Get-Command cmake -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $artifactPath, $tempPath | Out-Null

# Some Codex/desktop Windows environments contain both `Path` and `PATH`.
# MSBuild treats those names case-insensitively and aborts on the duplicate key,
# so child processes get a canonical, deterministic environment block.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$cleanPath = @($machinePath, $userPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
function Invoke-CMake {
    param(
        [Parameter(Mandatory)] [string[]] $Arguments,
        [Parameter(Mandatory)] [string] $LogStem
    )

    $stdout = Join-Path $artifactPath "$LogStem-stdout.txt"
    $stderr = Join-Path $artifactPath "$LogStem-stderr.txt"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $cmakePath
    $startInfo.WorkingDirectory = $prototypeRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    foreach ($argument in $Arguments) {
        [void] $startInfo.ArgumentList.Add($argument)
    }

    # Rebuild the inherited environment without case-insensitive duplicates.
    $startInfo.Environment.Clear()
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        if ($entry.Key -inotmatch '^(Path|TEMP|TMP)$') {
            $startInfo.Environment[$entry.Key] = $entry.Value
        }
    }
    $startInfo.Environment['Path'] = ($cleanPath -join ';')
    $startInfo.Environment['TEMP'] = $tempPath
    $startInfo.Environment['TMP'] = $tempPath

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void] $process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $standardOutput = $stdoutTask.GetAwaiter().GetResult()
    $standardError = $stderrTask.GetAwaiter().GetResult()

    Set-Content -LiteralPath $stdout -Value $standardOutput -NoNewline
    Set-Content -LiteralPath $stderr -Value $standardError -NoNewline
    Write-Host $standardOutput
    if (-not [string]::IsNullOrWhiteSpace($standardError)) {
        Write-Host $standardError
    }

    if ($process.ExitCode -ne 0) {
        throw "CMake failed with exit code $($process.ExitCode). See $stdout and $stderr."
    }
}

Invoke-CMake -LogStem 'configure' -Arguments @(
    '-S', $prototypeRoot,
    '-B', $buildPath,
    '-G', 'Visual Studio 18 2026',
    '-A', 'x64'
)

Invoke-CMake -LogStem 'build' -Arguments @(
    '--build', $buildPath,
    '--config', $Configuration,
    '--target', 'minihub_tracktion_probe',
    '--', '/m:1'
)
