# MiniHub — Roadmap

A steering document: what has been done, what is left to do.
Repository entry point: [AGENTS.md](AGENTS.md). Architecture and code:
[ARCHITECTURE.md](ARCHITECTURE.md). Product scope: [INTENT.md](INTENT.md).
Counter-intuitive choices: [DECISIONS.md](DECISIONS.md). Long workstreams:
[PLANS.md](PLANS.md).

**Current state** — branch `master`.
848 JS tests green, 15 `npm run check` rules green, 3,954 native checks green
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
the hardware out of the core — and its Étape A finished on 2026-09-04, so the slot
was free for **importing a profile**, finished 2026-09-05 (item 8 below, D-027 to
D-030).

`plans/active/` is **not** empty, and the line above used to claim it was:
[two-controllers-at-once.md](plans/active/two-controllers-at-once.md) has all
eight steps ticked and committed since 2026-09-05, and has never been seen
running with two keyboards on the desk — the BeatStep is the missing part, not
the code. PLANS.md §2 says finished means moved; until that pass happens it
holds the single slot.

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

### 10 & 11. The sequencer: a diet, a menu, a scissor, and a note that follows the cursor — `master`

Both items were opened by the author on 2026-09-07 and closed together on
2026-09-10, because they turned out to be one screen. Decisions:
[DECISIONS.md](DECISIONS.md) D-033 (the diet and the inspector), D-034 (the
split), D-035 (one Snap). **809 JS tests**, 15 `npm run check` rules.

**The silent gate (item 10)** — a project with no authored sequencer state now
opens on one focused MIDI track (`initialSequencerState`, seeded in
`SequencerController.load()` on the **absence of the key**, so a project
emptied on purpose reopens empty). And the transport says why a played note is
heard by nothing: `liveBlockReason()` answers the question `recordBlockReason()`
stopped one condition short of — a track armed and routed on its input side
alone passes the record check and still plays into silence, which is precisely
what was found in use. The two share `_inputRouteBlockReason` so one missing
cable cannot produce two different explanations.

**The diet** — `TRACK_HEADER` 360 → 260, `TRACK_HEIGHT` 140 → 64; thirteen
tracks on screen where six fitted. Routing lives in a toolbar inspector for the
focused track, with two route dots left on the track itself so the failure
D-033 describes stays visible where it happens. Details and the three
consequences that were not obvious: D-033.

**Zoom that frames something** — `Fit` and `Focus` buttons, `Ctrl`+wheel
anchored under the cursor, `+` / `-`, and a logarithmic slider (linear over a
240-fold range puts everything useful in two pixels of travel). The zoom floor
went to 1 px per quarter, which is what made Fit true rather than approximate;
`gridPx` and `rulerStride` are what keep the grid and the ruler readable down
there.

**A context menu on a clip** — and **this item's claim that it would be the
first menu in the application was false**. The Patch Bay has had two since
before it: one on a node, one on the canvas, hand-built inside
`routingModule.js`. The code settled it, not the document.
[ui/contextMenu.js](src/renderer/js/ui/contextMenu.js) therefore exists to stop
the sequencer's from becoming a *third*, and it borrows the Patch Bay's existing
`.ctx-item` / `.ctx-separator` vocabulary rather than inventing a second look —
after a first attempt that declared `.ctx-item` again and silently restyled the
Patch Bay's own menus, a test now keeps that from coming back.
**Still to do**: adopt the module inside `routingModule.js` and delete the copy
there. It is not a move — the canvas menu carries a New Node submenu the shared
module has no concept of.

**The scissor** — `splitClip`, non-destructive, at the playhead: D-034.

**The note that popped** — the Clip Editor's `pointerMove` computed a target and
touched no DOM, so nothing moved until the pointer came up and an IPC round trip
plus a full re-render made the note reappear elsewhere. It has a
`renderNoteDragPreview` now, and the clamp it draws with is the model's own
(`clampNoteGroupDelta`, exported and shared across the two windows) so the drawn
position **is** the committed position. Verified by driving the real editor in a
browser: three selected notes, one `move-notes` message, and identical pixel
positions before and after release.

Its twin defect went with it: a drag carried one note id, so selecting a
five-note chord and dragging it moved one note. A selection now moves as a group
under one common delta — `moveClips`' rule, because clamping note by note
silently flattens a chord against the clip boundary.

**And the rest of the piano roll**, which was frozen at 120 px per quarter and 18
px per row — a four-bar clip was 1920 px wide and the keyboard 2304 px tall, so
the whole clip was never on screen: an H/V zoom fitted to the clip and its pitch
range on open, `Ctrl`+wheel (`Shift` for the rows), a lasso, resize by either
edge, velocity as colour and as a slider over the selection, duplicate, and the
arrows. Plus, on the arrangement: a lasso over the lanes, `Ctrl+A`, `Ctrl+X`,
and arrow-key nudging by one snap step or one track.

One defect found only by looking at the real thing in a browser: `render()`
captured the live scroll position before rendering, which overwrote the position
Fit and the zoom had just computed **in the old scale** — so both appeared to do
nothing. `scrollIntent` is what separates "keep where you are" from "go here".

**Three more, reported from use on 2026-09-10 and fixed the same day.**

- **Resizing a clip stretched its notes.** Purely visual and therefore worse
  than a real error: the marks were placed in percentages of the clip's width,
  `renderDragPreview` rewrites that width during the drag, and every percentage
  re-resolved against the new one. They are placed in pixels now, and a resize
  rebuilds them — the end edge moves `lengthPpq`, the start edge moves
  `sourceOffsetPpq`, and only a rebuild follows which part of the source is
  shown. Verified in a browser: the width goes 576 → 882 px while the marks do
  not move a pixel, before or after the commit.
- **The piano roll played nothing.** [DECISIONS.md](DECISIONS.md) D-036. A key
  press, a note press and each row a transposing drag crosses now sound
  through the clip's own track.
- **The white scrollbar under the arrangement is gone**, replaced by
  `.seq-rail`: four dark pixels that grow to eight under the pointer, hidden
  entirely when the arrangement already fits, and draggable. `railThumb` draws
  it and reads it back through one mapping, because two would let the thumb
  jump out from under the pointer that grabbed it. Middle-button drag pans both
  axes; the shell's remaining scrollbars are slim and dark instead of white.
  The vertical one is deliberately kept — with 64 tracks, "there is more below"
  has to be visible somewhere.

Two defects the browser found in that work, both of the same family — reading a
measurement that the code had just invalidated:

- the rail decided whether to show itself from its own width **while hidden**,
  which is zero: hidden, therefore unmeasurable, therefore hidden for ever;
- it drew the thumb from `scroller.scrollLeft` immediately after `render()`
  assigned that property, and an assignment on freshly inserted DOM can read
  back clamped to zero. The rail follows `scrollPpq` — the value the render is
  applying — and only the two dimensions stay measurements.

And one latent fragility fixed on the way: `element.setPointerCapture?.(id)`
guards a *missing* method, not a *throwing* one. It throws for a pointer id that
is no longer active, and the throw aborted the handler **after** the drag was
armed and **before** the move listeners were attached — a drag that could never
end. Both call sites catch it now; capture is a nicety, not the gesture.

### 12. Patch Bay — an `Align` button that does what it says — `master`

Asked 2026-09-07, done 2026-09-12. A canvas you rewire all day drifts, and the
only way back to a readable graph was dragging every node by hand.

**It is not the `automatic network layout` INTENT §6 refuses**, and the whole
design rests on the distinction: what is refused is a canvas that reorganises
itself — a graph that moves while you are reading it and takes your node out
from under the cursor. `Align` runs when it is pressed, once. The test that
matters most says exactly that: a network change plus a re-render moves nothing,
and the button does.

**What "aligned" means**, which was the half that had to be decided rather than
assembled: a column is a distance from the sources, so the controllers open the
graph and Audio Output closes it. The **longest** path places a node, not the
shortest — with `controller -> vst -> output` and `controller -> output`, the
shortest path would seat the output beside the VST and draw a cable backwards.
Within a column the current vertical order is kept: reordering rows to minimise
crossings is a better drawing and a worse command, because the point of pressing
it is to recognise your own patch afterwards. Cycles across two cable types are
reachable (they are refused per type, not globally), so the ranking is a
relaxation bounded by the node count.

**It can be taken back**, which is the other half. `Undo Align` appears next to
it once there is something to undo and holds exactly one state, never persisted,
gone when the Patch Bay is left. It is the button's counterpart and not a
history: item 13 still owns undo across the application, and the day it covers
node positions this one goes.

Two things the code settled rather than the document: `Align` also fits the view,
because otherwise the nodes go where they belong — off screen — and the command
looks broken; and it pins **every** node including those already in place, since
an unpinned node falls back to the default grid, and that grid is derived from
how many nodes there are.

`core/networkLayout.js` gained `alignPositions()`; `separateOverlaps()` and the
render path are untouched.

---

### 14. A track's MIDI input survives the session — `master`

Reported 2026-09-07, done 2026-09-12. The MIDI controller had to be picked again
in the track Input field at every launch. The application already answered this
once, correctly, and the sequencer did not reuse the answer.

**Web MIDI ids are not stable, and this machine proved it**: the same MiniLab 3
was `input-2`, then `input-0`, then `input-2` again across three sessions. A
track stored `inputId` as a bare string, so once the id moved it no longer
equalled `midi.selectedInputId`, `hasInputRoute` said no, and recording was
refused with *"The armed MIDI track Input must match the MIDI port selected
for …"*.

**One answer, not a second scheme.** `preferenceForPort` and `samePhysicalPort`
were private to `midi/midiManager.js`; they now live in
[midi/portIdentity.js](src/renderer/js/midi/portIdentity.js) with
`resolvePortPreference()`, and both the global selection and a track's input ask
that file. Two answers to "is this the same physical port" disagree the day a
port is renamed, and the disagreement surfaces as a track armed on the wrong
device.

A track carries `inputPort`, the same descriptor `midiInputPreference` has
always used, and `SequencerController` re-resolves the id from it on
`midi:preference` — later than `midi:ports`, which is what makes it the moment
the port list has settled. Three consequences worth stating:

- **an existing project keeps working**: a bare id with no descriptor is
  believed exactly once, while it still resolves, and the fingerprint is written
  back on the spot;
- **a project file travels**: a descriptor that resolves to nothing clears the
  id rather than keeping it. A stale `input-2` on another machine belongs to
  whatever that machine enumerated second, and a track quietly armed on a
  stranger's keyboard is worse than a track visibly unrouted — the rule D-029
  applies to an absent node;
- **the engine never sees the descriptor.** It is renderer bookkeeping about
  where an id came from.

---

### 15. A button that opens the site's setup section — `master`

Asked and done 2026-09-12. `Browse setups on minihub.site` sits beside
`Import a profile…` in the controller page's Profile panel — the row where a
setup already arrives is the row that says where setups come from.

**The button was the small half.** The renderer could not open a URL at all:
`shell.openExternal` appeared nowhere in `src/` and `window.hubAPI` had no
method for it. What decided the shape is what `openExternal` does — it hands a
string to the operating system's handler for that string's scheme, so a renderer
that chooses the string chooses which program Windows launches, and this
renderer is the one that displays a profile file written by a stranger (D-020).

So the renderer asks for a **named destination** and
[src/main/externalLinks.js](src/main/externalLinks.js) answers with the URL,
exactly as `directories:open` takes a purpose rather than a path. An unknown name
is refused; `https:` is re-checked even though every entry is written by hand, so
the guarantee holds of the file rather than of today's contents. Adding a
destination is one line.

Two decisions taken rather than discovered:

- **No confirmation dialog.** The label names the host instead — a click leaves
  MiniHub, and a question nobody wants asked twice is worse than a sentence read
  once. A test holds the label and the address to the same host, because a label
  naming one place while the table opens another is a lie with no failing test
  behind it.
- **The renderer spells no URL.** A test says so of the panel and of the
  controller page, which is what keeps the address list from quietly growing a
  second home.

---

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

**The order below is a numbering, not a queue.** Items are listed in the order
they were opened, and any of them can be picked up on its own. Where taking one
before another actually costs something, the item says what that costs — as a
description of what happens, so the choice can be made knowingly, never as a
prerequisite. Nothing here is waiting on permission.

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

**Two design systems coexist, and that is deliberate.** `base.css` (1,634
lines, `.panel`/`.btn` vocabulary) dresses the **shell**: header, sidebar,
Patch Bay, modals. `omni-pearl.css` (1,027 lines, `op-*` vocabulary) is a
**device-faceplate** language, meant for instrument surfaces placed inside that
shell. Both are dark since 2026-09-12 (D-037) and they are still not rivals: the
faceplate owns its own complete token set and consumes nothing from the shell,
which is exactly what let it change colour on its own. Its header documents it: a module opts in by putting the `omni-pearl`
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

~~**The arpeggiator's colours are to be redone**~~ — **done 2026-09-12**, and the
direction was the author's: the plate is **graphite**, like the MiniLab 3 it
draws. [DECISIONS.md](DECISIONS.md) D-037. A dark faceplate in a dark shell is
not camouflage as long as the plate is lighter than the shell and keeps its
bezel; what makes it read as an instrument is that the roll finally has white
keys and black keys, which is the one place the plate is allowed to be white.

What the flip cost, and it was the whole job: the sheet's own header claimed
every colour was a token, and **twenty-nine were not**. All of them were light
literals scattered through sections 2 to 4 — knob milling, key caps, the sticky
step rail, the note gloss — and each would have stayed cream on the new plate.
They are tokens now, and the header says a colour appearing below the token
block is a bug. D-012 is what made the rest a token edit: the sheet consumes
nothing from `base.css`, so the shell could not follow it down.

Seen, not read: rendered on a bench page loading the real `base.css`,
`omni-pearl.css` and `renderArpeggiatorEditor()`, at 1000 x 860.

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

**A profile can now be imported, and MiniHub runs on it — done 2026-09-05.**
[DECISIONS.md](DECISIONS.md) D-027 to D-030, plan
[plans/done/profile-import.md](plans/done/profile-import.md). This is what the
paragraph above called the next piece of work, and it turned out to be four
pieces, three of which were found by reading the code rather than the
specification.

`loadedProfile.js` resolves instead of importing: `preload.js` fetches the chosen
profile with `sendSync` — the one synchronous channel in the surface, because
`MINILAB_NODE_ID` is a module-level constant evaluated before `app.js` runs a
line — and the shipped profile is the fallback when there is nothing, when the
file is gone, or when it does not validate. Changing profile therefore reloads the
window, which is what keeps thirty-odd consumers from becoming function calls.
Imported profiles live in `userData/profiles/`; `selectedProfileFile` holds a
**name**, never a path.

Three defects found on the way, each of which would have shipped a silent failure:

- **Changing profile deleted cables.** `network.js` `restore()` dropped a
  connection whose node was absent and the next save made it permanent — and the
  controller node's id *is* the profile's id. Absent is now remembered, wrong is
  still dropped, and nothing remembered ever routes. The trap next to it:
  `serialize()` also fed the `network:change` event, so widening it would have
  handed phantom cables to the native engine. `serialize()` is what gets written,
  `connections()` is what is routing (D-029).
- **The faceplate crashed on any other keyboard.** `miniLabControlSurface.js` is
  drawn in three places — the MiniLab page, the VST Learn panel, the Patch Bay
  node — and fetched five controls by id; a profile declaring none of them threw
  a `TypeError`. It draws from `family`, `layout` and the new `printed` field
  now, and what is written on the hardware became part of the format rather than
  a MiniLab special case (D-028).
- **`layout` was still required.** D-023 made it optional in specification only,
  so a profile written without a photograph would have been refused at import.
  It is optional in the validator now, placement is all or nothing, and a profile
  with no coordinates is read as a list instead of drawn as a panel (D-030).

Mechanically: 727 JS tests, 15 `npm run check` rules. **Not yet verified with
hardware**: importing a second profile and playing through it needs a keyboard
that is not the MiniLab, or a hand-written profile for one, which is the next
thing to do with the author's own hands. What `npm test` cannot see here is the
same thing it could not see for Étape A — the real device, the real ports.

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

### 13. An edit history — undo and redo across the application

Asked 2026-09-07. `undo/redo` was out of scope; the refusal is **lifted**, with
its bounds, in [INTENT.md](INTENT.md) §8 quinquies and
[DECISIONS.md](DECISIONS.md) D-032. Read those two before writing code: what this
item must *not* undo is the part that carries the risk.

**The surface**, as asked: a control in the shell header, Back and Forward in the
application menu, and `Ctrl+Z` / `Ctrl+Shift+Z`.

**The line the history draws** — it owns **authored** state (network, tracks,
clips, notes) and never **performed** state (transport, a knob moved during a
take, a plugin's internal state, the audio device). Undo restores the network and
lets the existing `buildRoutingSync` resynchronise the engine from it; it never
sends the engine a reverse command, because a live audio callback has no inverse.

**Snapshots, not inverse operations.** D-032 settles this. `model.snapshot()` and
`normalizeSequencerState` already make the sequencer snapshot-shaped, and the
project layer already captures and restores whole state on save and load. An
inverse-operation history would instead need a correct inverse for every mutation
in `core/nodeInstances.js` (1,145 lines) and `modules/routing/routingModule.js`
(1,496 lines) — which is the reason for the ordering below.

Three things that will not be obvious later:

- **Coalescing.** A slider emits one `input` per pixel of a drag; `engineSync.js`
  already separates a topology change from a value change for exactly this
  reason. The history needs the same distinction, or one drag becomes two hundred
  undo steps.
- **The keyboard is contested.** `sequencerModule.js` binds `document` keydown
  while mounted, and the clip editor is a separate window with its own document.
  Whether `Ctrl+Z` in the clip editor undoes a note edit or the last Patch Bay
  change is a product decision, not an implementation detail.
- **A project switch ends the history.** `beginProjectTransition` /
  `finishProjectTransition` already bracket that moment; the history is cleared
  there, and never spans two projects.

**What item 12 left it** — `Align` carries a one-step, page-local undo of its
own (see Done, item 12). It is the button's counterpart, not a second history,
and the day this item covers node positions that one is deleted rather than
reconciled.

**If you take this one before item 4** — it still works, and it is worth doing.
`core/nodeInstances.js` and `modules/routing/routingModule.js` are simply the two
files where capturing the authored state is most tangled today, so the same work
costs more before the split than after it. That is a price, not a barrier.

---

## Ideas beyond consolidation

No commitment, no priority — written down so they are not forgotten.

- The `video` and `image` node types exist in the registry with empty ports;
  nothing implements them.
- The README used to list "sends, sidechains, automation, preset management,
  minimap, undo/redo, automatic network layout, node groups" as out of scope.
  **Sends, sidechains, minimap, automatic network layout and node groups remain
  so**, and INTENT §6 is the authority on that list, not this line. Three have
  moved since: **automation** was lifted 2026-09-03 as the Matrix node
  ([INTENT.md](INTENT.md) §8 bis, D-016, item 7 above), **undo/redo** was lifted
  2026-09-07 as a bounded edit history (§8 quinquies, D-032, item 13 above), and
  **preset management** was the exception from 2026-09-02 to 2026-09-03 — the
  workstream reached step 8 of 9, was withdrawn, and the refusal is upheld
  ([DECISIONS.md](DECISIONS.md) D-013).
- The ten `runtime-*-gauntlet.mjs` scripts are one-off harnesses tied to closed
  investigations. To be grouped under `scripts/gauntlets/` or removed once their
  use is confirmed obsolete.
~~Fix the four `C4996` deprecation warnings in `midi_network.cpp`~~ — **done
  2026-09-05**, its own commit and the four native binaries, 3,954 checks.
