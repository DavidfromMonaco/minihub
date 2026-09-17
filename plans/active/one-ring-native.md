# One Ring, made native — ExecPlan

**Goal** — One Ring runs inside MiniHub as a node of its own, with every
function of the VST: its clock in the engine, its commands through the Patch
Bay's CTRL OUT, a sequence saved by the VST opened in it without loss, and a
page of its own in a new hardware-style design.
**Origin** — [ROADMAP.md](../../ROADMAP.md) item 7, decided by the author on
2026-09-16 in place of the Matrix node, started the same day on his word:
"commence à travailler sur l'intégration de One Ring en natif". His direction
for the look: every function kept, the whole design redone after hardware
sequencers — the Korg SQ-64, the Roland P-6, the Cre8audio Programm.
**Status** — **in progress, 2026-09-17.** Steps 0 to 5 done; step 6's still drawn, waiting for the author's go.

## Context

**The source** — One Ring 0.4, kept by the author outside this repository (not
a git repository). What it is made of, all of it read before this plan was
written:

- `src/core/` — `model` (the project, its validation, MUTATE), `generative`
  (the counter-based random draws, conditions, value sources), `commands` (the
  target registry and value validation), `engine` (the scheduler, ~350 lines,
  written for the audio thread). About 1,000 lines, no JUCE.
- `src/plugin/Processor.cpp` — the clock (host tempo and position; Play starts
  it; after Stop it keeps the last tempo until its own STOP), the lock-free plan
  swap, the packet queues. `Serialization.cpp` — the saved state, JSON,
  version 1. `Editor.cpp` — every control. `Requests.cpp` — the request
  vocabulary.
- `tests/core_tests.cpp`, `README.md` (the functions, as a user reads them),
  `docs/REQUEST.md` (the original specification).

**Every function, the list this plan answers to** — nothing on it is dropped:

- 16 channels; each one: a target and a command, 4/8/16/32/64 steps, a
  resolution from 1/4 to 1/32, 1/2/3/4/8 or endless repeats, Trigger or Legato
  (Legato only for a target that declares a release), enabled, offset (in
  steps, negative wraps), swing, humanize, which fields MUTATE may change,
  Follow Actions run in order when a finite channel completes;
- each of 64 cells: active, probability, a value (fixed, a range, or a list of
  choices), conditions (first loop, last loop, every N loops, if a channel is
  active or inactive) combined with the probability, LOCK STEP and per-field
  locks;
- scenes A–D holding all 16 channels; STORE SCENE; recall Immediate or Next
  bar, Restart or Keep positions;
- a seed, NEW SEED, MUTATE (one channel or all), the mutation count saved;
- RUN and STOP of its own; per channel START, STOP, RESTART, RESET, TOGGLE,
  ENABLE, DISABLE; its own channels and scene recall usable as targets by its
  steps and Follow Actions;
- what it shows: each channel's playhead and activity, the scene, running, the
  beat and tempo, refused and guarded counts, the connection status and the
  last refusal.

**MiniHub** — ARCHITECTURE §5 (node types, the module contract), §6 *Commands
from a plugin* (the path this node reuses end to end), §7 (`Transport`,
`MidiExecutionPlan`: where a clock lives in the callback), §8 (threading), §10
(the faceplate), §11 (project state). Files: `core/commandBus.js`,
`core/commandRegistry.js`, `core/nodeCommands.js`, `core/nodeTypes.js`,
`core/nodeInstances.js`, `core/nodeEditors.js`, `core/engineSync.js`,
`core/engineClient.js`, `core/agentRequests.js`, `src/main/engineCommandPolicy.js`,
`native/audio-engine/src/engine.cpp` (`timerCallback`, `forwardControlEvents`),
`transport.h`, `midi_network.*`, `CMakeLists.txt`, `test/native_tests.cpp`.

**Decisions it comes near** — D-012 and D-037 (one faceplate, graphite), D-016
to D-018 (written for the Matrix), D-032 (a command is performance), D-042
(commands over CTRL OUT), D-043 (requests).

## Constraints

- A One Ring VST state (version 1) converts to the node's content and back
  without loss. The content keeps, per channel, a `blank` cell and only the
  cells that differ from it: the VST writes all 4 × 16 × 64 cells, about
  700 KB, which an undo step and a settings save must not carry.
- The random draws are part of that format. `mix` and `Random` are ported bit
  for bit, in C++ and in JS, and both are checked against the same fixed values.
- Invariant 2: the node commands only what its CTRL OUT is cabled to, through
  `CommandBus` — never around it.
- Invariant 3: the scheduler runs in the audio callback with no lock and no
  allocation. A new sequence is an immutable plan swapped at a block boundary,
  as the VST's `Processor` does.
- D-032: a command the node sends is performance (`hub.perform`); editing its
  sequence is authoring, one undo step.
- An offline export executes no command, as today.
- The plugin path stays whole: a plugin on a CTRL OUT cable still commands, and
  the One Ring VST still works in MiniHub.
- One faceplate (D-012): the page is built with `omni-pearl.css` and
  `ui/omniPearl.js`, extended — never a second sheet.
- Every new engine command joins `engineCommandPolicy.js`.

## Out of scope

- Changing or retiring the One Ring VST, or the CTRL OUT path for plugins.
- The Morpher: whether One Ring takes its place is not decided.
- Functions the VST does not have: commands of its own on a CTRL IN, more than
  16 channels or 4 scenes, target commands executed at sample accuracy.
- What the Matrix specification found missing: the post-chain gain stage, a
  `ctrl-in` on dynamic-input nodes, a dual live/export runtime.
- The site and the release notes.

## Steps

- [x] 0. The slot and the documents pointing at it: `bindings-bar-docked.md`
      moved to `plans/done/` on standby (step 8, its documents, is what it has
      left); this plan in `plans/active/`; TASKS.md and ROADMAP item 7 say the
      work has started.
      Check: `npm test` (1119) + `npm run check` (15 rules) — **green 2026-09-16**
- [x] 1. Native core: One Ring's `src/core/` into
      `native/audio-engine/src/one_ring/`, namespace `mlh::one_ring`, behaviour
      unchanged; `tests/core_tests.cpp` into `native_tests.cpp` as
      `[core] one-ring-*`, plus fixed `Random` values that step 3 checks again.
      Check: `npm run build:native` 0 errors 0 warnings +
      `mlh_native_tests.exe --core` (1463 checks) + `npm test` (1119) +
      `npm run sync:dist` — **green 2026-09-16**
- [x] 2. Native runtime: `OneRingRuntime` does the `Processor`'s work without a
      plugin — plan published and swapped at a block boundary; `advance` in the
      callback on the live `Transport` (Play starts it, a seek shifts its
      timeline, after Stop it keeps the last tempo until its own STOP); RUN,
      STOP, channel and scene commands in; events out through a lock-free queue
      that `timerCallback` drains as `controlEvents` carrying `nodeId` and
      `generation`; a status at the timer's pace. The content's JSON read with
      defaults for absent cells. Engine commands `syncOneRing`,
      `setOneRingTargets`, `oneRingCommand`, added to the policy. Native tests:
      a sequence on a test transport emits its events at their beats; a new plan
      keeps playback going; STOP releases a held Legato.
      Check: build 0/0 + native tests + `npm test`
      Done as `one_ring/runtime.*` and `one_ring/state_json.*`, plus
      `removeOneRing`, and `src/main/oneRingCommand.js` for the four commands'
      shape. Build 0 errors 0 warnings; `--core` (1517 checks), `--vst3-e2e`
      (99), `--cross-track-isolation` (27), `mlh_realtime_output_tests` (2535);
      `npm test` (1125); `npm run check`; `npm run sync:dist` —
      **green 2026-09-16**
- [x] 3. Renderer model, `core/oneRingRandom.js` and `core/oneRingSequence.js`
      (flat, like `arpeggiatorState.js`): defaults, the VST state to content and
      back (a sparse content, with each channel's `blank`), validation with
      `model.cpp`'s rules against the compiled targets plus One Ring's own
      channel and scene commands, `Random` in BigInt checked against step 1's
      values, MUTATE, NEW SEED, a command change and STORE SCENE as the VST's
      editor does them. MUTATE's results checked in C++ too, with the values the
      JS draws.
      Check: `npm test` + build + `--core`
      Done: `npm test` (1140, 15 new), `--core` (1523 checks, MUTATE's values
      among them), `npm run check`, `npm run sync:dist` — **green 2026-09-16**
- [x] 4. The node: type `one-ring` (MIDI category, CTRL OUT), its content the
      sequence; `engineSync` sends it on change and after an engine restart;
      `CommandBus` takes a native source beside plugin sources — targets
      published with `setOneRingTargets`, events dispatched, holds released as a
      plugin's are; a plain status panel with RUN, STOP and the four scenes.
      Tests on the control rig: a native `controlEvents` moves a cabled mixer's
      master; a pulled cable stops it.
      Check: `npm test` + `npm run check` + `npm run sync:dist` + seen in
      MiniHub: a sequence stepping a mixer's master
      Done: `npm test` (1151), `npm run check`, `npm run sync:dist` —
      **green 2026-09-17**. The engine was driven over its real stdio protocol
      (`dist`'s `mlh-audio-engine.exe`, a script speaking what the renderer
      speaks): sequence and targets taken, RUN giving a MASTER command every
      quarter beat with the cells' values, a channel STOP, STOP, a stale
      generation refused, the node removed. **Not yet seen: renderer and engine
      together in MiniHub** — it touches a project, so it moves to step 5, with
      the author.
- [x] 5. From the VST: a VST node holding One Ring offers to copy its sequence
      into a new One Ring node, and its CTRL OUT cables move to it.
      Check: `npm test` + seen in MiniHub with one of the author's sequences.
      **The author tries the native One Ring here.**
      Built 2026-09-17: `core/juceState.js` reads a plugin state as
      plugin_host.cpp writes it, `core/oneRingImport.js` copies (the live state
      when the plugin runs), a "Copy to One Ring node" button on a One Ring card
      of the VST node's page. `npm test` (1158), `--core` (1528, JUCE's base64
      and state layout among them), `npm run check`, `npm run sync:dist` — green.
      Tried by the author 2026-09-17, a node made from the OmniBox menu: it
      is there and its sequence runs — step 4's renderer and engine seen
      together. Two faults, fixed the same day (log): scenes that stopped
      answering, and a transport Stop that did not stop the node. The
      author's second try, the same day: "c'est bon". **Not seen in the
      application: the copy from a VST** — its reader is checked against the
      three real states on disk.
- [ ] 6. The design, before the page: a still of the faceplate after the
      author's references — transport and scenes, the 16 channels, the 64-cell
      grid as lit pads, the channel's settings, the cell's settings — drawn with
      the faceplate's tokens and shown to the author.
      Check: his go. **The author decides here.**
      Drawn 2026-09-17 (log): the page at the size of the arpeggiator's on the
      author's screen, with `omni-pearl.css` and a proposed section of new
      tokens and parts. **Waiting for the author's go.**
- [ ] 7. The page, playing half: channels, the grid with playheads and its four
      cell appearances, the channel's settings, RUN and STOP, RESTART CH and
      STOP CH, scenes.
      Check: `npm test` (domShim) + `npm run check` + `npm run sync:dist` + seen
- [ ] 8. The page, authoring half: the cell (active, probability, value modes,
      conditions, locks), Follow Actions, seed, NEW SEED, MUTATE, STORE SCENE,
      scene timing and position.
      Check: same as step 7
- [ ] 9. Requests: the node answers the VST's vocabulary (describe, status,
      targets, get, set, run, stop, channel, scene, copy-scene, mutate,
      new-seed) from its content, so what programmed the VST programs it.
      Check: `npm test`
- [ ] 10. Documents: a DECISIONS entry (where the clock runs, why the content is
      the VST's state made sparse, which Stop stops it), D-016 to D-018 and
      INTENT §8 bis naming One Ring, ARCHITECTURE §5, §6, §7 and §12,
      ROADMAP item 7 to Done, the TASKS
      entry removed, this plan to `done/`.
      Check: every command under *Done when*

## Fallback point

`e56f0fb` — before this workstream: everything green, `dist/` synchronised
(the sources have not changed since the 0.3.0 release). Steps 1 to 4 add a node
type and change nothing an existing project uses; step 5 is the first that
touches a project's cables, and only on the author's click.

## Done when

`npm test`, `npm run check`, `npm run sync:dist`, `npm run build:native` with 0
errors and 0 warnings, and the four native test binaries. Plus what no command
proves:

- a sequence copied from the VST, seen commanding the same targets at the same
  steps in the native node;
- the page, approved by the author.

## Log

2026-09-16 — Plan written after reading One Ring 0.4 whole: the core, the
processor, the state, the editor's controls, the requests. The core was written
for an audio thread and a registry it does not own, which is what makes a port
cheap: MiniHub already compiles the registry (`CommandBus`) and already carries
the packets (`controlEvents`). What changes is who produces them. The VST state
is kept as the reference format and made sparse for the node, since a full state
is about 700 KB.

2026-09-16 — Step 1. The core compiles in the engine and in the native tests
with no warning at /W3; One Ring built it at /W4 /WX already. A normalised diff
against the four source files shows two differences, both deliberate:
`Engine` is `Scheduler` here, since this engine already has an `Engine`, and
`Project::sceneTiming` and `scenePosition` start as Immediate and Restart
instead of indeterminate (the VST always set them itself). The fixed `Random`
values were computed with a BigInt copy of the algorithm in Node and pass in
C++ unchanged, so step 3's port has its reference already. A scheduler carries
about 250 KB of fixed event storage: the tests allocate each one rather than
stack two.

2026-09-16 — Step 2. The runtime is the VST's `Processor` without the plugin:
the same lock-free plan swap with a readers count, the same clock rules, the
same queues, the engine's `Transport` where the VST had a host playhead. Three
things were settled while building it:

- The engine checks a sequence against One Ring's own targets only. A value a
  cabled target would refuse stays authored, and the scheduler counts it as
  refused when its cell plays: the VST refused a whole saved sequence over one
  such cell, which is what made CommandBus publish targets after the state.
- `syncOneRing` says whether it restores. A restore takes the saved scene; an
  edit keeps the scene that is playing, as the VST's `project()` did.
- Each channel of the content has a `blank`: the cell every unlisted index
  holds. Choosing a command gives all 64 cells its default value, so a content
  listing the cells that differ from an empty one would list them all again.

The tests found one defect: a sparse channel with nothing programmed arrives as
an empty list, which the reader took for a truncated whole one. Fixed: an empty
list is sparse. What the tests do not reach: the four engine commands and the
timer's `controlEvents` and `oneRingStatus` are exercised only through the
runtime they wrap, not through IPC. Step 4 drives them from the renderer.
Messages: `oneRingSynced` (created, generation), `oneRingTargetsStatus`,
`oneRingCommandResult`, `oneRingRemoved`; `controlEvents` with `nodeId` and
`generation`, which CommandBus ignores until step 4 since it has no `chainId`;
`oneRingStatus` on any change, and every 100 ms while playing, kept out of the
startup log.

2026-09-16 — Step 3. `oneRingSequence.js` reads a state the way the engine
does, down to what a missing field reads as (0), so the two sides refuse the
same states; its errors name the field. Every function returns a new content.
MUTATE was the part worth proving twice: the channel in `[core]
one-ring-mutation fixed values` was mutated in JS first, and C++ drew the same
active states, probabilities, integer and float ranges and choice rotation.
`withCells` picks the blank as the cell most cells share, the empty one on a
tie, so the same cells always give the same content — an undo step compares
equal to what it restores. A VST state with two programmed cells on a typed
channel comes out more than ten times smaller.

2026-09-17 — Step 4. `core/oneRingNodes.js` (on `hub.oneRing`) keeps the
engine's runtimes in step with the nodes; CommandBus takes a native source keyed
`native<sep>nodeId`, told its targets by `setOneRingTargets`, its refusals sent
to the node's page as `oneRing:refusal` instead of a plugin window; the node's
page is a plain panel in `modules/oneRing/oneRingPanel.js` (base.css), the one
steps 6 to 8 replace. Two things the tests found:

- A renderer opened while the engine already runs never sees it start —
  `engineClient.init` learns it from a query and emits nothing, and the
  project's nodes load before that. The sequences would never have been sent.
  The device state the client then asks for is the signal, as `engineSync`
  already uses it.
- A refused packet still uses its sequence number, so the next packet needs a
  higher one — the bus's rule, which a test had wrong, not the bus.

Settled while building: a scene the engine reports is written into the
content as performance and not sent back, because a new plan releases what
Legato holds. Real One Ring states read: the three test projects on disk that
hold the VST each decode (JSON at byte 0, JUCE's private data after it), and
Orbites comes out at 55 KB for an 850 KB state, round trip exact. That reader
is step 5's.

2026-09-17 — Step 5, built. A saved plugin state is JUCE's base64 of
`copyXmlToBinary` of a `VST3PluginState` element holding each stream in JUCE's
base64 again; the One Ring component stream is its JSON, then JUCE's private
data (8 zero bytes ... `JUCEPrivateData`). The reader takes the first JSON
object that reads as a One Ring state, so a VST2-compatible header in front
would not stop it. Checked against JUCE twice: the fixture encoder's strings
are JUCE's own (`[core] juce-state`), and the three real One Ring states on
disk decode. The copy moves the VST node's CTRL OUT cables to the new node and
leaves the VST in its chain; its commands are refused from then on, as not
cabled. Not decided, and not done: placing the new node next to the VST node
in the Patch Bay, and bypassing the VST.

2026-09-17 — Step 5, the author's first trial, in a new project with a node
made from the OmniBox menu. The node is there and its sequence runs. Two
faults:

- Scenes stopped answering. The scheduler's guards against a sequence that
  restarts or recalls itself in a loop count per tick, and a tick begins only
  when the clock moves. At rest it does not, so the second scene pressed was
  refused as a loop — and so would a second press on a channel, or RUN after
  one. The VST has the same fault. A command from outside the sequence now
  begins a tick of its own (`Scheduler::beginCommand`); what it sets off is
  still guarded. Two changes on the same ground: at rest, Next bar applies a
  recall at once (there is no bar to wait for, and a pending recall fired
  wherever RUN started), and STOP plays a recall still waiting for its bar
  instead of dropping it. The status carries the waiting scene
  (`pendingScene`), and the page blinks it.
- The transport's Stop did not stop the node. The node plays on after a host
  stop, as the VST did, so that a sequence can stop the arrangement and carry
  on; the header's Stop then greyed out while the node still played. The
  author: "il faudrait que les deux fonctionnent quand elles sont activées
  manuellement". `setTransport` now takes `stopOneRings` with a stop. Every
  Stop a person gives sets it — the header, the Sequencer page, the Clip
  Editor, an agent's request — and the STOP a sequence sends to the
  Sequencer's CTRL IN does not. The header's Stop stays pressable while a node
  plays.

Checked: the new `[core]` checks fail with the fix taken out and pass with it;
`--core` (1545), `--vst3-e2e`, `--cross-track-isolation`,
`mlh_realtime_output_tests`, `npm test` (1159), `npm run check`,
`npm run sync:dist` — green, build with no warning. The real engine, driven
over stdio: four scenes pressed at rest, all taken; a Stop without the flag
leaves the node playing, one with it stops it, whether the transport ran or the
node ran alone; a Next bar recall reported waiting, played on the bar, and
played by STOP; no command refused, nothing guarded.

2026-09-17 — Step 5 done on the author's second try ("c'est bon"). Step 6: the
still, rendered from HTML that loads `base.css` and `omni-pearl.css` as they
are, plus a proposed section 5 whose new colours are all tokens (D-037). What
it takes from the references:

- From the SQ-64, a glass deck across the top: RUN and STOP as large keys, a
  display (scene, bar, tempo, running, a waiting recall, refused and guarded,
  the last refusal, one dot per playing channel), the scene keys A–D with the
  playing one lit and a waiting one ringed, STORE then a scene, the recall's
  timing and position as two levers, the seed with NEW SEED, MUTATE for the
  channel or all.
- From the SQ-64 again, the 64 cells as four rows of sixteen pads in beats of
  four. A pad's bar is lit when the cell is on, over the share of its width
  its probability gives; the playing pad glows, the selected one is ringed,
  small marks say condition, random value and locked, and the pads past the
  channel's length sit recessed.
- From the Programm and the P-6, the channel list as backlit keys with an LED
  for a playing channel and a white key for the one edited, a scribble strip
  for its target, and its whole sequence as a row of LEDs.
- Rotary selectors with their positions printed round them for LENGTH, RATE
  and REPEAT; knobs for OFFSET, SWING and HUMANIZE; a lever for Trigger and
  Legato, Legato struck out when the target has no release.
- Below the pads, the selected cell (ACTIVE, PROBABILITY, the value as Fixed,
  Range or List with the target's range beside it, the conditions as chips,
  the locks) and the channel's Follow Actions in order, with an add row.

Every function of the list in *Context* has its place on it. Not drawn: the
page with no runtime, and a choice target's value.
