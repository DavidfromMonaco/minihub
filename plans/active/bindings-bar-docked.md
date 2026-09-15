# The bindings bar, docked under the plugin window — ExecPlan

**Goal** — Learning a knob costs one window. A frameless Electron window carrying
the bindings interface sits under the plugin editor and moves with it, and
`renderControlBindings()` is gone from the VST node's editor.
**Origin** — ROADMAP item 9, [DECISIONS.md](../../DECISIONS.md) D-021, asked
2026-09-04, started 2026-09-12, resumed 2026-09-14 on the author's word.
**Status** — **in progress, 2026-09-15.** Steps 1 to 7 landed: the bar exists,
has been seen docked under a real plugin window, learns a knob with no cable in
the Patch Bay, and its bound knobs move their parameters under the mouse. On the
author's go, the panel has left the VST node's editor: the bar is the one place a
knob is learned. A plugin too tall to leave room under it gets the bar beside it
(see the log), and the bar takes no click outside what it draws. Left: step 8,
the documents.

## Context

Read before touching anything:

- **D-021** — why this is a second window and not a strip inside the plugin
  frame, and the two alternatives that were refused. It also settles the one
  case that looks like a gap: a plugin with no editor cannot be learned today
  either, so removing the panel takes nothing away.
- **D-018** — one armed Learn with a named owner. **Decided, not implemented**,
  and it refactors `ControlBindingManager`, which is what this window drives.
  D-021 says this comes "after or with D-018, never before". It is being built
  before, on the author's instruction of 2026-09-12.
  **What that costs, named rather than discovered:** the window is a new *host*
  for an interface that already exists. If it MOVES `renderControlBindings()`
  instead of reimplementing it, D-018 later touches the same `armLearn()` it
  would have touched anyway plus this window's one call site. If it grows its
  own binding logic, D-018 is paid twice. So: move, never rewrite. Any binding
  rule that appears in the new window's own code is this plan going wrong.
- **D-040** — the window the person clicks is the one in front. The bar is
  stacked directly on its own frame and never above anything else.
- `native/audio-engine/src/plugin_host.cpp` — `EditorWindow`: the frame, its
  `STATIC` child, `reportMoved()` and `PhysicalCoordinates`.
- `native/audio-engine/src/engine.cpp` — `Engine::sendEditorBounds`.
- `src/main/bindingsBarWindows.js` — which bar exists and where it goes.
- `src/renderer/js/core/bindingsBarHost.js` — what a bar shows, drawn where the
  bindings live.
- `src/main/engineEventTrace.js` — `PERIODIC_EVENTS`, and why a stream of
  geometry must be in it.
- ARCHITECTURE §4 (IPC), §7 and §8 (the engine, real time), §10 (UI, CSP).

## Constraints

- **Invariant 1**: no audio sample crosses the IPC. Geometry and markup only.
- **Invariant 3**: the audio thread never blocks. The window proc is the message
  thread, not the audio callback, but nothing added there may allocate per
  message or call into the IPC synchronously.
- **Invariant 8**: `unmount()` removes everything. A window that closes must
  drop its subscriptions.
- **Invariant 9**: the bar sets `innerHTML` from markup built by
  `renderControlBindings()`, which escapes where it builds. The bar page adds
  nothing to it.
- **Invariant 10**: no inline styles. The new page loads `base.css` and uses its
  vocabulary — not the faceplate. AGENTS §6: the shell is never given one.
- **Invariant 11**: `dist/` must match `src/`.
- A drag emits a report per frame. It is a periodic event and must be treated
  like `masterMeter`: coalesced before it leaves the engine, and absent from the
  disk log.
- `src/main/engineCommandPolicy.js` is an allow-list. Any new command enters it.
  (None was needed: the bar is placed from events, never by a command.)
- The plugin editor is owned by the engine process and can be closed, moved to
  another monitor, minimised, or die with its plugin. The bar answers to the
  last known state, never to an assumption that the editor is there.

## Out of scope

- **D-018 itself.** No Learn arbiter, no per-instance arming. This plan moves an
  interface; the one change to what it asks of `ControlBindingManager` is the
  author's of 2026-09-14 — Learn plugs its own cable (step 6 bis). Consequence,
  unchanged from the panel: with two editors of the SAME node open, Arm Learning
  is refused (`multiple-plugin-editors-open`) and the bar shows nothing about it.
- **Drawing more than one keyboard's surface.** `renderControlBindings` draws
  one faceplate per cabled keyboard since 2026-09-05; the bar gives each one a
  column. Nothing more.
- Anything about the plugin editor's own contents. It stays the engine's Win32
  frame with a VST3 view attached.
- **The panel's help sentence.** It said MiniHub "opens and foregrounds the
  target OmniBox", which the bar made untrue. Visible text, so the author's to
  change: he asked for it to be rewritten on 2026-09-15 (see the log).

## Steps

- [x] 1. Native: `EditorWindow` reports where it is. Position accessors, plus
      `WM_MOVE` / `WM_EXITSIZEMOVE` in `handleMessage`, coalesced so a drag
      cannot flood the IPC.
      Check: `npm run build:native` **0 errors 0 warnings**
- [x] 1 bis. Native, 2026-09-14: what step 1 reported was not enough to dock
      against (see the log). The report is now the frame's VISIBLE edge (DWM
      extended frame bounds) in physical pixels, with `clientY`, `minimized`,
      `raised` and `windowHandle`; `WM_WINDOWPOSCHANGED` is the one source; a
      report the throttle drops is sent by a timer once the period is over.
      Check: `npm run build:native` 0/0 + the four binaries — **green
      2026-09-14** (1351 + 97 + 27 + 2535 checks)
- [x] 2. Native: the engine emits the geometry as its own message type,
      separate from `editorStatus` — open/close is rare and worth a log line,
      geometry is periodic and is not.
      Check: `npm run build:native` + `native/audio-engine/build/Release/mlh_native_tests.exe --core`
- [x] 3. Main: the new type joins `PERIODIC_EVENTS` so it never reaches the
      disk, and the renderer receives it.
      Check: `node --test test/engineEventTrace.test.cjs`
- [x] 4. Renderer: `engineClient` carries the geometry to whoever asks.
      Check: `node --test test/pluginEditor.test.mjs`
- [x] 5. Main: `src/main/bindingsBarWindows.js` and `bindingsBarPreload.js` —
      one frameless, non-focusable bar per open editor, placed in main from the
      engine's events, stacked on its frame with `moveAbove`, closed with its
      editor, its plugin instance, the engine and the main window.
      Check: `node --test test/bindingsBarWindows.test.cjs` — **green
      2026-09-14** (11 tests)
- [x] 6. Renderer: `bindings-bar.html` and `js/bindingsBar.js` (draws markup,
      reports clicks), `core/bindingsBarHost.js` (draws each bar with
      `renderControlBindings()` and carries its clicks out),
      `core/controlBindingActions.js` (one reading of a click, shared with the
      VST node editor), `ui/surfaceLayout.js` (split out so the page loads no
      profile), the strip in `base.css`, and `_focusHub()` removed from the
      manager.
      Check: `npm test` (1030) + `npm run check` (15 rules) + `npm run sync:dist`
      + seen live — **green 2026-09-14**
- [x] 6 bis. Learn needs no cable (asked 2026-09-14): `armLearn` refuses only a
      control with no socket; the capture plugs the cable the binding needs, in
      the same history step; Clear unplugs it. The panel draws every keyboard on
      the desk in loading order, greys nothing out, and a binding whose cable was
      pulled out is drawn `unplugged`.
      Check: `npm test` (1038) + `npm run check` + `npm run sync:dist` + live —
      **green 2026-09-14**
- [x] 6 ter. Knobs that move (asked 2026-09-14): in the bar, a knob, fader or
      strip bound to a parameter shows where it stands and a vertical mouse drag
      moves it, through `route()`; the plugin moving it under its own mouse, or
      the keyboard turning it, moves the drawing. `core/controlValues.js`, a
      `bindings-bar:values` channel apart from the markup, and `parameterIds` on
      the engine's parameter read.
      Check: `npm run build:native` 0/0 + the four binaries + `npm test` (1047) +
      `npm run check` + `npm run sync:dist` + live — **green 2026-09-14**
- [x] 7. The panel leaves the VST node's editor. This is the step that makes it
      one place instead of two. Given the go by the author on 2026-09-15.
      `renderControlBindings()` moved, unchanged, into
      `core/controlBindingsPanel.js`; the node editor lost the panel, its
      subscription, its selection and its click branches.
      Check: `npm test` (1046) + `npm run check` (15 rules) + `npm run sync:dist`
      + seen live — **green 2026-09-15**
- [ ] 8. Documents: D-021 marked implemented with what was settled while
      building (its "Proof in the code" still names `nodeInstances.js` for
      `renderControlBindings()`), ROADMAP item 9 to Done, ARCHITECTURE §4 and
      §10 (its `core/` table lists none of the bar's files).
      Check: `npm test` + `npm run check` + `npm run sync:dist`

## Fallback point

`55ae103` — before this workstream resumed: everything green, `dist/`
synchronised.

Steps 1 to 6 are **additive**: the bar is a second place to learn a knob, and the
VST node's editor still has the first. The point of no return is **step 7**, when
the panel leaves the VST node's editor: before it, the docked window is an
addition; after it, it is the only way to reach a binding.

`ddc4ce1` — the last commit with the panel still in the VST node's editor.
Step 7 is one commit on top of it and reverts on its own.

## Done when

`npm test`, `npm run check`, `npm run sync:dist`, `npm run build:native` with 0
errors and 0 warnings, and the four native test binaries. Plus the two this
workstream cannot prove mechanically, and which D-021 lists as settled while
building rather than in advance:

- the bar **seen** following a plugin editor across a drag, a resize, a
  minimise and a close — **seen 2026-09-14**, except a drag by hand (moves were
  made with `SetWindowPos`);
- its stacking against a plugin window that is itself always-on-top, and its
  behaviour when the editor sits at the very bottom of the screen — the second
  **seen 2026-09-14**; the first not met (see the log).

## Log

2026-09-15 — The bar loses its invisible borders, on the author's word: "fix the
invisible clicks". `thickFrame: false` on the bar's window, and Electron gives the
frameless window no caption style (0x14000000 where the bar had 0x14C00000), so
Windows has no border to add around it. The first test of
`test/bindingsBarWindows.test.cjs` checks the option and fails without it --
tried. Checks: `npm test` (1059), `npm run check` (15 rules), `npm run sync:dist`.

Seen on two probe windows built with the bar's options and the same bounds: with
the thick frame, the window (292, 300)-(708, 508) around a client area
(300, 300) 400 x 200; without it, window and client area both (300, 600)
400 x 200. **Not seen in MiniHub itself**: another application was in front, and
opening a plugin window takes the foreground from it.

2026-09-15 — The bar stands beside a plugin that leaves no room under it. The
author, testing Learn with Analog Lab V: the mouse could not reach the plugin's
controls, "because the controller window is in front".

- **What it was.** Analog Lab V's view is 1280 x 886, its frame 918 px tall, and
  the author's screen 1080 px with the taskbar hidden. 918 + 182 is more than
  1080, so at every position the rule settled on 2026-09-14 -- stop at the bottom
  of the work area and ride over the plugin -- put the bar over Analog Lab's
  keyboard and the row of knobs above it, stacked above the frame and taking the
  clicks. The startup log agreed: in the 42 s Learn was armed on Analog Lab, the
  plugin reported no parameter touched.
- **The rule now** (`placeBar`, `besideFrame`): under the frame when the work area
  has room for it there; otherwise a column beside the frame and as tall as it, on
  the right, or on the left when that is where the room is. 456 DIPs wide, and
  narrower down to 300 when neither side has 456, the page scaling the faceplate
  to fit (`--bar-zoom`). Over the plugin, as before, only when neither side has
  300. Analog Lab V on 1920 px always leaves 319 on one side.
- **The page reads its layout from its own window**: taller than wide is a column
  (`@media (orientation: portrait)` in `base.css`), and main never makes a column
  shorter than 480 nor wider than 456, so no message has to say which layout is
  on. The toolbar's "Select a control on the left", the author's wording of the
  same day, is true only in the strip: both "on the left" and "above" are in the
  markup, and the stylesheet shows the true one.

Checks: `npm test` (1059), `npm run check` (15 rules), `npm run sync:dist`. Four
tests in `test/bindingsBarWindows.test.cjs` fail against the previous placement
-- tried; the words are locked to the stylesheet in `test/bindingsBarHost.test.mjs`.

Seen live, in an untitled project made for it (Analog Lab V in VST 1, Dexed in
VST 2), the frame moved with `SetWindowPos` and the bar's client area read back:
with the frame's visible edge at x 267, the column at (1549, 155) 371 x 918,
against a frame ending at 1549, drawn with the faceplate scaled down, the help,
and "Select a control above"; at x 107, (1389, 155) 456 x 918; at x 600,
(144, 155) 456 x 918 on the left; with the frame pushed up to y -30, the strip at
(107, 888) 1282 x 182. In that strip the author then learned F1 onto Analog
Lab V's Reverb Volume -- "it works" -- and the channel showed the cable the
capture plugged, `minilab-3` `control-f1` to `vst-001` `ctrl-in`. **Not seen with
its contents**: the 456-wide column, right or left. A full-screen window in front
of MiniHub stopped Chromium repainting it, and those captures came out empty.

Found while checking, not changed yet: the bar's window is 8 px larger than what
it draws, on its left, right and bottom -- the invisible frame borders Windows
gives a window with a caption, which Electron keeps on a frameless one unless
`thickFrame: false` -- and the bar answers `HTCLIENT` there. Under the plugin
those pixels lie outside the frame; in a column they lie over the plugin's edge
and take its clicks. A probe window with `thickFrame: false` has a window
rectangle equal to its client area.

2026-09-15 — The Learn toolbar's text with nothing selected, asked by the
author. "Choose an observable physical control above" was written for the VST
node's page, where the faceplate sat above the toolbar; in the bar the faceplate
is on the left, and the line was cut to "Choose an o…". It reads "on the left"
now, after the bold "Select a control". Seen live under Dexed, whole.

2026-09-15 — Ctrl+Z and bindings, fixed on the author's word, with the drawing
of a binding whose plugin is not running. Both had been found the same day.

- **A restore is not a copy.** `restoreContent()` and `restoreInstance()` now
  take a snapshot's content exactly (`restoredContentFor()`), where they went
  through `cloneContentFor()`, which is Duplicate's and Paste's. An undo keeps
  every VST node's bindings; an undone Clear brings its binding back; a deleted
  VST node comes back with its plugins under their own instance ids and its
  bindings.
- **A binding is restored only while its plugin is in the chain.**
  `_writeContent()` drops one naming a plugin removed since the snapshot. The
  plugin list is not the history's to restore, so that binding could never work
  again. Its cable, part of the network, does come back with the snapshot.
- **A VST node brought back plays again.** Deleting it took its plugins out of
  the engine, and nothing created them before the next engine start. The
  restore emits `nodes:restored`, and `chainSync` creates that node's plugins
  the way its rebuild does, state and bypass restored on READY.
- **Only a binding that routes is drawn mapped.** One whose plugin is loading,
  failed to load or is gone is `inactive`, dashed like `unplugged`.
- Suspected and ruled out by a probe: the MIDI gate of a restored node. The
  restore adds the node before its cables, so the routing sync closes then reopens
  the gate by itself.

Six tests: four in `test/controlRouting.test.mjs`, one in
`test/pluginEditor.test.mjs`, one in `test/bindingsBarHost.test.mjs`. Five fail
against the previous code. The sixth -- no binding of a removed plugin comes back
-- passed there only because every binding went; it fails without the filter.

Seen live, in an untitled project discarded after, through the channel: K1 bound
to Dexed and K3 to kHs Gain (which fails to load), both cabled. A Mixer created
and undone left both bindings and both cables. VST 1 deleted and undone came back
with `plugin-1` Dexed and `plugin-2` kHs Gain, both bindings and both cables;
the engine read 2,238 parameters from Dexed and its window opened. Under it, the
bar drew K1 solid with its value mark, and K3 dashed.

2026-09-15 — Two follow-ups of the removal, asked by the author the same day.

- **Removing a plugin frees its knobs.** A node none of whose plugins can open a
  window had nowhere left to show or clear its bindings. The three ways to get
  there are not one case. A plugin removed from its chain leaves an instance id
  that is never given out again, so its bindings could never work again:
  `ControlBindingManager.releasePlugin()` clears each of them the way Clear does,
  cable included, from `NodeInstanceManager.removePlugin()` -- the Remove button
  and the channel's `remove-plugin` alike. A plugin that failed to load or is
  missing from this machine stays in its chain, and so do its bindings, which
  work again the day it loads; removing it is what frees them. Both rules are in
  `test/controlRouting.test.mjs`, and the first fails without the call.
- **The help sentence**, rewritten: "Click a control on {keyboard}, press Arm
  Learning, then move the plugin parameter it should control."

Seen live, in an untitled project discarded after: Dexed and kHs Gain in VST 1,
K1 bound to Dexed and K3 to kHs Gain through the channel, both cabled. The bar
under Dexed showed the new sentence, with K1 and K3 drawn bound. `remove-plugin`
on Dexed left K3's binding and cable and nothing of K1's; `remove-plugin` on kHs
Gain then left the node with no binding and no cable.

Found while doing it, not changed:

- **Every Ctrl+Z empties the bindings of every VST node**, cables left behind.
  `restoreContent()` and `restoreInstance()` copy a VST node's content through
  `duplicateVstContent()`, which drops bindings and renumbers plugins -- right for
  Duplicate, wrong for a restore. Undoing a node's deletion brings its plugins
  back under new ids with no bindings. Probed outside the suite: one binding,
  then a Mixer created and undone, left no binding. A save after that makes the
  loss permanent. Whoever fixes it must also keep a restore from bringing back a
  binding whose plugin has since been removed.
- **A binding whose plugin failed to load is drawn as mapped**: K3 was green
  under Dexed while kHs Gain was in error.
- **kHs Gain would not load**: "setProcessing(true) failed", as kHs Filter and
  kHs Reverb on 2026-09-12. The engine accepts only `kResultOk`/`kResultTrue`
  from that call; JUCE also accepts `kNotImplemented`. Which code Kilohearts
  returns is not verified.

2026-09-15 — The panel leaves the VST node's editor. The author: "the next step
removes the old panel from the VST node's editor."

- **What the page lost**: the "Control Bindings" panel, its
  `control:bindingsChanged` subscription, the selection it kept, the Learn and
  "Not your keyboard?" branches of its click handler, and the surface layout run
  after every paint, which no other node editor needs. `nodeInstances.js` is 118
  lines shorter.
- **`renderControlBindings()` moved, not rewritten**, into
  `core/controlBindingsPanel.js`, byte for byte (diffed against `ddc4ce1`). Left
  in `nodeInstances.js`, it would have been the one thing there no node instance
  uses, and the bar host would have kept importing the node manager to draw a
  panel.
- **The tests that locked the panel in the page now lock its absence.**
  `test/controlRouting.test.mjs` mounts the VST editor and finds no faceplate, no
  Learn toolbar, no "Not your keyboard?", and a click shaped like the old Arm
  Learning arms nothing. `test/bindingsBarHost.test.mjs` reads the renderer's
  sources: only the bar host imports the panel and its actions, and
  `hub.control.armLearn(` is written once. Both fail against `ddc4ce1`'s
  `nodeInstances.js` -- tried. `test/profileImport.test.mjs` lost the test that
  read the node editor's source for the controller page id: the bar host's test
  already opens that page by its page id, which is not the node id. 1047 tests
  become 1046.

Seen live, with Dexed in an untitled project discarded after: VST 1's page shows
its plugin chain and Delete Node, and nothing else; Dexed's window, opened
through the channel, came up with its bar under it -- the faceplate, the help,
"Not your keyboard?" and the Learn toolbar, drawn by the moved function. **Not
exercised live**: a click in the bar. That path did not change and is in
`test/bindingsBarHost.test.mjs`.

Found while doing it, not changed:

- **A node none of whose plugins can open a window** -- removed, missing, failed
  to load -- keeps its bindings with nowhere left to see or clear them. They do
  nothing; a new Learn on the same knob replaces one, and the channel's
  `clear-binding` removes one. D-021 settled learning such a plugin, not
  clearing it; the page's panel was the way to do that until today.
- The help sentence is now drawn only in the bar, where it is untrue. Still the
  author's to change.

2026-09-14 — Knobs that move. The author: "when you move a control of the
controller's panel [with the mouse], it moves the one it is linked to in the
plugin, and the other way round." Agreed before building: what turns or slides
moves (knobs, the main encoder, faders, strips), pads do not; only a working
binding moves anything; the drawing follows what the plugin reports under its
own mouse, which is exactly what Learn can capture.

- **A drag goes through `route()`**, the knob's own road: binding, cable,
  plugin. So an unplugged binding moves nothing from the bar either, and no
  binding rule appears in the bar or its host.
- **Positions travel apart from the markup** (`bindings-bar:values`). A redraw
  at the rate a knob turns would replace the element under the dragging mouse;
  the bar also holds back a redraw until the mouse lets go.
- **Three sources of a position**, in `core/controlValues.js`: `route()` saying
  what it wrote (`control:routed` -- the engine does not echo a host write), the
  plugin's touches (`engine:vstParameterTouched`, 30 per second at most while
  its window is open), and a read back from the engine when a bar opens, when
  the bound set changes, and when the plugin's state changes (a preset loaded
  in it reports no parameter). Every write is numbered and a read never
  overwrites a later write.
- **The read is narrowed.** `getVstParameters` takes an optional `parameterIds`
  now; without it, each read of eight knobs bound to Dexed formatted 2,238
  display strings. The validation moved out of `main.js` into
  `vstParameterCommand.js`, beside the other parameter command, and is tested.
- **The drag**: 160 px sweeps a knob end to end; a fader or strip follows the
  mouse along its own track. Under 3 px it is still a click, and selects the
  control for Learn. One message per frame.

Seen live with Dexed, in an untitled project discarded after, with drags posted
to the bar window: K1 bound to Cutoff went 0 → 0.25 for 40 px up and → 0.15 for
16 px down; with the bar closed, Cutoff set to 0.6 and the bar reopened, 16 px up
gave 0.7 — the bar had read 0.6; Cutoff changed to 0.3 behind MiniHub's back,
and after the plugin's state event 16 px up gave 0.4; F1 bound to Resonance went
0 → 0.42 for 20 px, its cap drawn at the bottom before and part way up after,
K1's mark pointing at 11 o'clock for 0.4. **Not seen**: the plugin moving the
drawn knob, and the keyboard moving it — both need a hand, on the plugin or on
the MiniLab; both are in `test/bindingsBarHost.test.mjs`.

2026-09-14 — Learn stops asking for a cable. The author, before trying the bar:
"make the step where the controls are cabled in the Patch Bay optional — open a
VST window, arm and learn a control from there."

What that met: a knob reaches a plugin only by a CTRL IN cable. The controller
node emits CONTROL into its cables and nowhere else, so a binding learned with no
cable reads as learned and does nothing. Two ways out were put to him in those
words: route bound knobs around the network, which leaves a Patch Bay that no
longer shows what drives what and cables that stop nothing when pulled out; or
let Learn plug the cable. He chose the second, with the cable plugged at the
capture rather than at the arming.

- **Plugged at the capture.** A Learn cancelled, superseded or ended by a closed
  editor leaves nothing. Plugged before the binding is written, so both are one
  history step: `test/controlRouting.test.mjs` undoes a capture and finds
  neither.
- **Clear unplugs it.** A CONTROL cable with no binding carries a knob to
  nothing. Only when a binding was actually cleared: a hand-placed cable with no
  binding is not Clear's to remove.
- **Every keyboard is drawn, in loading order.** The panel drew only cabled
  keyboards, and neither of two when none was cabled. Following the cables now
  would hide the keyboard the person is about to learn from, and reorder the
  faceplates the moment a capture plugs one. Three tests in
  `test/twoControllers.test.mjs` locked the old drawing and were rewritten.
- **`unavailable` is gone; `unplugged` replaces it** for a binding whose cable
  was pulled out by hand. The binding stays (it is the person's work), does
  nothing, and is drawn with a dashed ring rather than as working.
- **Refused**: arming a control with no socket on any loaded keyboard
  (`unknown-source`), and a capture whose cable the network refuses
  (`cable-refused`), which ends the Learn without a binding.

Seen live with Dexed, in an untitled project discarded after: nothing cabled,
every knob drawn at full strength; K2 selected and armed from the bar with no
cable; Cancel left no cable; Clear on a cabled binding (set through the channel)
removed the binding and its cable and left the other binding alone. **Not seen**:
the capture plugging a cable. A mouse drag posted to Dexed's JUCE window did not
move its knob, and a real one takes the person's mouse, which is refused. The
capture is covered by the tests only.

Found while checking, not fixed, not this plan's: the agent channel's
`set-binding` writes the binding straight to the node, so it plugs no cable, and
emits nothing, so an open bar or panel does not redraw until something else
changes.

2026-09-14 — Resumed. Steps 5 and 6 landed, and so did a second native pass: the
plan said nothing had gone stale, and read against the code before writing
anything, five things had — or had never been right.

**What steps 1 and 2 reported could not be docked against.** Four gaps, each
one visible on screen:

- `GetWindowRect` includes Windows 10/11's invisible resize borders, seven
  pixels left, right and below. A bar docked against it hung a gap under the
  frame and ran fourteen pixels wider. The report is DWM's extended frame
  bounds now, the edge a person sees. Measured live: bar client area
  (107, 746) 868 x 182 under a frame whose visible edge was (107, 40)–(975, 746).
- nothing said the frame was minimised, and a minimised frame reports
  (-32000, -32000): the bar would have been pulled back onto the screen by the
  rule that keeps it visible;
- the throttle dropped reports, and only a drag ends in `WM_EXITSIZEMOVE` to
  force the last one. A snap or a move from the keyboard left the bar where a
  dropped report would have moved it. Now a timer sends the frame as it stands.
  Seen: a move then a resize, which Dexed answered by resizing its own window
  again, left the bar at the frame's final rect. Whether the timer or an
  unthrottled report delivered it, the run cannot tell;
- nothing said the frame had been restacked, so a plugin window clicked back in
  front of MiniHub left its bar underneath.

The coordinates also had to become explicitly physical pixels
(`PhysicalCoordinates`): Electron is per-monitor DPI aware, and at 100 % — the
author's screen — scaled and physical are the same numbers, so a missing
conversion would pass every check here and misplace the bar on a laptop at
150 %. Main converts with `screen.screenToDipRect`. Tested at 150 % in
`test/bindingsBarWindows.test.cjs`; **not seen on a scaled screen**.

**Step 6 could not be built as written.** "A page hosting
`renderControlBindings()` verbatim" assumed the page could call it. A second
window is a second JavaScript world, and the bindings, the armed Learn and the
cables exist only in the main window's renderer. So that renderer draws each bar
with the same function and main carries the markup across; a click comes back as
a typed action (`select`, `learn`, `cancel`, `clear`, `open-controller`),
validated in main and addressed by the bar that sent it, never by a node it
names. The click is read and carried out by `core/controlBindingActions.js`,
which the VST node editor now uses as well — so the only binding logic that
exists is still the one that existed. `window.open` into a same-origin child
was weighed and refused: it hangs on whether two `file://` documents may script
each other, which nothing in this repository settles.

**Learn brought MiniHub's window forward after every capture and every cancel**
(`_focusHub()`). That was the panel's design — Learn was armed in MiniHub, so
the person had to come back to it — and against the bar it covers the very pair
the person is working in. Removed; `test/controlRouting.test.mjs` locked the old
behaviour and now locks the new one. It is also what D-040 already says.

**The panel is about 350 px tall, and the author's screen has 187 px to spare.**
On 1920 x 1080 at 100 %, Splice INSTRUMENT's frame is about 893 px tall. The bar
is a strip of 182 px: one column per faceplate, drawn at its designed 520 px and
scaled .82 as a whole — given less width instead, knobs and labels kept their
pixel sizes and ran into each other, tried in a mock-up first — then one column
with the help above the Learn toolbar.

Settled while building, as D-021 asked, and to be written into it at step 8:

- **Bottom of the screen**: the bar stops at the bottom of the work area and
  rides over the bottom of the plugin rather than leaving the screen, and never
  climbs over the caption the pair is dragged back up by. Seen with Dexed
  resized past the bottom edge.
- **Stacking**: directly above its own frame (`moveAbove`), never always-on-top.
  A window put over the plugin covers the bar too; the frame raised again takes
  the bar with it. Seen: MiniHub over both, then `open-editor` — the path Arm
  Learning takes — raised the frame and the bar came back on top.
- **Minimised**: hidden with the frame, shown and restacked with it. Seen.
- **A plugin window that is itself always-on-top**: not met. The frame is
  MiniHub's own `WS_OVERLAPPEDWINDOW` and never topmost; a plugin that makes its
  root window topmost would leave the bar underneath it, and nothing handles
  that.
- **Focus**: the bar is not focusable. A click in it never takes the keyboard
  from the plugin, so arming Learn there and turning a knob in the plugin never
  flicks the frame to inactive. Keyboard shortcuts, `Ctrl+Z` included, do not
  reach the bar.

Seen live on 2026-09-14, with Dexed in an untitled project created for the test
and discarded after: the bar opening docked, following a move, a resize, a
minimise and a restore, closing with `close-editor` and with the frame's own
close; a click posted to the bar selecting K1, Arm Learning arming it (the knob
ringed, "Cancel Learning" shown), Cancel disarming it, and MiniHub's window never
coming forward. **Not seen**: a capture, which needs a gesture in the plugin's
own interface; two editors open at once; a drag by hand.

2026-09-12 — Opened. The slot was held by `two-controllers-at-once.md`, which had
all eight steps ticked since 2026-09-05; it moved to `plans/done/` with the
result "standby" and what had gone stale in it.

2026-09-12 — Steps 1 to 4 landed. Native: 0 errors 0 warnings on a **forced**
recompile of `plugin_host.cpp` and `engine.cpp`, and the four binaries green
(1318 + 83 + 27 + 2535 checks). JS: 853 tests, 15 check rules, `dist/` synced.

Three things the code decided that the plan had left open:

- **The rect is the OUTER frame, and needed its own four numbers.**
  `editorStatus.width/height` are the CLIENT area — the size handed to the VST3
  view — so docking against them would have been off by the borders and title
  bar. `editorFrameX/Y/Width/Height` sit beside them rather than replacing them.
- **`editorBounds` is emitted on open too**, not only on move. Otherwise the bar
  has nothing to line up with at the one moment it must already be in place.
- **The throttle lives in the window proc**, at 60 Hz, with `WM_EXITSIZEMOVE`
  forcing a final report. `Ipc::send` writes to stdout under a lock, so an
  unthrottled report would put a synchronous write on the thread drawing the
  plugin, once per frame of a drag.
