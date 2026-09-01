param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]] $MediaFiles
)

$player = New-Object -ComObject WMPlayer.OCX
$player.settings.mute = $true
$player.settings.autoStart = $true

try {
  $results = foreach ($mediaFile in $MediaFiles) {
    $resolvedMedia = (Resolve-Path -LiteralPath $mediaFile).Path
    $player.URL = $resolvedMedia
    $player.controls.play()
    $states = [System.Collections.Generic.List[int]]::new()
    for ($pollIndex = 0; $pollIndex -lt 40; $pollIndex += 1) {
      Start-Sleep -Milliseconds 250
      $states.Add([int] $player.playState)
      if (($player.playState -eq 3 -or $player.playState -eq 10) -and
          $player.currentMedia.duration -gt 0) {
        break
      }
    }
    [pscustomobject]@{
      file = $resolvedMedia
      openState = [int] $player.openState
      playState = [int] $player.playState
      duration = [double] $player.currentMedia.duration
      position = [double] $player.controls.currentPosition
      errorCount = [int] $player.error.errorCount
      observedStates = $states.ToArray()
      playable = ($player.currentMedia.duration -gt 0 -and
        ($states.Contains(3) -or $states.Contains(10)))
    }
    $player.controls.stop()
  }
  $results | ConvertTo-Json -Depth 4
} finally {
  $player.close()
  [void] [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($player)
}
