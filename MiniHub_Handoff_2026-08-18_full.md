# MiniHub — Handoff / Project Context

_Last updated: 2026-08-19 — Recorder rework specified; VST scan/Home regression repaired; DeepSeek excluded from MiniHub coding_

## 1. Project goal

**MiniHub** is a modular desktop application centered around the **Arturia MiniLab 3**.

The long-term goal is to let the graph determine what MiniHub is at any moment:

- lightweight live VST host / bridge
- MIDI + VST performance environment
- modular audio routing environment
- recording / sequencing environment
- CONTROL / modulation environment
- generative music system
- audiovisual environment later

Core principle:

> **The graph decides what MiniHub is.**

The internal universal MiniHub module/container concept is called:

# **OmniBox**

An OmniBox is MiniHub's native module contract. It can represent VST hosts, Mixer, Morpher, Sequencer, Musi2Image, analyzers, generators, etc.

---

## 2. Current technical base

Application:

- Electron
- Vanilla JavaScript
- Web MIDI API
- renderer uses ESM
- Electron main remains CommonJS
- native engine: C++ / JUCE 9.0.1 / CMake
- Windows x64
- VST3 only
- WASAPI Shared
- no ASIO yet
- no VST2 / AU / CLAP

Repository:

```text
C:\Users\666di\Desktop\LM Studio\Minilab Hub
```

Portable executable:

```text
C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe
```

Native engine:

```text
native\audio-engine\build\Release\mlh-audio-engine.exe
```

---

## 3. Core architecture

`hub.graph` remains the single source of truth for external topology.

Signal types remain distinct:

```text
MIDI
AUDIO
CONTROL
VIDEO   (future)
```

Electron owns:

- UI
- Patch Bay
- project persistence
- application settings
- orchestration

Native engine owns:

- physical audio device
- VST3 discovery/loading
- runtime plugin instances
- serial VST chains
- audio callback
- native plugin editors
- shared transport / AudioPlayHead
- native AUDIO DAG
- Mixer DSP
- Morpher DSP

Important:

> **Audio buffers never cross Electron IPC.**

IPC is semantic/state-based only.

---

## 4. Patch Bay

Implemented and working:

- draggable nodes
- SVG Bezier cables
- zoom under cursor
- right-drag pan
- Reset/Fit View
- persistent viewport
- infinite grid
- Ctrl + drag snap
- compatible-port connections
- Ctrl + click cable disconnect
- unplug from destination endpoint
- node selection
- custom context menu
- copy/paste
- dynamic node creation
- dynamic sidebar
- persistent node positions
- persistent graph connections

Stable internal node IDs and visible numbering are deliberately separate.

### Universal node direct access

Every node displayed in the Patch Bay must provide a dedicated direct-access button to its primary interface.

Behavior depends on node type:

- **MiniHub internal node / OmniBox:** opens that node's Settings / Editor page directly.
- **VST node / VST OmniBox:** opens the native VST editor directly.

Rules:

- this direct-access control is mandatory for **every node type**
- it must be accessible directly from the node card in the Patch Bay
- it must work without requiring the node to be selected first
- it must not introduce an unnecessary intermediate page or extra confirmation step
- internal modules should expose a consistent Settings / Editor action
- VST nodes should expose a consistent Open VST action
- the control must not interfere with node selection, dragging, routing ports, cable creation or cable interaction
- the visual treatment should remain consistent across node types and with the current MiniHub / Omni visual language
- all future node types must implement this direct-access behavior by default

This is a global Patch Bay UX rule, not a module-specific exception.

---

## 5. VST OmniBox

A VST Patch Bay node contains an ordered serial plugin chain.

Example:

```text
Instrument
→ EQ
→ Reverb
→ Compressor
```

Internal plugins are **not** Patch Bay nodes.

Current chain operations:

- add
- insert
- remove
- reorder
- bypass
- complete state restoration

A VST OmniBox can participate as one AUDIO node in the native DAG.

---

## 6. VST parameter exposure / Learn

Parameter identity uses real VST3 ParamID through JUCE.

Rules:

- display name is not identity
- array index is not identity
- UI order is not identity
- unstable fallbacks must be marked unstable

MiniHub has a native VST host container around the original editor.

Learn / Last Touched exists so the user can:

```text
Arm Learn
→ move a parameter in the real VST GUI
→ MiniHub captures the parameter
→ stable ParamID is available for future CONTROL mapping
```

The large 2000–3000 parameter lists remain a fallback, not the main workflow.

---

## 7. Native transport — implemented

MiniHub now has a native shared transport.

Implemented:

- default 120 BPM
- valid range 20–300 BPM
- Play / Stop
- sample position
- PPQ
- 4/4 time signature
- stop freezes transport position
- play resumes
- BPM persists
- transport advances only in native audio callback

Hosted VSTs receive MiniHub's real JUCE `AudioPlayHead`.

Manual validation:

> A real tempo-aware/arpeggiator VST follows MiniHub BPM correctly.

Timing fields supplied include:

- BPM
- playback state
- PPQ
- sample/time position
- bar start
- time signature

---

## 8. Native MIDI graph + Arpeggiator OmniBox — implemented and physically validated

MiniHub now has a native MIDI execution layer separate from the AUDIO DAG.

Architecture:

```text
hub.graph
→ semantic MIDI topology sync
→ immutable native MIDI execution plan
→ MIDI processors / downstream VST OmniBoxes
```

Rules:

- `hub.graph` remains authoritative
- MIDI and AUDIO topology remain distinct
- MIDI feedback cycles are rejected
- generated MIDI is processed in the native realtime path
- generated MIDI does not round-trip through Electron IPC
- existing AUDIO DAG architecture remains separate

### Arpeggiator OmniBox

Patch Bay node:

```text
MIDI IN
→ Arpeggiator
→ MIDI OUT
```

Implemented features:

- native transport synchronization
- 1/4, 1/8, 1/16, 1/32 rates
- 4 / 8 / 16 / 32-step pattern lengths
- Root selection
- data-driven scale library
- Up
- Down
- Up / Down
- As Played
- deterministic Random
- Custom
- scale-degree-based custom patterns
- per-step octave
- per-step velocity
- per-step gate
- Rest
- Tie
- project persistence
- note cleanup on Stop / disconnect / teardown

Custom patterns store **musical degrees**, not absolute MIDI notes, so the same pattern can be reinterpreted when Root/Scale changes.

Example:

```text
1 → 3 → 5 → 8 → 5 → 3 → 2 → 5
```

### Important operating behavior

The Arpeggiator follows MiniHub's native transport.

Therefore:

```text
MiniLab → Arpeggiator → VST
```

does not generate an arp while transport is stopped.

The user must press:

```text
Play
```

for normal Arpeggiator operation.

This caused a false-negative during manual testing: the Arpeggiator was initially thought broken because Play had not been pressed.

It has since been manually confirmed working.

---

## 8A. OmniBox context menu — implemented and validated

Patch Bay right-click creation is now hierarchical:

```text
OmniBox
├─ MIDI
│  └─ Arpeggiator
├─ Audio
│  ├─ Mixer
│  └─ Morpher
└─ Plugin
   └─ VST
```

Behavior:

- root menu does not expose all children at once
- submenus open only for the currently hovered path
- one active submenu path per level
- submenus open to the **right by default**
- they flip left only when there is genuinely insufficient room on the right
- normal parent → child pointer movement must remain usable
- selection closes the menu normally
- node creation still uses the normal graph/node creation path

This menu behavior has been manually validated after earlier broken iterations.

---

## 8. Native AUDIO DAG — implemented

The old callback rendered isolated VST chains and used boolean output gates.

It has been replaced by:

```text
hub.graph
→ semantic syncAudioGraph IPC
→ validated / topologically sorted native execution plan
→ VST / Mixer / Morpher
→ Audio Output
```

`hub.graph` remains authoritative.

The native DAG is only a derived runtime execution snapshot.

Implemented:

- deterministic topological order
- graph-faithful VST → VST effect routing
- distinct upstream audio buffers
- cycle rejection
- invalid topology keeps last valid snapshot
- buffer allocation outside audio callback
- immutable execution plans
- atomic publication
- hazard-pointer reclamation
- no topology rebuild / IPC / file I/O / blocking synchronization in callback

Current limits:

- stereo
- max 64 graph nodes
- max 64 inputs per node
- cycles / feedback rejected

---

## 9. Mixer OmniBox — implemented

Native stereo Mixer.

Supports:

```text
VST A ─┐
VST B ─┼→ Mixer → Audio Output
VST C ─┘
```

Features:

- arbitrary practical number of AUDIO inputs, native limit 64
- stable monotonic input IDs such as `audio-in-1`
- inputs are never renumbered after disconnect
- per-input level
- per-input mute
- master level
- persistent state
- can feed Mixer, Morpher, VST or Audio Output

No DAW-style buses/sends/EQ/meters yet.

---

## 10. Morpher OmniBox — implemented

Native AUDIO morphing between ordered incoming VST/audio sources.

Features:

- 0 inputs → silence
- 1 input → transparent pass-through
- N inputs → continuous adjacent-source traversal
- equal-power cosine/sine crossfade
- source order preserved
- 4 / 8 / 16 / 32-step patterns
- one pattern per bar
- step values are normalized morph positions
- smooth interpolation between step targets
- final step wraps smoothly to first
- native transport PPQ/BPM synchronization
- Stop freezes / Play resumes
- persistent state

It does **not** morph VST parameter snapshots.

---

## 11. VST state persistence — implemented

A previous bug caused VST internal settings/presets to be lost.

Fixed behavior:

- captures complete native VST3 state chunks
- parameter changes are debounced off the audio thread
- chunks persist during use and shutdown
- restoration happens only after the exact plugin instance reaches READY
- stable instance generations prevent stale state application
- multiple plugins in one chain keep independent state

Real validation:

- two Analog Lab instances
- separate ~137k-character state chunks
- both restored and reported `stateApplied` after relaunch

---

## 12. VST loading / startup work

A startup regression previously caused:

```text
PENDING
Engine unavailable
No VST3 plugins discovered yet
```

Fixes already implemented:

- successful scanner catalog persisted as application setting
- cold startup reuses cached catalog
- project restoration can resolve directly from stable VST3 path
- renderer-side restoration bound to current engine generation
- stale responses cannot restore wrong runtime
- real native creation errors are surfaced
- mid-session engine restart re-arms restoration

A later DeepSeek session introduced a new destructive regression affecting both the **VST scan** and **Home**. That regression was subsequently repaired with Claude Code.

Current rule:

> **Treat the repaired VST scan, cached catalog/startup behavior and Home as protected regression surfaces. Do not rewrite or "simplify" them as collateral work for unrelated features.**

Any future change touching VST discovery/loading or Home must be narrowly scoped and physically validated in `dist\MiniHub\MiniHub.exe` before being considered complete.

---

## 13. Native VST editor foreground

Desired behavior:

```text
Open Plugin
→ existing OmniBox/VST editor comes to foreground
```

No global Always-On-Top.

A previous implementation now uses Windows-specific activation:

- reuse existing editor HWND
- `AttachThreadInput`
- `BringWindowToTop`
- `SetWindowPos(HWND_TOP)`
- `SetActiveWindow`
- `SetFocus`
- `SetForegroundWindow`
- detach afterward

Learn remains an exception.

Manual visible validation is still important because previous attempts looked correct technically but still opened behind MiniHub.

---

## 14. Project system — implemented

MiniHub now has a real project model separated from application settings.

Default project folder:

```text
%USERPROFILE%\Documents\MiniHub\Projects
```

Project extension:

```text
.minihub
```

JSON-backed and versioned.

Projects contain at least:

- graph topology
- node identities
- node positions
- cables
- VST chains
- stable plugin instance IDs
- complete VST state chunks
- bypass
- Mixer state
- Morpher state
- Morpher stable dynamic inputs/order
- Morpher pattern
- BPM
- project-specific node state

Machine/application settings remain outside projects:

- audio device
- sample rate / buffer preference
- MiniLab hardware input
- VST scanner cache
- application preferences
- project directory

Implemented:

- Save
- Save As
- dirty state
- recent project
- atomic temp-write-and-replace
- load validation before replacing current session
- runtime teardown before New/Load
- close-time VST-state capture
- legacy global session migration as dirty "Recovered Session"

### Current save policy

MiniHub is deliberately **manual-save-only** for now.

```text
Save / Save As
→ explicit manual save

New / Load / Recent / Template / Close / Quit
→ no save confirmation
→ no system dialog
→ no warning sound
→ unsaved changes may be lost
```

The dirty-state mechanism may remain internally, but it must not trigger a confirmation dialog.

No autosave yet. A separate autosave design may be considered later.

---

## 15. Home screen

Current intended Home design:

> **Only four large rounded square tiles.**

No intro.
No version text.
No decorative MiniHub copy.
No long white horizontal strips.

Layout:

```text
┌───────────────┐  ┌───────────────┐
│      New      │  │ Last Project  │
└───────────────┘  └───────────────┘

┌───────────────┐  ┌───────────────┐
│      Load     │  │   Templates   │
└───────────────┘  └───────────────┘
```

Requirements:

- 2×2 by default
- large near-square tiles
- rounded corners
- dark MiniHub visual style
- only main label inside each tile
- recent project tile shows actual project name
- if none exists → disabled `No recent project`

### Navigation behavior requested

Current desired behavior:

```text
Home → New
→ create fresh unsaved project
→ immediately navigate to Routing / Patch Bay
```

Also:

```text
Template
→ new unsaved project
→ Routing / Patch Bay
```

And preferably:

```text
Load project
→ successful load
→ Routing / Patch Bay
```

The latest Codex prompt already requested this.

---

## 16. Startup performance

Recent manual observation:

> Home took more than 4 seconds to appear after opening MiniHub.

This is considered a regression.

Desired startup:

```text
Electron window
→ renderer shell
→ Home visible/interactable
→ background initialization:
   engine
   audio
   VST catalog
   project services
```

Home must **not** wait for:

- native engine handshake
- VST loading
- VST state restoration
- full VST scan
- audio DAG
- project directory enumeration

Target:

> Home visible as quickly as Electron reasonably permits, ideally well under 1 second on warm launch.

Codex was instructed to instrument startup timing and remove blocking startup work rather than guessing.

---

## 17. MiniLab 3 node / controls

The MiniLab node exposes real physical controls for Learn.

Current drawn/vector controls include knobs, faders, pads, pitch/mod, etc.

A previous visual bug:

> MiniLab MIDI OUT phantom cable was too high.

Root cause:

- drag geometry omitted `node.id`
- code fell back to generic port-row geometry

Fixed by using canonical MiniLab geometry for phantom and committed cables.

---

## 18. Planned graphical skin system — NOT YET IMPLEMENTED

The user wants real graphical identities for nodes.

Preferred architecture:

```text
NODE
├─ visual skin/image layer
├─ labels/status
├─ interactive controls
└─ real port/cable anchors
```

Image is cosmetic only.

Routing geometry must never depend on artwork.

Desired examples:

- MiniLab 3 node → real MiniLab 3 image
- Audio Output → user-selected speaker image
- VST OmniBox → official plugin logo/artwork when available
- Mixer / Morpher → later custom artwork

For VSTs, first inspect normal resource files inside installed `.vst3` bundles for usable:

- PNG
- SVG
- JPEG/WebP
- icons
- logos
- branding artwork

Rules:

- prefer artwork already distributed with the plugin
- do not modify VST bundle
- do not reverse-engineer binary-embedded assets
- do not scrape the internet automatically
- fallback to MiniHub default skin
- cache/reference discovered assets
- do not rescan bundles on every Patch Bay render

This work must wait until current project/VST restore bug is fixed.

---

## 19. Current priority — Recorder rework

# **Recorder OmniBox — node UX + take handling**

### Current physical status

The core Recorder / Metronome / Touch-to-Record path is physically working in the packaged app.

Validated chain:

```text
MiniLab → Arpeggiator → instrument VST → Recorder → Audio Output
```

Already validated:

- transparent Recorder AUDIO passthrough
- global metronome
- ARM + Touch-to-Record from physical MiniLab input
- pre-click/count-in
- automatic recording start
- Recorder WAV export
- metronome/count-in excluded from the Recorder WAV

The next Recorder pass is a **UX / take-management rework**, not a rewrite of the working audio path.

### A. Fix Recorder port / cable geometry

Current visible bug: Recorder cables do not land exactly on the visible AUDIO IN / AUDIO OUT sockets.

Required behavior:

- committed cables and phantom/drag cables must use the **exact center of the visible Recorder port sockets**
- AUDIO IN and AUDIO OUT must remain aligned at every supported zoom level and node position
- Recorder-specific geometry must not silently fall back to a generic port-row anchor
- the fix must not move the visual socket merely to match an incorrect cable calculation
- preserve normal cable hit-testing, disconnect and drag behavior

This is the same class of error previously fixed for the MiniLab MIDI OUT phantom cable: visible port geometry and routing anchor geometry must share one canonical source.

### B. Touch-to-Record must be directly available on the node

`Touch Record` is no longer settings-only.

The Recorder Patch Bay node must directly expose:

- ARM
- TOUCH — Touch-to-Record ON/OFF
- REC
- STOP
- PLAY
- DELETE
- EXPORT
- current Recorder state
- current recording/playback duration

`OPEN` remains the direct-access control for the full Recorder settings/editor.

Pre-click length and WAV format may remain in the full settings/editor for now.

All node controls and settings controls must operate on the **same Recorder instance state**. No duplicate UI-only state.

### C. Minimum take manipulation

Export alone is not sufficient. The most recent captured take must be usable before export.

#### PLAY

- plays/auditions the current captured take through the Recorder's normal `AUDIO OUT` path
- therefore downstream routing remains meaningful, e.g. Recorder → FX → Audio Output
- playback must not modify the captured take
- playback must not recursively record itself
- PLAY is disabled when no captured take exists
- global Stop and Recorder STOP must both be able to stop take playback safely

#### DELETE

- clears the current in-memory captured take from that Recorder instance
- immediately disables PLAY / DELETE / EXPORT until a new take exists
- does **not** delete WAV files that were already exported
- does not delete the Recorder node or alter graph routing

#### EXPORT

- remains Recorder-owned
- exports the current take only
- disabled when no take exists
- formats remain 16-bit PCM, 24-bit PCM default, and 32-bit float at the native project/engine sample rate

### D. Recorder state model

Minimum useful states now include:

```text
IDLE
ARMED
COUNT_IN
RECORDING
TAKE_READY
PLAYING
```

State transitions must be driven by the Recorder instance, not inferred independently by the node UI.

No recording or playback automatically resumes after project restoration.

### E. Signal path and realtime constraints

Recorder remains:

```text
AUDIO IN
→ transparent Recorder
→ AUDIO OUT
```

It captures exactly the audio present at its position in `hub.graph`.

Examples:

```text
VST → Recorder → Audio Output
VST → FX → Recorder → Audio Output
Mixer → Recorder → Audio Output
```

Recording remains native and realtime-safe. Disk writes must stay off the audio callback. Take playback must also avoid file I/O or blocking work on the realtime audio callback.

### F. Existing Touch-to-Record contract — preserve

Touch-to-Record requires:

```text
ARM = ON
Touch Record = ON
```

The first qualifying **external physical controller event** starts the recording sequence. Qualifying input includes, where supported by the existing ingress:

- MIDI Note On / pad hit
- MIDI CC
- knob/fader movement
- pitch bend
- modulation
- aftertouch
- other meaningful physical controller events

It must not trigger from internal/generated events such as Arpeggiator output, metronome, transport events, project restoration, internal CONTROL automation or engine synchronization.

The triggering physical event is observed, not consumed, and continues through its normal routing path. Repeated events must not restart count-in.

Touch-to-Record must continue to work without pressing global Play first.

### G. Metronome / count-in contract — preserve

- global metronome: ON/OFF, volume, 4/4, accented beat 1, normal beats 2/3/4
- synchronized to the native transport/BPM
- Recorder pre-click: Off / 1 / 2 / 4 bars
- pre-click works even if the global metronome is OFF
- metronome and pre-click are monitoring-only and must not enter Recorder audio unless an explicit future option is designed

---

## 20. Manual validation sequence for Recorder / Metronome

After the Recorder rework, use the packaged application and physical MiniLab.

Test chain:

```text
MiniLab
→ Arpeggiator
→ instrument VST
→ Recorder
→ Audio Output
```

Validation:

1. confirm the Recorder AUDIO IN and AUDIO OUT cables terminate exactly at the visible socket centers
2. zoom/pan/move the Recorder node and confirm cable anchors remain exact
3. confirm ARM and TOUCH are directly usable on the Recorder node
4. set `ARM = ON`, `TOUCH = ON`, `Pre-click = 2 bars`, global Metronome OFF
5. without pressing global Play, touch a physical MiniLab control
6. confirm 2-bar count-in starts and recording begins afterward
7. record a short take and press STOP
8. confirm state becomes `TAKE_READY` and PLAY / DELETE / EXPORT become available
9. press PLAY and confirm the take is heard through Recorder AUDIO OUT / downstream routing
10. stop playback from Recorder STOP, then repeat and stop it with global Stop
11. export WAV 24-bit and confirm count-in/metronome is absent
12. press DELETE and confirm the in-memory take is cleared
13. confirm PLAY / DELETE / EXPORT are disabled after deletion
14. confirm the previously exported WAV still exists
15. confirm normal live AUDIO passthrough and graph routing still work
16. confirm no stuck MIDI notes, no crash and no VST scan/Home regression

Automated tests are useful for state transitions and geometry helpers, but visible socket alignment, physical Touch-to-Record behavior, audible playback and packaged runtime behavior require manual validation.

---

## 21. Development principles

Continue following:

- modular architecture
- targeted edits over rewrites
- minimize dependencies
- avoid speculative abstractions
- no irreversible architecture decisions without discussion
- `hub.graph` remains source of truth for topology
- UI state, routing state, persisted state and native runtime state stay separate
- audio quality and latency are primary constraints
- manual physical tests matter
- tests must not claim hardware/perceptual behavior they cannot verify
- advanced behavior remains opt-in
- preserve the simplest path:

```text
MiniLab → VST → Audio Output
```

---

## 22. Workflow preference / coding-agent status

Normal preferred roles:

- **Codex** — audits, difficult implementation and regression fixes
- **Claude Code** — deeper audits/debugging and higher-risk implementation
- **ChatGPT** — architecture, prompts, specification and continuity

Current handoff status on 2026-08-19:

- Codex usage is currently exhausted
- Claude Code usage is currently exhausted
- **DeepSeek is excluded from MiniHub coding work**

Reason for excluding DeepSeek: its latest session broke the VST scan and Home; those regressions had to be repaired afterward with Claude Code. Do not assign MiniHub implementation or repair work to DeepSeek unless the user explicitly reverses this decision later.

When work resumes with a coding agent:

- provide one complete copyable prompt
- avoid unnecessary user decision points
- make targeted edits rather than broad rewrites
- protect already repaired VST scan/startup/Home behavior
- verify each coherent pass before continuing
- do not let the coding agent silently change architecture
- distinguish source implementation, successful build and actual runtime validation
- `dist\MiniHub\MiniHub.exe` is the user's real validation target
- source-level tests must never override contradictory visible/runtime behavior
- native changes must be compiled and the packaged native binary refreshed before claiming they are usable

---

# Recommended starting point for the next discussion

Start from the protected working state:

```text
VST scan / cached catalog / Home
→ repaired after the latest DeepSeek regression
→ do not disturb during unrelated work

Recorder core audio path
→ physically working
→ Touch-to-Record + count-in + WAV export validated

Project save policy
→ manual Save / Save As only
→ no destructive-action save prompts
→ no autosave yet
```

Current implementation priority:

```text
Recorder rework

1. fix AUDIO IN / AUDIO OUT cable anchors so they exactly match visible socket centers
2. expose TOUCH directly on the Recorder node
3. keep ARM / REC / STOP / EXPORT on-node
4. add PLAY for the current captured take
5. add DELETE for the current in-memory take
6. add TAKE_READY / PLAYING state handling
7. synchronize node and settings with one Recorder instance state
8. preserve working Touch-to-Record, count-in, transparent passthrough and WAV export
9. preserve VST scan and Home behavior
```

Primary workflow:

```text
ARM + TOUCH
→ physical controller event
→ count-in
→ record
→ STOP
→ PLAY / replay
→ EXPORT or DELETE
```

The next coding pass should be narrow: **Recorder UI geometry + Recorder take management only**, with explicit regression protection around the audio path, VST scan and Home.
