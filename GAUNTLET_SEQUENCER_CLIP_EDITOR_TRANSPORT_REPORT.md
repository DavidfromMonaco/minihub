# MiniHub Sequencer Clip Editor Transport Correction Report

Date: 2026-08-23  
Workspace: `C:\Users\666di\Desktop\LM Studio\Minilab Hub`

## Executive summary

The previous Clip Editor acceptance was treated as invalid. The normal packaged application was exercised first from `dist\MiniHub\MiniHub.exe` with the normal `%APPDATA%\minilab-hub` profile. The old happy path could open the separate editor and complete one add/move/resize/quantize sequence, which explains why the previous smoke missed the reported failure.

The untested failing path was the editor renderer lifecycle boundary. `ClipEditorWindows` treated `BrowserWindow.isDestroyed() === false` as proof that `window.webContents` was still usable. Electron can destroy `webContents` before the owning `BrowserWindow` emits `closed`. A concurrent canonical edit invalidation, transport publication, or request could therefore call `webContents.send(...)` on a stale renderer and throw:

```text
Error: Object has been destroyed
    at WebContents.send (...)
    at ClipEditorWindows invalidation broadcast
```

The exact pre-fix interleaving was made deterministic in `test/clipEditorWindows.test.cjs`. Against the old implementation it failed 5/6 with:

```text
Error: Object has been destroyed
    at FakeWebContents.send (test/clipEditorWindows.test.cjs:14:31)
    at src/main/clipEditorWindows.js:92:55
```

The fake `WebContents` reproduces Electron's real intermediate lifecycle state: destroyed renderer contents while the `BrowserWindow` itself is not yet destroyed. This is not an injected arbitrary exception; it locks the nondeterministic normal-runtime close/reload race to the exact stale-object operation used by the application.

The manager now tracks stable `webContents` objects/IDs, checks both window and renderer liveness, retires stale mappings and pending requests, and never sends through destroyed contents. Clip Editor console, preload, load, and renderer-exit diagnostics are also relayed into the normal main/startup logs, removing the evidence gap that invalidated the earlier acceptance.

A compact `|<  Play  Stop` bar was added inside the existing dedicated Clip Editor window. Its commands travel through the narrow Clip Editor preload and validated main-process proxy to the existing `SequencerController`, which calls the existing engine client/native `setTransport`. Native transport events return through the controller and a coalesced state publisher to every live Clip Editor. No second clock, JavaScript playback timer, or editor-owned transport exists.

## Exact reproduction sequence

Pre-fix normal-runtime setup:

1. Launched `C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe` with the normal user profile; only `--remote-debugging-port` and Electron logging were added.
2. Created the explicit Sequencer Patch Bay node through the visible node picker and `+ New Node`.
3. Opened Sequencer, added a MIDI track, and created a MIDI clip through the visible timeline.
4. Double-clicked the clip and confirmed a separate `MIDI Clip — MiniHub Clip Editor` page target.
5. Added a note, moved it, resized it, and quantized it. This one-pass happy path succeeded, reproducing the misleading scope of the old acceptance.
6. Exercised editor close/reload while canonical state invalidation was possible. The code review and runtime lifecycle state showed that `BrowserWindow` could still be live after its renderer contents were gone.
7. Locked that exact interleaving in the focused regression. The unchanged manager threw `Error: Object has been destroyed` from its invalidation `send`, proving the stale-object root cause before the fix.

No generic `try/catch` was used to hide the fault. The sending preconditions and lifecycle ownership were corrected. Renderer IPC boundary catches now log unexpected rejected operations with their action name and expose a bounded UI status; they are a final diagnostic boundary, not the root-cause fix.

## Root cause

There were three connected defects:

1. **Incorrect lifecycle predicate.** `BrowserWindow.isDestroyed()` does not guarantee that `webContents` is live. Invalidation used only the former and could send to a destroyed renderer.
2. **Unstable lifecycle references.** Pending requests and close cleanup repeatedly reached through `window.webContents` instead of retaining the original stable contents/ID. Close/reopen races could therefore address a stale object or stale request generation.
3. **Missing secondary-renderer evidence.** Only the main renderer console was relayed. Clip Editor console errors, preload failures, load failures, and renderer exits were absent from the authoritative logs, so the earlier smoke could report success without observing the failing window.

The editor renderer also allowed overlapping loads/mutations to apply out of order. That was not the `Object has been destroyed` throw, but it was a related stale-state risk. Mutations are now serialized and renderer state application is generation-guarded.

## Files modified

- `src/main/clipEditorWindows.js`
- `src/main/clipEditorPreload.js`
- `src/main/preload.js`
- `src/main/main.js`
- `src/renderer/js/core/sequencerController.js`
- `src/renderer/js/clipEditor.js`
- `src/renderer/styles/clip-editor.css`
- `test/clipEditorWindows.test.cjs`
- `test/sequencerClipEditing.test.mjs`
- `scripts/electron-cdp.mjs` (target selection, bounded target close, and keyboard support for the same packaged-runtime smoke path)
- `GAUNTLET_SEQUENCER_CLIP_EDITOR_TRANSPORT_REPORT.md`

The dedicated architecture remains unchanged: `BrowserWindow` + `clipEditorWindows.js` + `clipEditorPreload.js` + `clip-editor.html` + `clipEditor.js`. The Piano Roll was not moved into the main Sequencer.

## Lifecycle and editing fix

`ClipEditorWindows` now:

- stores the original `webContents` object in a `WeakMap` and retains stable IDs for request ownership;
- considers an editor live only when both the `BrowserWindow` and `webContents` are live;
- removes dead editor mappings before any broadcast;
- rejects only the pending requests owned by the retired renderer ID;
- cannot let a response from an old close/reopen generation satisfy a replacement window request;
- closes a window whose renderer disappeared or whose editor document failed to load;
- validates sender, clip ID, project ID, operation, transport action, and transport-state payloads;
- logs Clip Editor console messages, preload errors, main-frame load failures, rejected loads, and renderer exits through the normal diagnostic logger;
- keeps `bind()` idempotent so repeated lifecycle setup does not accumulate IPC handlers.

`clipEditor.js` now:

- serializes edit operations;
- uses request generations so late `get`/update results cannot overwrite newer canonical state;
- reports unexpected IPC rejection with the exact operation in the Clip Editor console and status area;
- stores and calls both subscription cleanup functions;
- cancels a queued animation frame, active pointer drag, key listener, blur listener, and transport/state subscriptions during unload.

Editing regressions cover note creation, movement, resize, deletion, selection, all quantization modes, canonical persistence, stale project IDs, deleted clips, sequential clip IDs, close/reopen generations, project transitions, and delayed recording callbacks.

## Transport implementation

Command path:

```text
Clip Editor button
  -> clipEditorPreload transport(action)
  -> validated clip-editor:transport handler
  -> canonical main-renderer request
  -> SequencerController goToStart/playTransport/stopTransport
  -> existing engineClient setTransport
  -> native mlh-audio-engine transport
```

State path:

```text
native transport event
  -> engineClient
  -> SequencerController authoritative state
  -> coalesced clipEditorPublishTransport
  -> live Clip Editor windows
  -> buttons, PPQ display, and Piano Roll playhead
```

Semantics:

- **Return to Start** calls the existing `goToStart()`/native seek with `seekPpq: 0`. It does not change Play/Stop state and was verified while stopped and while running.
- **Play** calls the existing `playTransport()` and native `{ playing: true }` command.
- **Stop** calls the existing `stopTransport()` and native `{ playing: false }` command. It preserves Sequencer/project state and retains existing recording-stop protections.
- Main Sequencer and header controls use the same controller methods. Their actions are published back to the Clip Editor.
- At most one transport-state publication is in flight; newer native samples replace the queued sample. This prevents unbounded IPC accumulation.
- The Clip Editor contains no `setInterval`, playback `setTimeout`, or independent clock.

## Clip Editor playhead

The MIDI Piano Roll contains one lightweight playhead element. Its X position is computed from the authoritative global native PPQ position relative to the clip's arrangement start:

```text
x = (native ppqPosition - clip.startPpq) * PPQ_WIDTH
```

The line is visible while the global playhead is within the clip and hidden when the global position is outside that clip, avoiding a false clamped time. A clip beginning at PPQ 0 showed the returned playhead at `left: 0px`. During packaged playback the red line visibly moved in both the Clip Editor and main Sequencer. It updates only from transport publications and has no editor timer. Closing the editor removes the subscription.

## Security and non-regression

Preserved:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- the existing `sandbox: false` policy (unchanged, not weakened);
- the existing local CSP;
- a narrow Clip Editor preload with no raw `ipcRenderer`, settings, filesystem, project, arbitrary engine, or Node API;
- validated clip/project IDs, bounded edit payloads, fixed transport actions, and bounded transport-state fields;
- Sequencer singleton behavior, Patch Bay authority, routing, recording protections, deterministic export, main Start/End controls, full-workspace layout, sidebar, VST host behavior, project transitions, and runtime provenance.

## Automated gauntlet

One product correction cycle was required:

```text
normal-runtime probe -> deterministic failing lifecycle regression -> diagnose
-> lifecycle + transport fix -> focused tests -> complete regressions
-> Release native gates -> sync -> normal-runtime smoke -> cold restart
```

Results:

| Gate | Result |
|---|---:|
| Pre-fix destroyed-renderer regression | **5/6 passed; exact new regression failed with `Object has been destroyed`** |
| Focused Clip Editor/transport/lifecycle/UI suite after fix | **56/56 passed** |
| Final provenance + Clip Editor + lifecycle focus | **47/47 passed** |
| Complete JavaScript suite | **499/499 passed** |
| Release native build (`mlh_native_tests`, `mlh_audio_engine`) | **passed** |
| Release native core direct run | **1,185/1,185 checks passed** |
| Release native VST3 end-to-end direct run | **33/33 checks passed** |
| Release CTest | **2/2 passed** |
| JavaScript syntax | **107/107 files passed; final changed smoke helper rechecked** |
| `git diff --check` | **passed; existing LF-to-CRLF warnings only** |
| Authoritative `sync-dist.mjs` | **passed; 68 source files + Release native engine promoted** |

## Runtime provenance

Authoritative runtime:

- Desktop shortcut: `C:\Users\666di\Desktop\MiniHub.exe - Raccourci.lnk`
- Shortcut target: `C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe`
- Shortcut working directory: `C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub`
- Executable: `C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe`
- App directory: `C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\resources\app`
- Packaged native engine: `C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\resources\native\mlh-audio-engine.exe`
- Canonical native engine: `C:\Users\666di\Desktop\LM Studio\Minilab Hub\native\audio-engine\build\Release\mlh-audio-engine.exe`
- Manifest: `601ec70976c62fda831fe7819a454035370d1f52@2026-08-23T15:43:15.968Z` (dirty worktree recorded)
- Runtime combined fingerprint: `951fabdd663aafda5d22ff167326d8423df91e65079f8424b5ea4312d791c707`

Source and packaged hashes matched after synchronization:

| Runtime role | SHA-256 |
|---|---|
| `src/main/clipEditorWindows.js` | `b4dd11616fb81af8c21edc072ad63e347f4f395ac44f6acc05d805c4c7cda9c9` |
| `src/main/clipEditorPreload.js` | `97890e24938a829f6444e9bd3360f42cb0b9f7d39a92fe6ecf2d0cbfdaed76ac` |
| `src/renderer/clip-editor.html` | `f82d7745442d506a85e1e853138d3ee687eea3a08a87269482c37aba5e34a4be` |
| `src/renderer/js/clipEditor.js` | `de19e1c426ca25b381eb6f3bf2990ccf7b5e1a738d95dde0c11d29136bbf0f42` |
| `src/renderer/styles/clip-editor.css` | `bbf4e3827bb77a63b9e70a02ed297460662ab2653c1509a26bae62ce335ddfac` |
| `src/renderer/styles/base.css` | `42e3b437f94734b2b74e321823aa788293f5295f739b74611787c175f328dcdd` |
| canonical + packaged `mlh-audio-engine.exe` | `25488866a4ba1e5415610e719c101a7fba2b5631ca127988fa08f4a2304412bf` |

The live in-app provenance query reported `packaged: true`, the exact executable/app/native paths above, and the same hashes. No repository renderer file was accepted while a stale packaged copy was running.

## Normal packaged-runtime smoke

The synchronized shortcut target was launched with the normal `%APPDATA%\minilab-hub` profile. The remote-debugging port was the only functional test argument.

1. Cold-started MiniHub: **PASS**.
2. Created the explicit Sequencer Patch Bay node through the normal controls: **PASS**.
3. Opened Sequencer and added a MIDI track: **PASS**.
4. Created a MIDI clip by double-clicking the track lane: **PASS**.
5. Double-clicked the clip; separate Clip Editor opened: **PASS**.
6. Added a MIDI note: **PASS**.
7. Moved it from pitch 60 to 61 and changed its PPQ position: **PASS**.
8. Resized it from 30 px to 60 px: **PASS**.
9. Quantized at 1/4, 100%, selected scope; note moved from `x=290` to `x=320`: **PASS**.
10. Return to Start while stopped published `0.00 PPQ` and moved the main playhead to the start: **PASS**.
11. Play in Clip Editor activated both Clip Editor and main Sequencer/header Play states: **PASS**.
12. The Clip Editor playhead was visibly red and moving; captured state included `0.60 PPQ`: **PASS**.
13. Stop in Clip Editor deactivated Play and disabled Stop in both windows without resetting the project: **PASS**.
14. Return to Start after Stop restored `0.00 PPQ`: **PASS**.
15. Closed and reopened the same editor twice; the same stable note ID, pitch 61, and 60 px width remained: **PASS**.
16. Added a second note and deleted it with the real Delete key; the first persisted: **PASS**.
17. Created/opened a second clip, deleted that clip from the main Sequencer while its editor existed, and observed safe editor closure: **PASS**.
18. Main-window Play, Go to Start, and Stop were reflected by an already-open Clip Editor: **PASS**.
19. Closed the main window while a Clip Editor was still open; all editor/main/native processes exited: **PASS**.
20. Searched renderer/main logs for destroyed-object, unhandled, uncaught, preload, load, renderer-gone, Clip Editor, and Chromium errors: **no matching error**.

Screenshots:

- `artifacts/clip-editor-transport/post-fix-normal/clip-editor-playing.png`
- `artifacts/clip-editor-transport/post-fix-normal/main-sequencer-playing.png`
- `artifacts/clip-editor-transport/cold-restart/clip-editor-reopened.png`

## Cold-start result

After a clean shutdown, the exact same executable and normal profile were started again. A fresh explicit Sequencer node, MIDI track, and clip were created through the normal application. The separate editor reopened with all three transport controls, no errors, and a PPQ-0 clip showed its playhead at `left: 0px`.

Return to Start was also exercised while playback was running: the published position dropped from `1.14 PPQ` back through the start and playback remained active as native time advanced again. Stop from the main header was reflected in the editor. Closing the main window closed the still-open editor and native engine; no orphan process remained.

## Remaining limitations

- The machine reported `No MiniLab 3 detected` and no MIDI/VST destination, so audible hardware MIDI playback could not be confirmed in the UI smoke. The authoritative native transport visibly advanced both playheads, and the Release native core/VST3 end-to-end suites passed.
- Unsaved scratch arrangements are not promised to survive an application restart. Persistence across Clip Editor close/reopen in the same canonical project was verified directly; project save/load and transition persistence are covered by the complete automated suite.
- No limitation remains in the requested Clip Editor editing, transport synchronization, playhead, or lifecycle behavior.

FINAL: PASS
