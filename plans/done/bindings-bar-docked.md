# The bindings bar, docked under the plugin window — ExecPlan

**Goal** — Learning a knob costs one window. A frameless Electron window carrying
the bindings interface sits under the plugin editor and moves with it, and
`renderControlBindings()` is gone from the VST node's editor.
**Origin** — ROADMAP item 9, [DECISIONS.md](../../DECISIONS.md) D-021, asked
2026-09-04, started 2026-09-12.
**Status** — **standby, 2026-09-12.** Four of eight steps landed and committed
(`9b38c1e`). Waiting on nothing technical: the author asked for the edit history
first, and PLANS.md §2 holds the single slot for the work in progress.

**Nothing has gone stale yet** — it was parked the same day it was opened. The
part to re-read before resuming is the D-018 note in *Context*: the window must
MOVE `renderControlBindings()`, never reimplement it, or that decision's refactor
is paid twice. Steps 1 to 4 are additive and already in `master`, so resuming
costs nothing beyond step 5.

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
- `native/audio-engine/src/plugin_host.cpp` — `EditorWindow`, the
  `CreateWindowExW` frame and its `STATIC` child.
- `native/audio-engine/src/engine.cpp` — `Engine::sendEditorStatus`, the payload
  that carries `width` and `height` and no position.
- `src/main/clipEditorWindows.js` — the precedent for a second window:
  dependency-injected `BrowserWindow`, so a test can drive it without Electron.
- `src/main/engineEventTrace.js` — `PERIODIC_EVENTS`, and why a stream of
  geometry must be in it.
- ARCHITECTURE §4 (IPC), §7 and §8 (the engine, real time), §10 (UI, CSP).

## Constraints

- **Invariant 1**: no audio sample crosses the IPC. Geometry only.
- **Invariant 3**: the audio thread never blocks. The window proc is the message
  thread, not the audio callback, but nothing added there may allocate per
  message or call into the IPC synchronously.
- **Invariant 8**: `unmount()` removes everything. A window that closes must
  drop its subscriptions.
- **Invariant 10**: no inline styles. The new page loads `base.css` and uses its
  vocabulary — not the faceplate. AGENTS §6: the shell is never given one.
- **Invariant 11**: `dist/` must match `src/`.
- A drag emits `WM_MOVE` continuously. It is a periodic event and must be
  treated like `masterMeter`: coalesced before it leaves the engine, and absent
  from the disk log.
- `src/main/engineCommandPolicy.js` is an allow-list. Any new command enters it.
- The plugin editor is owned by the engine process and can be closed, moved to
  another monitor, minimised, or die with its plugin. The bar answers to the
  last known state, never to an assumption that the editor is there.

## Out of scope

- **D-018 itself.** No Learn arbiter, no per-instance arming. This plan moves an
  interface; it does not change what that interface asks of
  `ControlBindingManager`.
- **Drawing more than one keyboard's surface.** `renderControlBindings` draws
  the first controller's panel for N controllers today — a known limitation,
  recorded in `plans/done/two-controllers-at-once.md`. It travels to the new
  window unchanged.
- Anything about the plugin editor's own contents. It stays the engine's Win32
  frame with a VST3 view attached.

## Steps

- [x] 1. Native: `EditorWindow` reports where it is. Position accessors, plus
      `WM_MOVE` / `WM_EXITSIZEMOVE` in `handleMessage`, coalesced so a drag
      cannot flood the IPC.
      Check: `npm run build:native` **0 errors 0 warnings**
- [x] 2. Native: the engine emits the geometry as its own message type,
      separate from `editorStatus` — open/close is rare and worth a log line,
      geometry is periodic and is not.
      Check: `npm run build:native` + `native/audio-engine/build/Release/mlh_native_tests.exe --core`
- [x] 3. Main: the new type joins `PERIODIC_EVENTS` so it never reaches the
      disk, and the renderer receives it.
      Check: `node --test test/engineEventTrace.test.cjs`
- [x] 4. Renderer: `engineClient` carries the geometry to whoever asks.
      Check: `node --test test/pluginEditor.test.mjs`
- [ ] 5. Main: `src/main/bindingsWindow.js` — a frameless window, injected
      `BrowserWindow`, that follows a rect it is told about and hides when the
      editor it belongs to closes.
      Check: `node --test test/bindingsWindow.test.cjs`
- [ ] 6. Renderer: `src/renderer/bindings.html` and its module, hosting
      `renderControlBindings()` verbatim.
      Check: `npm run check` + `node --test test/bindingsPage.test.mjs`
- [ ] 7. The panel leaves the VST node's editor. This is the step that makes it
      one place instead of two.
      Check: `npm test`
- [ ] 8. Documents: D-021 marked implemented, ROADMAP item 9 to Done,
      ARCHITECTURE §4 and §10.
      Check: `npm test` + `npm run check` + `npm run sync:dist`

## Fallback point

`b1224e6` — four workstreams closed, everything green, `dist/` synchronised.

Steps 1 to 4 are **additive**: the engine says more than it did, nothing reads it
yet, and the application behaves exactly as before. Abandoned there, nothing has
to be undone. The point of no return is **step 7**, when the panel leaves the VST
node's editor: before it, the docked window is an addition; after it, it is the
only way to reach a binding.

## Done when

`npm test`, `npm run check`, `npm run sync:dist`, `npm run build:native` with 0
errors and 0 warnings, and the four native test binaries. Plus the two this
workstream cannot prove mechanically, and which D-021 lists as settled while
building rather than in advance:

- the bar **seen** following a plugin editor across a drag, a resize, a
  minimise and a close;
- its stacking against a plugin window that is itself always-on-top, and its
  behaviour when the editor sits at the very bottom of the screen.

## Log

2026-09-12 — Opened. The slot was held by `two-controllers-at-once.md`, which had
all eight steps ticked since 2026-09-05 and waits on a second keyboard; it moved
to `plans/done/` with the result "standby" and what had gone stale in it.

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

Steps 5 to 8 are untouched: the window, the page, the removal, the documents.
