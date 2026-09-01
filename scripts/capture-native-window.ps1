param(
  [Parameter(Mandatory = $true)]
  [string]$ProcessName,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MiniHubWindowCapture
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("shcore.dll")]
    public static extern int GetProcessDpiAwareness(IntPtr processHandle, out int awareness);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
'@

$processes = @(Get-Process -Name $ProcessName -ErrorAction Stop)
$processIds = @{}
foreach ($process in $processes) {
  $processIds[[uint32]$process.Id] = $true
}

$windows = New-Object System.Collections.Generic.List[object]
$callback = [MiniHubWindowCapture+EnumWindowsProc] {
  param([IntPtr]$handle, [IntPtr]$unused)

  [uint32]$processId = 0
  [void][MiniHubWindowCapture]::GetWindowThreadProcessId($handle, [ref]$processId)
  if (-not $processIds.ContainsKey($processId) -or -not [MiniHubWindowCapture]::IsWindowVisible($handle)) {
    return $true
  }

  $rect = New-Object MiniHubWindowCapture+Rect
  if (-not [MiniHubWindowCapture]::GetWindowRect($handle, [ref]$rect)) {
    return $true
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 100 -or $height -lt 100) {
    return $true
  }

  $titleLength = [MiniHubWindowCapture]::GetWindowTextLengthW($handle)
  $title = New-Object System.Text.StringBuilder ($titleLength + 1)
  [void][MiniHubWindowCapture]::GetWindowTextW($handle, $title, $title.Capacity)
  $windows.Add([pscustomobject]@{
    Handle = $handle
    ProcessId = $processId
    Title = $title.ToString()
    Left = $rect.Left
    Top = $rect.Top
    Width = $width
    Height = $height
    Area = $width * $height
  })
  return $true
}

[void][MiniHubWindowCapture]::EnumWindows($callback, [IntPtr]::Zero)
$window = $windows | Sort-Object Area -Descending | Select-Object -First 1
if (-not $window) {
  throw "No visible window found for process '$ProcessName'."
}

$absoluteOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($absoluteOutput)
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$bitmap = New-Object System.Drawing.Bitmap $window.Width, $window.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
  $captured = [MiniHubWindowCapture]::PrintWindow($window.Handle, $hdc, 2)
}
finally {
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
}

if (-not $captured) {
  $bitmap.Dispose()
  throw "PrintWindow failed for '$($window.Title)'."
}

$bitmap.Save($absoluteOutput, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

$capturedProcess = Get-Process -Id $window.ProcessId
[int]$dpiAwareness = -1
[void][MiniHubWindowCapture]::GetProcessDpiAwareness($capturedProcess.Handle, [ref]$dpiAwareness)

[pscustomobject]@{
  output = $absoluteOutput
  processId = $window.ProcessId
  title = $window.Title
  width = $window.Width
  height = $window.Height
  dpi = [MiniHubWindowCapture]::GetDpiForWindow($window.Handle)
  dpiAwareness = $dpiAwareness
} | ConvertTo-Json -Compress
