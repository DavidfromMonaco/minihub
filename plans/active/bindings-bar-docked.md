# The bindings bar, docked under the plugin window — ExecPlan

**Goal** — Learning a knob costs one window. A frameless Electron window carrying
the bindings interface sits under the plugin editor and moves with it, and
`renderControlBindings()` is gone from the VST node's editor.
**Origin** — ROADMAP item 9, [DECISIONS.md](../../DECISIONS.md) D-021, asked
2026-09-04, started 2026-09-12, resumed 2026-09-14 on the author's word.
**Status** — **in progress, 2026-09-14.** Steps 1 to 6 landed: the bar exists and
has been seen docked under a real plugin window. **Waiting on the author**, and on
purpose: he tries Learn from the bar on his own plugins before step 7 takes the
panel out of the VST node's editor, which is the point of no return.

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
  interface; it does not change what that interface asks of
  `ControlBindingManager`. Consequence, unchanged from the panel: with two
  editors of the SAME node open, Arm Learning is refused
  (`multiple-plugin-editors-open`) and the bar shows nothing about it.
- **Drawing more than one keyboard's surface.** `renderControlBindings` draws
  one faceplate per cabled keyboard since 2026-09-05; the bar gives each one a
  column. Nothing more.
- Anything about the plugin editor's own contents. It stays the engine's Win32
  frame with a VST3 view attached.
- **The panel's help sentence.** It still says MiniHub "opens and foregrounds
  the target OmniBox", which the bar makes untrue. It is visible text, so it is
  the author's to change, not this plan's.

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
- [ ] 7. The panel leaves the VST node's editor. This is the step that makes it
      one place instead of two. **Waits for the author's go**, after he has
      learned knobs from the bar on his own plugins.
      Check: `npm test`
- [ ] 8. Documents: D-021 marked implemented with what was settled while
      building, ROADMAP item 9 to Done, ARCHITECTURE §4 and §10.
      Check: `npm test` + `npm run check` + `npm run sync:dist`

## Fallback point

`55ae103` — before this workstream resumed: everything green, `dist/`
synchronised.

Steps 1 to 6 are **additive**: the bar is a second place to learn a knob, and the
VST node's editor still has the first. The point of no return is **step 7**, when
the panel leaves the VST node's editor: before it, the docked window is an
addition; after it, it is the only way to reach a binding.

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
