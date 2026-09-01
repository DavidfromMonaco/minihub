# MiniHub Engine 2 prototype

Standalone Windows audio-engine proof. It is deliberately disconnected from
MiniHub/Electron and contains no JUCE or Tracktion code.

Architecture: `PortAudio/WASAPI -> AudioEngine -> AudioGraph -> two Tracks ->
PluginInstance -> linear Mixer/Master`. Offline rendering calls
`AudioGraph::processBlock` directly and never initializes PortAudio.

## Build

```powershell
.\scripts\fetch-dependencies.ps1
.\scripts\build.ps1
```

## Validation

```powershell
.\scripts\run-validation.ps1
```

The validation script runs the deterministic/core suite, 100 real VST3
load/process/unload cycles with Dexed and Vital, 100 transport cycles without
unloading, an offline real-plugin render, and an optional realtime WASAPI
capture/compare. Each command writes a machine-readable JSON result and returns
non-zero on failure. Set `-SkipDevice` only on headless machines.

