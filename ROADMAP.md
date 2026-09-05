# MiniHub — Roadmap

A steering document: what has been done, what is left to do.
Repository entry point: [AGENTS.md](AGENTS.md). Architecture and code:
[ARCHITECTURE.md](ARCHITECTURE.md). Product scope: [INTENT.md](INTENT.md).
Counter-intuitive choices: [DECISIONS.md](DECISIONS.md). Long workstreams:
[PLANS.md](PLANS.md).

**Current state** — branch `master`.
678 JS tests green, 15 `npm run check` rules green, 3,954 native checks green
across the four test binaries, a Release build with **0 errors and 0 warnings**,
`dist/` synchronised with the sources.

The caveat this line used to carry is gone, **fixed 2026-09-05**: the four
`C4996` warnings on the deprecated `juce::MidiBuffer::Iterator`, in the
arpeggiator's real-time path in `midi_network.cpp`, are the range iterator JUCE 9
wants. "0 errors, 0 warnings" is now true of a **recompile** and not only of an
incremental build — verified by touching the source to force it and reading the
whole build log rather than its tail, which is what let those warnings hide
behind a cached object file in the first place.

The goal of this whole pass is **consolidation before new modules are added**.
Items 1 to 3 removed the structural obstacles; item 4 is what is left before
adding a module becomes mechanical. Item 8 answered a different question — taking
the hardware out of the core — and its Étape A finished on 2026-09-04, so
`plans/active/` is empty and the next workstream can take the slot.

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
`PORT_TYPES`, and three `dispose()` that are never called
(`ControlBindingManager`, `HardwareConfigManager`, `SequencerController` — only
`EngineClient`'s is used, in the tests).

**Over-exported** (used only inside its own file): `clearFollowingTies`,
`pitchRowsForPattern`, `pitchLabel`, `TEMPO_MIN`, `TEMPO_MAX`,
`PLUGIN_FAMILIES`, `knobArcDash`, `knobPointerTransform`, `pearlKnob`,
`DOCK_MIN_H`, `PORT_ROW`, `PAD_BOTTOM`, `renderControlBindings`.
`MINILAB_NODE_HEIGHT` left this list by disappearing (item 8, step 6), and
`dockHeight` left it by acquiring a test. `isMiniLab3Name` left the dead list
the same way `MINILAB_NODE_HEIGHT` left this one: the port ranking became data,
and the last regular expression that spelled a device name went with it.

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

### 8. The controller platform — A done, D-022's half of B done; the plural refused

The hardware has stopped being code. `MINILAB_CONTROL_SOURCES` **was** a profile
written as a JavaScript literal; it is now derived from
`midi/profiles/minilab-3.json`, which declares the 25 controls, the messages they
send and where they sit. The decoder answers from it, the Patch Bay draws from
it, and the engine no longer knows any keyboard by name.
[DECISIONS.md](DECISIONS.md) D-020 is what opened the door; D-008 is closed by
the same work.

Specification: [MINIHUB_CONTROLLER_PLATFORM_SPEC.md](MINIHUB_CONTROLLER_PLATFORM_SPEC.md).
Execution plan, finished 2026-09-04:
[plans/done/controller-profile.md](plans/done/controller-profile.md) — 9 of 9
steps, each with the command that proved it.
Proof of that step: 631 JS tests, 12 `npm run check` rules (three of them new and
about profiles), 3,954 native checks, and the author's own project opening with
every cable, node position and instance it was saved with.

**Étape B was not taken as written.** [DECISIONS.md](DECISIONS.md) D-022 splits
it: the single controller slot becomes a profile slot, so a friend with another
keyboard can use MiniHub — and the plural (`selectedInputId`, N controller nodes,
multi-input `MidiManager`) is refused until a second keyboard exists on a desk.
The author owns one controller, asked directly on 2026-09-04. Plan, finished
2026-09-04: [plans/done/other-controller.md](plans/done/other-controller.md),
6 of 6 steps, each with the command that proved it. Nothing under
`src/renderer/js/core/` or `src/renderer/js/ui/` names a device any more: the
shell asks the routing node what the controller is called, and the node takes
that name from the profile. A fixture profile for a device nobody owns
(`test/conformance/vega-49.json`, with its own 27-case corpus) is what says the
machinery follows a profile rather than the profile that ships. Two check rules
were added -- `device name out of the shell` and `one profile ships`.

Proof of the end, with the controller plugged in: Windows enumerated the four
ports the profile declares and the armed input was `Minilab3 MIDI` -- **not**
`Minilab3 DIN THRU`, which enumerates second and which the pre-profile ranking
would have taken. 194 messages arrived and were decoded. Every device name on
screen came from the profile through the routing node. Port selection is exactly
what `npm test` cannot see, which is why this line exists. Mechanically: 674 JS
tests, 15 `npm run check` rules.

Two gaps the fixture surfaced were recorded in its corpus rather than left to be
found, and **the stateless half of them closed on 2026-09-05**. `channelpressure`
is decoded: it names no note and no controller number, so the binding that answers
is found by kind and channel alone. `range` is read: a value is normalised against
the travel its binding declares and clamped to it, where everything used to be
divided by the wire format's span. The shipped profile declares `[0, 127]` on
every binding that carries a range, which is exactly what ignoring the field
computed -- so nothing changed for the MiniLab, and
`test/conformance/midi-corpus.json` is untouched, byte for byte. Six fixture cases
and four unit tests are what say the two fields now do something; two of the six
exist only because 0 and 127 would have passed with `range` still ignored.

**What is left of those two gaps is not one thing but two, and the line above used
to flatten them.** `cc14` is decoder work, and it is the expensive half: MSB and
LSB arrive as two messages, so a 14-bit value needs the MSB latched between calls
-- state, inside a function that has none and whose shareability rests on being
`(profile, message) -> answer`. The conformance corpus is a list of independent
cases and cannot express a pair either, so closing that gap moves the format the
site Builder's copy is checked against (spec §3.5). `mode: relative` is **not**
decoder work: the corpus already records the position -- the decoder reports which
control answered and the byte it carried, and turning a delta into a position
belongs to the caller. What is missing there is a consumer in
`core/controlBindings.js`, not a branch in `decodeControl.js`.

What the two plans leave behind, named rather than left to be discovered: the
pad function labels and the faceplate decoration still have no field in the
format, and one device cannot say what that field should be; a binding whose
profile is absent is kept but not shown, because with one built-in profile there
is nothing to show; and what is left of the decoding gaps above -- `cc14`, and a
consumer for `mode: relative`. What Étape A owed and B
paid: the decoder no longer asks `midi/minilab.js` anything — it reads
`device.ports` from the profile (§4.2) and is the artefact §3.5 wants copied
into the Builder, with `npm run check` refusing any import that would break the
copy.

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

**Where a `layout` comes from, decided 2026-09-05** —
[DECISIONS.md](DECISIONS.md) D-023, **specification only, no code**. The
Builder's five steps capture what a device *sends* and never where its controls
*sit*, so `layout` was a required field nothing could fill — and it is not
decoration: `nodeGeometry.js` places a control port at its profile coordinate, so
the drawing is the wiring surface and a wrong one makes the user cable the wrong
control in silence. It becomes optional. With a photograph of the user's own
device, calibration asks one click per control and the coordinates are measured;
without one, the controls are a list and `layout` is absent. A default grid was
refused: it invents an ordinality that CC numbers do not carry. Nothing is built
— while the MiniLab is the only profile the list mode is never reached, and it
becomes necessary with Étape C. Spec §4.4 (revised) and §5.3 bis.

**The site is a catalogue, and MiniHub cannot read a profile — decided
2026-09-05** — [DECISIONS.md](DECISIONS.md) D-024 and D-025, **specification
only, no code**. The Builder stays on the site, because a profile that works
serves everyone owning that hardware: calibration is paid once per model, not
once per user, and where a profile is created decides where it gets shared. The
site recognises a device by its MIDI port name and opens its page, indexes the
catalogue twice (hardware → authors, author → devices), and counts stars on
GitHub as a committed snapshot — no backend, no account, no deep link. `profileId`
names the hardware and `author` names who mapped it, so trying a competing
profile does not cut a single cable.

**What that makes the next piece of work, and it is in the application:**
`loadedProfile.js:22` imports the profile at **build time**. There is no import
path and `preload.js` exposes no file access for profiles, so the catalogue would
serve files nothing can consume. It stands on its own — a friend writing a
profile by hand needs it as much as the Builder does — and it is what D-022 froze
deliberately.

**No vision model — measured, not argued, 2026-09-05.** Five detectors run in the
browser (OWL-ViT, OWLv2, DETR, Florence-2 base and large, plus twenty lines of
JavaScript), each handed the control counts the MIDI calibration already knows.
Best result: OWLv2 at ~600 MB found the eight backlit pads and called piano keys
faders. Size did not help — Florence-2 large matched its base at one shape,
"computer monitor". The criterion that closes it is the author's: **the reference
photograph is the poor one**, because that is what people will send. What
survives is the click, which is robust precisely where detectors collapse, and
which costs no download. Spec §10 question 0, D-023.

**How a setup arrives, decided 2026-09-05** — [DECISIONS.md](DECISIONS.md)
D-026, **specification only**. It is published the moment it arrives: no queue,
no approval, nothing waiting on one person. A Cloudflare Worker on the account
that already holds the DNS takes the file, the vote and the report; the site
stays static and the credential never reaches the page. A report button replaces
a word filter — the harmful setup is the **wrong** one, not the rude one, and no
list sees that. Repeat votes are deduplicated by a hash of the address, which
stops the bored click and not a determined person, and keeps no address. No
account anywhere, so the nickname is typed rather than proven, which revises
D-025 and moves the stars off GitHub. And `setup` becomes the word the user reads
while `profile` stays the word of the format: renaming it for real would touch
417 occurrences, invalidate every file written so far and force `formatVersion`
2, for a word only the code reads.

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
~~Fix the four `C4996` deprecation warnings in `midi_network.cpp`~~ — **done
  2026-09-05**, its own commit and the four native binaries, 3,954 checks.
