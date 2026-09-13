# An agent channel — ExecPlan

**Goal** — an outside agent can build and adjust a MiniHub setup: read the
topology, create nodes and cables, load plugins, write notes, set parameters,
sound what it made, and undo itself — over a local channel that is off by
default and that changes nothing when it is off.
**Origin** — asked 2026-09-12 ("lier MiniHub à une IA à la manière de Blender").
[INTENT.md](../../INTENT.md) §8 sexies, which lifts the §6 refusal of a public
API and states the bounds this plan must not exceed.
**Status** — in progress.

## Context

**Read INTENT §8 sexies first.** The bound that shapes every step: *an operation
an agent can ask for is one the interface can already perform.* A command that
exists only for an agent is a public API by another route.

The pieces that already exist, and are what make this affordable:

- `core/sequencerController.js` — `handleClipEditorRequest()` is already a
  request bus with an outside client. Typed `kind`s (`get`, `audition`,
  `update`, `history`, `transport`), `{ ok, reason }` answers, staleness gated
  on `expectedProjectId`, refusal during a project transition. The Clip Editor
  window is the proof the shape holds across a process boundary.
- `core/editHistory.js` — `observe()` restarts a 400 ms quiet window on every
  write, so a burst of agent commands collapses into **one** undo step with no
  transaction layer. `undo()` already `flush()`es the pending window first.
- `core/network.js` — `connect()` validates port types and refuses cycles;
  `nodeInstances.js` `create()` owns id allocation. An agent cannot build an
  illegal patch, because the network refuses it — not because the channel
  checks.
- `src/main/engineCommandPolicy.js` — `ALLOWED_ENGINE_COMMANDS` already gates
  the engine. The agent never speaks to the engine; it edits the network and
  the engine follows.
- `native/audio-engine/src/vst3_scanner.cpp` — the catalogue already carries
  `category` (`"Instrument|Synth"`, `"Fx|Reverb"`) and `isInstrument`, so an
  agent sees what a plugin *is* without a curated database.

**What does NOT exist, and is the actual work**: a parameter payload an agent
can reason about (today it is a normalised 0..1 with no display string), a
request vocabulary for the network and the VST chains, and a channel in the
main process to carry requests from outside.

D-036 already anticipated this client, in a sentence written for another
reason: the audition duration is bounded on both sides *"because a payload
arriving from anywhere else must land on the same ceiling."*

## Constraints

- **Invariant 1**: no audio sample crosses the IPC. An agent reads a
  description — topology, names, parameters, notes. Never a sample.
- **Invariant 2**: the network is the routing authority. An agent edits the
  network; the engine is resynchronised from it, never commanded directly.
- **Invariant 4**: a node `id` is never reused — every creation goes through
  `nodes.create()`.
- **Invariant 5**: `register` / `unregister` stay symmetric — every removal goes
  through `nodes.delete()`.
- **Invariants 6 and 7**: project keys and system node ids come from their
  modules, never from a literal in the channel.
- **Invariant 11**: `npm run sync:dist` after every change under `src/`.
- **No runtime dependency.** `package.json` gains nothing. The MCP server lives
  outside this repository.
- **The renderer gains no socket and no disk.** The channel is owned by the main
  process; the CSP does not move.
- **D-036's ceiling** holds for an agent payload exactly as for the editor's.
- **Off by default.** With the channel off, the application is byte-identical in
  behaviour to today.

## Out of scope

Named because each one is tempting:

- **the model, and the conversation.** No API key, no chat panel, no stored
  dialogue in MiniHub. The words live in the agent's own window.
- **any analysis returned to the agent** — no spectrum, no loudness, no rendered
  excerpt. The author's ears are the loop.
- **the agent bar** (`Écouter · Garder · Annuler`). `Ctrl+Z` already works from
  every page; the bar is a convenience and it comes after the loop works.
- **restoring plugin lists in the history.** Still outside `changed()`. The
  agent removes a wrong plugin with `removeInstance`, not with undo.
- **showing the parameter display strings in the UI.** Step 1 puts them in the
  payload; the bindings bar consuming them is another workstream.
- **the Matrix calling a model.** INTENT §8 bis, still refused.

## Protocol rules — carried by the agent, not enforced by code

- **Re-read after acting; never trust a return value.** `undo()` answers `true`
  when it moved a step, which is not the same as "it undid what I just did".
- **Declare named handles.** A parameter pass returns `{ role, param, value }`
  — `brightness`, `tail`, `motion` — so "too bright" attaches to a role rather
  than re-guessing the whole parameter space, and the loop converges.
- **Never remove what it did not create** without being asked.

## Steps

- [x] 1. `plugin_host.cpp` — add the display string to each parameter in
      `parameters()`, via `IEditController::getParamStringByValue`. A
      normalised 0.42 becomes readable as `1.2 kHz`. `stepCount` came with it:
      a display reading "Saw" cannot say how many waveforms sit behind it.
      Check: `npm run build:native` (0/0) + the four native binaries + `npm test`
      + `npm run check` — **green 2026-09-12**, and measured on two real
      plugins: Dexed 2238/2238 and Massive X 2105/2105 parameters return a
      non-empty display (`MonoMode` -> "POLY", `Macro 1` -> "0.00 %").
- [x] 2. `core/agentDescribe.js` — the read side: one pure serializer turning
      the live hub into the description an agent reads (nodes, types, ordinals,
      ports, cables, tracks, clips, chains, catalogue). Parameters and notes are
      deliberately absent: they are read one plugin, one clip at a time.
      Check: `npm test` (`test/agentDescribe.test.mjs`, 8 tests) + `npm run check`
      — **green 2026-09-12**
- [x] 3. `core/agentRequests.js` — the router. It owns **no behaviour**: every
      request delegates to `hub.nodes`, `hub.network`, `hub.sequencer` or the
      existing clip-editor handler. A request needing new behaviour means that
      behaviour belongs in the module that owns it.
      Check: `npm test` (`test/agentRequests.test.mjs`, 13 tests) + `npm run check`
      — **green 2026-09-12**
- [x] 3 bis. `nodeInstances.js` — `appendPlugin()` and `removePlugin()`
      extracted from the VST panel's click handler, which was the only place
      that knew how to add or remove a plugin. Both call sites now share one
      path. Unplanned, and step 3 could not be honest without it.
      Check: `npm test` + `npm run check` — **green 2026-09-12**
- [x] 4. `src/main/agentChannel.js` — the loopback listener, its token in
      `%APPDATA%/minilab-hub/agent-endpoint.json`, and the setting that turns
      it on (`agentChannel`, default false; `MINIHUB_AGENT_CHANNEL=1` is the
      demo switch until a control writes the setting). Plus `preload.js`
      (`agent:request` / `agent:respond`, shaped like the Clip Editor bridge)
      and `core/agentBridge.js`.
      Check: `npm test` (`test/agentChannel.test.cjs`, 13 tests) + `npm run check`
      — **green 2026-09-12**
- [x] 5. `npm run sync:dist`, and the provenance test green.
      Check: `npm test` + `npm run check` — **green 2026-09-12**
- [x] 6. The client, **outside this repository**, in `../minihub-agent/`: a
      standalone zero-dependency `minihub.mjs` (`ping` · `describe` · `do` ·
      `batch`), an `AGENTS.md` Codex reads on its own, and `demo-two-track.mjs`.
      Check: **run 2026-09-12** — two VST nodes with Dexed and Analog Lab V,
      both cabled to `audio-output`, two routed tracks, a 16-note pattern and a
      4-note chord, and **`sounded: true` on both auditions**.
- [x] 7. **The vocabulary covers the work.** Asked 2026-09-12: an agent must be
      able to do everything without taking the screen. Added: `set-node-content`
      (one verb for a Mixer's levels, an Arpeggiator's pattern, a Morpher's
      steps), `move-plugin`, `set-plugin-bypass`, `open-editor` / `close-editor`,
      `set-binding` / `clear-binding`, `transport`, `set-tempo`, `set-master`,
      `project` (save / load / new), `export` / `cancel-export`, `scan-plugins`,
      `devices`. `describe` gained `audio`, because a perfectly wired setup with
      no device running is silent and every other signal reads as success.
      Check: `npm test` + `npm run check` — **green 2026-09-12** (960 tests), and
      `../minihub-agent/verify-all.mjs` + `verify-project.mjs` against the
      running application: **29 verbs, 0 failures**, including a 576 KB WAV on
      disk and a saved project loaded back with its VST chain intact.
- [x] 8. **`AGENTS.md` §7 bis** — the repository's own entry point now says the
      channel exists and that an agent must not drive the interface with
      screenshots. Without it Codex reads this repo, learns nothing about the
      door, and keeps taking the screen: the whole workstream buys nothing.
      Check: the section exists and points at `../minihub-agent/`
- [ ] 9. Still open: an MCP stdio wrapper, if Codex is to call these as tools
      rather than as shell commands. The CLI needs no configuration, so this
      buys convenience, not capability.
- [x] 10. **A plugin window stays where the person put it** (D-040). The main
      window's `focus` handler and the engine's `foregroundEditors` are gone.
      Check: `test/agentWindows.test.mjs` + live — **green 2026-09-13**:
      MiniHub restored from the taskbar reported `focused: true` and the open
      Splice window stayed behind it.
- [x] 11. **The windows an agent works in, on screen** (D-040). `show-window`
      (a page, then the window in front without the keyboard), `open-clip-editor`,
      and `describe.windows`. Check: `npm test` + live — **green 2026-09-13**:
      MiniHub rose from behind a plugin window with the keyboard left where it
      was; a Clip Editor opened and was listed.
- [x] 12. **A plugin's web page** (D-041). The engine starts with a WebView2
      DevTools port while the channel is on, `getEditorBrowsers` finds the page
      of one editor, `src/main/pluginBrowser.js` acts in it: `read`, `click`,
      `hover`, `type`, `press`, `scroll`, `screenshot`.
      Check: `npm run build:native` (0/0) + the four native binaries +
      `npm test` + `npm run check` + live on Splice INSTRUMENT 2.4.17 — **green
      2026-09-13**: the outline read its heading and buttons, and a click, a
      replace-typing, Enter, a wheel and a hover all arrived `isTrusted`.
- [x] 13. **The launch context** (D-041). `hello.nativeProcess.packageFamilyName`,
      `describe.windows.launchedInsidePackage`, and `node minihub.mjs start`
      outside the repository. Check: **run 2026-09-13** with
      `Invoke-CommandInDesktopPackage` on Codex's package, both ways.

## Fallback point

`67443c8` — master, clean, 775 tests green. Nothing before step 4 changes
behaviour with the channel absent; steps 1 to 3 are additive.

## Done when

`npm test`, `npm run check`, `npm run build:native` with 0 errors 0 warnings,
the four native test binaries, and `npm run sync:dist` — all green (AGENTS.md
§8). Plus: with the channel off, the application behaves exactly as it does
today, and a prompt describing a two-track setup produces one that sounds.

## Log

2026-09-13 — "give Codex more power": act in the web pages plugins show,
show the windows it works in, and stop a plugin window from refusing to go
behind MiniHub. Three things were only found by running, not by reading.

**The Splice login was never lost; it was filed somewhere else.** Codex Desktop
is a packaged app, and what it launches inherits its identity: every folder a
plugin created in AppData on 2026-09-12 sits in Codex's private storage, the
login tokens included. A MiniHub opened from the desktop reads the real AppData
and asks again. No MiniHub code was wrong, and none could see it -- hence the
engine reporting `packageFamilyName`, and a client `start` that goes through the
shell. The COM-activated explorer that performs the launch has no package
identity to hand on.

**`focus()` is not "in front".** With a browser in front, `show-window` built on
the existing `window:focus-main` left MiniHub behind: Windows refuses the
foreground to a process the person is not using. Restoring from the taskbar was
the one case that worked, which is how the first check passed by accident.

**The accessibility tree does not hold everything on screen.** Splice's "Don't
have an account?" is not in it at all. The outline is faithful to the tree, so
`screenshot` exists and writes CSS pixels: a point read off the image is a point
`click` accepts, whatever the screen's scaling.

2026-09-12 — "it must cover everything so it can do everything". Widening it
turned up the same shape a fourth and fifth time: "set a mixer's level", "move a
plugin in the chain" and "bypass one" existed only as lines inside the VST
panel's click handler, and the content NORMALISER existed only as a ternary
inside `load()`. That last one matters most: `load()` was the only reader of
untrusted content, so the rules for what a mixer's content may be were written
once, in the middle of a loop. An agent writing `level: "loud"` would have
reached the engine as a NaN gain — silence, with no error anywhere. It is
`normalizeContentFor()` now, and both readers share it.

Two modal traps were found by reading rather than by running, which is the only
reason they were found at all: `ProjectManager._save()` opens a native file
picker when the project has no path, and `_confirmDiscardChanges()` is a
`confirm()`. Either one raised by a request is a dialog sitting on screen
waiting for a human nobody asked. So the agent's `save` requires a path instead
of reaching the picker, and unsaved work is REFUSED rather than confirmed —
`discardUnsaved: true` is how a caller says it meant it. `exportMaster` had the
same picker and took the same treatment.

`project load` and `project new` answer BEFORE they act. Both end in
`location.reload()`, so the renderer that would send the answer is the one being
torn down; a request that waited would come back thirty seconds later as a
timeout. Verified live: `{ ok: true, reloading: true }`, then a new project id,
then the saved file loaded back with its chain.

2026-09-12 — the channel runs, and running it is what found the two defects
that mattered. Neither was visible in a test.

**`describe` listed no Audio Output.** The node list came from
`NodeInstanceManager`, which holds what the USER created; `audio-output`, the
Sequencer and the controller are routing nodes their own modules register. So
the description had nothing to plug into, and an agent reading it would build a
perfect chain and discover the hole as a cable refused against an id it had
never seen. The list now comes from `network.listNodes()` -- invariant 2, which
I had applied to the ports and not to the list they hang off -- and a node with
no instance behind it is marked `system: true`, which also answers "what is not
yours to delete".

**`set-track` reported success for a routing it had not done.** When
`ensureRoute` fails, `setTrack` rolls `outputId` back and returns the track
anyway. That is right for a form, which re-renders and shows the old value, and
silent for an agent, which reads `ok` and builds on a track that plays into
nothing. It now answers `route-refused` and carries the track as it actually is.
The underlying cause is worth writing down because it is not deducible: a MIDI
track reaches the Patch Bay through the SEQUENCER node, so that node has to
exist before a track can be routed at all. `AGENTS.md` says so.

2026-09-12 — steps 2 and 3 done, and step 3 turned up the one thing worth
recording. "Add a plugin to a chain" did not exist as an operation: it was three
lines inside the VST panel's click handler, and "remove" was four more —
including `hub.control.targetInvalidated()`, without which a CONTROL binding
outlives the plugin it points at and a physical knob silently writes nowhere.
The router copying those lines would have copied six of the seven. So they came
out into `NodeInstanceManager` and both callers share them, which is the rule
the plan states — the router owns no behaviour — enforced rather than hoped
for. `test/agentRequests.test.mjs` locks the invalidation specifically, because
it is the line a future second copy would drop again.

Also settled while writing the description: the ports an agent is told about
come from `network.getNode()`, never from `nodeTypes.js`. A Mixer grows an input
as soon as the last free one is taken, so the registry describes the node a
Mixer was born as. The test builds exactly that case.

2026-09-12 — step 1 done. The renderer needed no change: `engineClient` and
`vstParameterDiscovery` pass `res.parameters` through untouched, so the new
fields reach a caller intact. No native test was added: the deterministic test
plugins declare no parameters, and giving one a parameter changes a fixture
four suites depend on. It was verified against real plugins instead, which is
the stronger evidence — the logic under test is "does the plugin format it",
and that is the plugin's behaviour, not ours. `stepCount` is honest rather than
useful: Dexed reports 0 for `MonoMode`, which is plainly discrete. A caller
reads the display string, never the step count alone.

2026-09-12 — plan opened. INTENT §8 sexies written first: §6 refused a public
API, and nothing authorised this workstream without the lifting. Three designs
were dropped before writing anything, each because the repository already had
the mechanism: the agent was going to be denied the transport (the Clip Editor
already drives it from outside), get a new audition verb (`auditionNote` stacks
pitches, so a chord already sounds), and get a transaction layer (the history's
400 ms quiet window already collapses a burst into one step).
