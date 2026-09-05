# MiniHub

A desktop music workstation for Windows, built around the **Arturia MiniLab 3**
MIDI controller: a Patch Bay of typed cables, a native VST3 host, a
sample-accurate MIDI + audio sequencer, Mixer / Morpher / Arpeggiator nodes, and
learning that binds physical knobs to VST3 parameters.

**Your cables** — not the page you happen to be looking at — decide what you hear.

---

## Status

A personal project under active development. The first public build is
**[MiniHub 0.1.0](https://github.com/DavidfromMonaco/minihub/releases/tag/v0.1.0)**,
a pre-alpha, available two ways: an installer, or a portable folder you unzip
and replace. Both carry the same build, and both read the same settings,
projects and recordings — none of which live inside the application folder
(see [D-031](DECISIONS.md)). It also builds and runs from source, below.

The executable is not code-signed, so SmartScreen will warn; the SHA-256 sums are
published with the release.

## Requirements

| | |
|---|---|
| System | Windows 10/11 — **final**, no port planned |
| Node.js | 20 or newer |
| Compiler | Visual Studio 2022 or 2026, C++ desktop workload |
| CMake | 3.22 or newer |
| Audio | a WASAPI output |

## Native dependencies to fetch

Roughly **682 MB**, never committed. Drop them under `native/third_party/`:

| Expected folder | What |
|---|---|
| `native/third_party/JUCE` | JUCE 9 |
| `native/third_party/vst3sdk` | Steinberg's VST3 SDK |
| `native/third_party/portaudio` | PortAudio |
| `native/third_party/lame` | LAME, including `bin/lame.exe` |

CMake stops with an explicit message if one is missing — there is no silent
failure at this stage.

## Build and run

```bash
npm install
```

Configure the native tree **once** (the only unscripted step):

```bash
cmake -S native/audio-engine -B native/audio-engine/build -A x64
```

Then:

```bash
npm start              # native build + dist sync + launch
```

## Verify

```bash
npm test               # JS tests, node:test runner
npm run check          # invariant checker
npm run build:native   # must pass with 0 errors, 0 warnings
```

After `npm run build:native:tests`, the four native binaries:

```bash
native/audio-engine/build/Release/mlh_native_tests.exe --core
native/audio-engine/build/Release/mlh_native_tests.exe --vst3-e2e
native/audio-engine/build/Release/mlh_native_tests.exe --cross-track-isolation
native/audio-engine/build/Release/mlh_realtime_output_tests.exe
```

**A change is not finished until everything that touches it is green.**
See [AGENTS.md](AGENTS.md) §8.

## Diagnosis

Startup log: `%APPDATA%/minilab-hub/minilab-hub-startup.log`. It is the first
thing to read when the engine will not start.

## Documentation

The repository documents itself. Mandatory entry point for a contributor or an
agent: **[AGENTS.md](AGENTS.md)**.

| File | What it holds |
|---|---|
| [AGENTS.md](AGENTS.md) | the map — absolute rules, prohibitions, conventions, commands |
| [INTENT.md](INTENT.md) | what MiniHub must be, and must not become |
| [ARCHITECTURE.md](ARCHITECTURE.md) | the technical architecture, section by section |
| [DECISIONS.md](DECISIONS.md) | what has been settled, and why |
| [ROADMAP.md](ROADMAP.md) | what is left to do |
| [PLANS.md](PLANS.md) | long, multi-session workstreams |

## Name

**MiniHub** is the product name. `minilab-hub` (npm, `%APPDATA%`) and `mlh_`
(native targets) are historical and **must not be "corrected"**: they are paths
that already exist on users' disks. **MiniLab** alone always means the hardware
controller, never the application. See AGENTS.md §2.

## Licence

MIT — see [LICENSE](LICENSE).

MiniHub is an independent project, not affiliated with Arturia. MiniLab is a
trademark of Arturia.
