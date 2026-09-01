# MiniHub Tracktion Engine feasibility prototype

This is an isolated native probe. It does not link to, launch, or modify the
current MiniHub runtime.

The probe creates one `tracktion::engine::Engine`, one JUCE/Tracktion Windows
audio device manager in WASAPI shared mode, one Edit, two audio tracks, two MIDI
clips, and two different hosted VST3 instruments. It exercises real-time
transport and captures the master without modifying it, then renders the master
and both stems offline.

## Dependencies

The dependency script checks out the official Tracktion Engine `develop`
branch and its JUCE submodule under `third_party/`. The exact Git revisions are
compiled into the result JSON.

```powershell
.\scripts\fetch-dependencies.ps1
.\scripts\build.ps1
```

## Run

The default test instruments are the locally installed Dexed and Vital VST3s.
Paths can be overridden explicitly.

```powershell
.\build\minihub_tracktion_probe_artefacts\Release\minihub_tracktion_probe.exe `
  --vst1 'C:\Program Files\Common Files\VST3\Dexed.vst3' `
  --vst2 'C:\Program Files\Common Files\VST3\Vital.vst3' `
  --output .\artifacts `
  --cycles 3 `
  --session-audit-hold-ms 10000
```

For the complete three-cycle run plus a machine-readable native exit code:

```powershell
.\scripts\run-validation.ps1 -Cycles 3
```

The process writes `prototype-results.json`, `master.wav`, `track-1.wav`,
`track-2.wav`, and a repeated `master-repeat.wav`. It exits non-zero when a
mandatory technical assertion fails. The hold option keeps real-time playback
active before the tests so `scripts/audit-audio-session.ps1` can inspect the
Windows Core Audio session from another PowerShell process.

The probe deliberately constructs `Renderer::Parameters::tracksToDo` itself.
The tested Tracktion `develop` revision has an upstream `toBitSet` helper defect
that selects every Edit track when asked for one stem. This is recorded in the
prototype report. The current verdict is `FAIL`; this project is evidence for
an engineering decision, not migration code.

This evaluation build uses Tracktion Engine under GPLv3-or-later and the pinned
JUCE modules under AGPLv3. Closed-source MiniHub distribution requires suitable
commercial licences from both vendors; see the feasibility report.
