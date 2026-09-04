# MiniHub — Roadmap

A steering document: what has been done, what is left to do.
Repository entry point: [AGENTS.md](AGENTS.md). Architecture and code:
[ARCHITECTURE.md](ARCHITECTURE.md). Product scope: [INTENT.md](INTENT.md).
Counter-intuitive choices: [DECISIONS.md](DECISIONS.md). Long workstreams:
[PLANS.md](PLANS.md).

**Current state** — branch `master`.
627 JS tests green, 3,954 native checks green, clean Release build, `dist/`
synchronised with the sources.

One caveat on that build, recorded here so it stops being invisible: it reports
**four `C4996` warnings** on the deprecated `juce::MidiBuffer::Iterator`, inside
the arpeggiator's real-time path in `midi_network.cpp`. They predate D-019 — a
cached object file had been hiding them, and renaming the source forced the
recompile that surfaced them. Until they are fixed, "0 errors, 0 warnings" is
true of an incremental build only.

The goal of this whole pass is **consolidation before new modules are added**.
Items 1 to 3 removed the structural obstacles; item 4 is what is left before
adding a module becomes mechanical. Item 8 runs alongside it and answers a
different question — taking the hardware out of the core — and it is the one
holding the single active-plan slot.

---

## Done

### 1. A fallback point, and repository hygiene — `c3c00c9`

The repository had been detached from the real code since `601ec70`: the entire
current audio engine (`sequencer.cpp`, `audio_network.cpp`, `master_output.cpp`,
`midi_network.cpp`, `engine2/`) was uncommitted, and about a hundred source
files were modified or missing. There was no state to go back to.

- 216 files committed, 8.5 MB, after full verification.
- `.gitignore` extended: it covered one build tree out of seven.
- Repository compacted: `.git` 120 MB → 5.6 MB (1,521 loose objects, no pack).
- Source↔binary consistency proven: the rebuild **relinked nothing**, so the
  committed sources are exactly the ones that produced the working executable.

### 2. Documentation purge and archiving — `4ba5934`

Disk: **13.7 GB → 3.9 GB**.

- Six abandoned native build trees deleted (`build-asan` 5.4 GB, `build-ninja`,
  `build-clip-editing*`). `build/` — the authoritative one — untouched.
- Builds, SDKs and captures of both prototypes deleted; their **sources** kept
  and committed (Engine 2 now lives in `native/audio-engine/src/engine2/`, and
  compiles).
- `artifacts/` 300 MB → 58 MB, surgically: 15 reports cited 43 `artifacts/`
  paths as evidence, and a bulk purge would have orphaned them. Only the
  disposable Chromium profiles and the 98 audio renders no report cited were
  removed.
- The 25 historical reports were archived, then replaced by the two current
  documents. They remain readable in git history at commit `c3c00c9`.

### 3. Unifying shared identities — `f4ec31f`

Four duplications that made adding a module a trap.

- **`core/systemNodes.js`** — `'minilab-3'` was redeclared in **nine modules**
  under three different names, `'audio-output'` in three. Silent failure mode: a
  copy forgotten during a rename raises no error, the network simply stops
  matching.
- **`core/projectKeys.js`** — the project/application list existed twice. A key
  added on one side only fails in two opposite directions: a stale value
  surviving into a new project, or project state written into global
  preferences.
- **`main/settings.js`** — `DEFAULTS` declared 6 keys for 17 in use, and held
  `networkConnections`, which is project state.
- **`ModuleSystem.unregister`** now undoes exactly what `register` does, routing
  node included. Two tests lock the symmetry, and their ability to catch the
  regression was verified by disabling the fix.

### Outside the numbering

- Snapshots from 24/08 preserved as branches (`snapshot/2026-08-24-*`), then
  both `.old` folders deleted: **23.3 GB → 4.7 GB** on disk. The code they held
  weighed 4 MB; everything else was regenerable.
- `dist/` resynchronised. The provenance manifest declared `gitHead 601ec70`
  with `worktreeDirty: true` — so it lies less now.
- This documentation: `ARCHITECTURE.md` (then named `BLUEPRINT.md`) +
  `ROADMAP.md` replace 25 Markdown files scattered at the root.
- The document set aimed at agents: `AGENTS.md` (map and rules), `CLAUDE.md`
  (an import, since Claude Code does not read `AGENTS.md` on its own),
  `INTENT.md` (product scope), `DECISIONS.md` (the decision register),
  `PLANS.md` + `plans/` (long workstreams). `BLUEPRINT.md` renamed
  `ARCHITECTURE.md`. `scripts/check-invariants.mjs` (`npm run check`) makes
  seven of the twelve invariants mechanical; its ability to catch was verified
  by probe. **Still to settle**: the open questions in `INTENT.md` §11.

---

## To do

### 4. Split `nodeInstances.js` — the real workstream

**This is no longer what blocks adding a module — measured 2026-09-03.**
`core/nodeEditors.js` and `core/disposers.js` exist (kept from D-013), and
**every** shared handler in `mount()` filters on an explicit `type.id`: lines
693, 853, 1008, 1019, 1043, 1082, 1089. A **new** type therefore passes through
them without touching them, and its editor fits in its own folder plus one
`registerNodeEditor()`. The residual cost is two or three branches to add in
`defaultContentFor()` and in content normalisation.

What remains true, and remains the workstream: **the four editors that predate
that seam** (VST, Arpeggiator, Mixer, Morpher) still co-own each other's bugs,
and any change to one is paid for in code shared with the other three.

[nodeInstances.js](src/renderer/js/core/nodeInstances.js) is 1,143 lines and has
become a god file. Its `_registerModule()` holds a **440-line** `mount()` (lines
651 to 1090) driving **four different editors** — VST, Arpeggiator, Mixer,
Morpher — through 26 `type.id === '…'` tests scattered across 9 event handlers,
each opening with `if (type.id !== 'X') return;`.

Concrete consequence: adding a node type means editing that file in about ten
places, in code shared with four other types.

**Proposed target:**

```
core/nodeInstances.js     pure registry: identity, content, persistence,
                          creation / deletion / duplication
core/nodeEditors.js       table typeId -> { render, bind }
modules/vst/…             VST editor (chain, scan, CONTROL bindings)
modules/arpeggiator/…     arpeggiator editor (already half extracted into
                          core/arpeggiatorEditor.js)
modules/nativeAudio/…     Mixer + Morpher editor (they already share rendering)
```

Sub-tasks:

- extract a `createDisposers()` helper: `mount()` currently registers 9 DOM
  listeners, mirrored by hand in **three** places (declaration, storage on
  `module._onX`, removal in `unmount`). Adding a listener means touching all
  three.
- lift `NATIVE_VALUE_COALESCE_MS` (declared in the middle of the import block,
  line 54) and the write batching into the shared helper.
- document the editor contract in ARCHITECTURE.md once it has settled.

**Expected benefit**: a new node type = a new folder plus one line in the table,
with no change to the registry.

### 5. Dead code, duplicates and logging

Inventory established during the audit; everything below is verified.

**Genuinely dead** (no reference in `src/` or `test/`): `buildStampLabel`,
`isMiniLab3Name`, `PORT_TYPES`, and three `dispose()` that are never called
(`ControlBindingManager`, `HardwareConfigManager`, `SequencerController` — only
`EngineClient`'s is used, in the tests).

**Over-exported** (used only inside its own file): `clearFollowingTies`,
`pitchRowsForPattern`, `pitchLabel`, `TEMPO_MIN`, `TEMPO_MAX`,
`PLUGIN_FAMILIES`, `knobArcDash`, `knobPointerTransform`, `pearlKnob`,
`DOCK_MIN_H`, `PORT_ROW`, `PAD_BOTTOM`, `renderControlBindings`.
`MINILAB_NODE_HEIGHT` left this list by disappearing (item 8, step 6), and
`dockHeight` left it by acquiring a test.

**Duplicates**:

- `dedupeDevices` (`src/renderer/js/modules/audioOutput/audioOutputModule.js:32`)
  and `uniqueDevices` (`src/renderer/js/core/hardwareConfig.js:20`) — the same
  function, two versions;
- five separate definitions of `clamp`;
- two `formatDb` with different semantics (dBFS versus gain→dB);
- `identityHeight(node)` ignores its parameter
  (`src/renderer/js/core/nodeGeometry.js:32`);
- `export const homeModule` (`src/renderer/js/modules/home/homeModule.js:55`)
  exists only for a test and duplicates the real module's `navEntry`.

**Logging** — `src/renderer/js/core/engineClient.js:204` runs a `console.log` on
**every** engine event, including `masterMeter` (10 Hz), `transport`,
`hostTiming`, `audioPathTelemetry`. And `src/main/main.js:89` relays every
renderer console message to the main process. This is exactly what
[engineEventTrace.js](src/main/engineEventTrace.js) was written to prevent —
except that the filter only covers the disk path. The `command()` method just
below (line 401) already applies the right filtering; `_onEvent` should adopt
the same logic.

~~**Identity on the C++ side**~~ — **done 2026-09-04**, item 8 step 8.
`isPhysicalMidiDestination()` is deleted; the engine reads the node kind the
renderer already sends. `minilab-3` appears nowhere in `native/`, and invariant 7
is complete on both sides. See [DECISIONS.md](DECISIONS.md) D-008.

**Escaping** — `src/renderer/js/core/nodeInstances.js:240` interpolates
`${instance.name}` without `escapeHtml`, the only exception among neighbouring
templates. Not exploitable (the name derives from the type and the ordinal), but
worth aligning.

### 6. Visual consistency and naming

**Two design systems coexist, and that is deliberate.** `base.css` (1,486
lines, `.panel`/`.btn` vocabulary) dresses the **dark shell**: header, sidebar,
Patch Bay, modals. `omni-pearl.css` (967 lines, `op-*` vocabulary) is a **light,
device-faceplate** language, meant for instrument surfaces placed inside that
shell. Its header documents it: a module opts in by putting the `omni-pearl`
class on its root, and "nothing leaks outside that subtree".

Measured 2026-09-02: `op-` is used by **three** files only — `ui/omniPearl.js`
(the library, 18 classes), `core/arpeggiatorEditor.js` (23) and
`core/nodeInstances.js` (7, to mount the arpeggiator shell). So this is not an
unfinished migration but a **started system**: one module out of N wears the
faceplate meant for them all.

**Settled 2026-09-02** ([DECISIONS.md](DECISIONS.md) D-012): containment, not
layering — a module picks one vocabulary for its whole subtree, the shell is
never given a faceplate, there is at most one faceplate, and by default a new
module uses `base.css`. Two of those rules are mechanical (`npm run check`:
`faceplate scope`, `one faceplate`).

So **no mandatory work remains** here. Extending the faceplate to the other node
editors (Mixer, Morpher, VST) is still possible, editor by editor, and is a
matter of taste: the `ui/omniPearl.js` library is generic and explicitly allows
for it.

**Four names for one product**: "MiniLab Hub" (window title, README), "MiniHub"
(executable, `dist/MiniHub`, the `.minihub` extension, `Documents/MiniHub`),
`minilab-hub` (npm name, log file), `mlh_` (native prefix). To be unified,
bearing in mind that the log file name and the `%APPDATA%` directory are paths
that already exist on the user's machine.

**Writing style** — cleanly formatted passages sit next to compressed, near
unreadable lines: `nodeInstances.js:316-323` and `341-355`, `engineSync.js:35`,
`engineClient.js:655`. To be smoothed out as those files are visited, without a
dedicated cosmetic pass.

---

### 7. The Matrix node — replacing the Morpher as product direction

**Specification**: `SPECIFICATION_MATRIX_MINIHUB.md` (the full functional
target, revised 2026-09-03 against the real code).

A single control node per project, governing the nodes it is wired to by a
`control` link: scenes, target states, ramps, and output rules with a
reproducible seed. It produces no sound; it governs the setup that does.

Three decisions were taken before any code, because each one would have made the
workstream impossible or wrong had it been discovered halfway through:

- **D-016** — `automation` leaves the "out of scope" list in
  [INTENT.md](INTENT.md) §6, in the precise form of a Matrix node. The DAW
  automation lane stays refused. See [INTENT.md](INTENT.md) §8 bis;
- **D-017** — the Matrix counts its own musical time, at the global tempo.
  Clocking it on the Transport **position** froze it as soon as a scene stopped
  the sequencer, and rewound it on every `Restart`;
- **D-018** — one armed Learn in the application, with a named owner. Two
  independent Learn systems cancelled each other silently.

Three mechanisms the specification assumed existed and that are **still to be
built**: the post-chain gain stage of a VST node (§7.2 — `masterLevel` is only
applied on `mixer` nodes), the visibility of a `ctrl-in` on a node with dynamic
inputs (§4.3 — `nodeInstances.js:289`), and a dual-context live/export runtime
(§9.1).

**Execution plan**: [plans/done/noeud-matrix.md](plans/done/noeud-matrix.md) — 23
steps across four phases, each with its verification command. **On standby**, not
started: it left `plans/active/` to free the single slot for item 8 below, and two
of its points are already stale. The note at its head says which.

The Morpher is not removed — it leaves the add menu and stays functional as
`legacy` (§12). Removing it for good is a separate workstream.

### 8. The controller platform — Étape A in progress

The hardware stops being code. `MINILAB_CONTROL_SOURCES` in
`midi/minilabControls.js` **is** a profile, written as a JavaScript literal;
[DECISIONS.md](DECISIONS.md) D-020 lifts the refusal that kept it there, for
exactly two things — a versioned declarative format, and profiles living as
files. Extracting it is owed whether or not a second controller ever exists
([INTENT.md](INTENT.md) §5 calls hardware in the core a defect).

Specification: [MINIHUB_CONTROLLER_PLATFORM_SPEC.md](MINIHUB_CONTROLLER_PLATFORM_SPEC.md).
Execution plan:
[plans/active/controller-profile.md](plans/active/controller-profile.md) — 9
steps, 1 to 8 done.

Order, and it is the one thing here that costs money if missed:

```text
A  →  (the gate of §2)  →  B  →  C  →  D
```

| | | |
|---|---|---|
| A | the internal profile | no new controller, no new product surface |
| B | the plural | multi-input `MidiManager`, N controller nodes — crosses the gate |
| C | the site and the Builder | separate codebase; A's decoder is copied, not rewritten |
| D | shared profiles | a folder, a README, pull requests |

**A before phase 2 of the Matrix** (item 7 above, spec §6.8), or the
`ControlBindingManager` refactor is paid twice.

**Device cards land in C** — spec §5.4. One page per device: photo, history,
specifications, connectors, keybed, and a blueprint generated from the profile
rather than drawn by hand. Written by the author, after the rest.

### 9. The bindings bar, docked under the plugin window

Decided 2026-09-04, not started: [DECISIONS.md](DECISIONS.md) D-021. Learning a
knob costs two windows today, and the plugin editor usually covers what you were
reading. A frameless Electron window carrying the existing bindings interface
docks under the plugin editor and moves with it.

It **replaces** the bindings panel rather than duplicating it: afterwards,
`renderControlBindings()` is gone from the VST node's editor and bindings are
reached from the plugin window only.

The plugin editor is a hand-built Win32 frame owned by the **engine process**, so
Chromium cannot draw inside it — which is why this is a second window rather than
a strip, and why the alternatives were refused. See D-021.

Native work, and it is the whole of it: `editorStatus` reports `width` and
`height` but no position, and nothing is emitted when the window is dragged. The
engine has to report the frame's position on move and on resize.

**Order**: after item 8's Étape A, and after or with D-018 — that decision
refactors `ControlBindingManager`, which is what this window drives. Out of
order, the refactor is paid twice.

---

## Ideas beyond consolidation

No commitment, no priority — written down so they are not forgotten.

- The `video` and `image` node types exist in the registry with empty ports;
  nothing implements them.
- The README used to list "sends, sidechains, automation, preset management,
  minimap, undo/redo, automatic network layout, node groups" as out of scope.
  **They all remain so.** Preset management was the exception from 2026-09-02 to
  2026-09-03: the workstream reached step 8 of 9 and was then withdrawn, and the
  refusal is upheld ([DECISIONS.md](DECISIONS.md) D-013).
- The ten `runtime-*-gauntlet.mjs` scripts are one-off harnesses tied to closed
  investigations. To be grouped under `scripts/gauntlets/` or removed once their
  use is confirmed obsolete.
- Fix the four `C4996` deprecation warnings in `midi_network.cpp`: replace
  `juce::MidiBuffer::Iterator` with modern JUCE iteration. It sits in the
  arpeggiator's real-time path, so it deserves its own commit and its own native
  run — `--core` plus `mlh_realtime_output_tests.exe`.
