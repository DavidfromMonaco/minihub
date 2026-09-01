# MiniHub Sequencer UX + Clip Editing + Quantization — Gauntlet Report

## Runtime Provenance Failure and Recovery

### Final result

**PASS — recovered and revalidated through the normal MiniHub runtime.**

The previous runtime acceptance is explicitly invalidated. Its automated feature evidence was valid for the repository source, but its isolated Electron smoke did not prove the executable, application directory, renderer, preload, CSS, or native engine used by the user's desktop shortcut. The real shortcut runtime was subsequently observed loading a stale copied application under `dist/MiniHub/resources/app` and a stale packaged native engine.

Recovery established the complete execution chain, synchronized the one normal packaged runtime, made the current Release engine part of that same promotion, added non-invasive SHA-256 runtime provenance, converged `npm start` on the desktop-shortcut executable, and repeated normal-profile plus cold-start validation. No Sequencer feature reimplementation was necessary after provenance was corrected: the intended source already contained the requested implementation.

### Previous claimed runtime versus actual user runtime

The previous report claimed an isolated-profile Electron smoke with Start/End, a dedicated Clip Editor, quantization, and a full-height arrangement. It did not record `process.execPath`, `app.getAppPath()`, `location.href`, preload identity, CSS hashes, or the native executable hash. Because the only two MiniHub application trees found were the repository source and `dist/MiniHub/resources/app`, and the latter did not contain the reported controls or Clip Editor files, that smoke necessarily exercised the current repository source rather than the user's normal packaged payload.

The actual desktop shortcut was resolved to:

`C:\Users\666di\Desktop\MiniHub.exe - Raccourci.lnk`

Target:

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe`

Before recovery, launching that exact executable with the normal user profile produced this live renderer URL:

`file:///C:/Users/666di/Desktop/LM%20Studio/Minilab%20Hub/dist/MiniHub/resources/app/src/renderer/index.html`

The live preload bridge had no Clip Editor methods, the live DOM had no `go-start` or `go-end` actions, and the empty Sequencer page measured only `960 × 300` inside a padded `1004 × 707` content area. The active CSS retained `max-height: 510px` on `.seq-scroll`. This exactly reproduced the user's observations.

### Complete execution chain

| Role | Authoritative/current location | Normal runtime location |
|---|---|---|
| Repository root | `C:\Users\666di\Desktop\LM Studio\Minilab Hub` | n/a |
| Package entry | `package.json` → `src/main/main.js` | `dist/MiniHub/resources/app/package.json` → `src/main/main.js` |
| Electron executable | `node_modules/electron/dist/electron.exe` is the pristine packaging input | `dist/MiniHub/MiniHub.exe` |
| Main process | `src/main/main.js` | `dist/MiniHub/resources/app/src/main/main.js` |
| Main preload | `src/main/preload.js` | `dist/MiniHub/resources/app/src/main/preload.js` |
| Main renderer | `src/renderer/index.html` → module `src/renderer/js/app.js` | same relative paths under `dist/MiniHub/resources/app` |
| Main CSS | `src/renderer/styles/base.css` and `omni-pearl.css` | same relative paths under `dist/MiniHub/resources/app` |
| Clip Editor main lifecycle | `src/main/clipEditorWindows.js` | same relative path under packaged app |
| Clip Editor preload | `src/main/clipEditorPreload.js` | same relative path under packaged app |
| Clip Editor renderer | `src/renderer/clip-editor.html` → `js/clipEditor.js` → `styles/clip-editor.css` | same relative paths under packaged app |
| Canonical native build | `native/audio-engine/build/Release/mlh-audio-engine.exe` | `dist/MiniHub/resources/native/mlh-audio-engine.exe` |
| App resources | `build/` contains icon resources | copied to `dist/MiniHub/resources/app/build` |
| Packaged payload | n/a | unpacked directory `dist/MiniHub/resources/app`; no MiniHub `app.asar` exists |

`src/main/main.js` uses `BrowserWindow.loadFile()` for both local HTML entries. The main window retains `contextIsolation: true`, `nodeIntegration: false`, and the existing `sandbox: false`; the Clip Editor retains the same security settings and its narrower preload. `src/main/engine.js` selects `process.resourcesPath/native/mlh-audio-engine.exe` first in the packaged runtime, then the repository Release/Debug paths only for direct source development.

Before recovery, `npm start` meant `electron .`: it loaded repository source directly and used the repository native fallback. The normal desktop shortcut loaded the separate copied payload and packaged native binary. After recovery, `npm start` performs `build:native → sync:dist → launch-dist`, and `launch-dist` starts the exact same `dist/MiniHub/MiniHub.exe` targeted by the desktop shortcut.

### Root cause and executable evidence

The cause was a development/runtime path mismatch combined with stale packaged payloads:

1. Feature work and Node tests modified/imported `src/` in the repository.
2. The prior isolated Electron acceptance exercised source code without proving the normal executable path.
3. The desktop shortcut launched `dist/MiniHub/MiniHub.exe`, whose Electron runtime loaded its own copied `resources/app` directory.
4. That copied directory had not been refreshed after the final Sequencer work.
5. The prior sync mechanism, when run manually, copied renderer source but deliberately left `resources/native/mlh-audio-engine.exe` untouched.

Pre-recovery hash/file evidence:

| Artifact | Current source/build then | User runtime before recovery | Result |
|---|---|---|---|
| `src/main/main.js` | `61813292…` | `226c5ef2…` | mismatch |
| `src/main/preload.js` | `0c26eb39…` | `80192b0f…` | mismatch |
| `src/renderer/styles/base.css` | `42e3b437…` | `dfbc6e90…` | mismatch |
| Sequencer renderer | `b2717040…` | `78018dec…` | mismatch |
| `clipEditorWindows.js` | present | absent | stale payload |
| `clipEditorPreload.js` | present | absent | stale payload |
| `clip-editor.html` | present | absent | stale payload |
| Native engine | `25488866…` | `d733abcd…` | mismatch |

The stale Sequencer renderer did contain older click selection, horizontal move, right-edge resize, and delete support, but it did not contain Start/End, clip double-click, compatible vertical movement, left-edge resize, or the dedicated editor bridge. Its stale layout used an ordinary padded content page and a fixed maximum scroller height. The user-visible failure was therefore not CSS hiding current controls or unreachable imports; those elements and files did not exist in the loaded payload.

### Duplicate builds, installations, `app.asar`, shortcuts, and stale processes

- No second MiniHub package, installed application, `app.asar`, executable under Program Files/AppData Local Programs, or competing source repository was found.
- The expected runtime copy under `dist/MiniHub/resources/app` was the stale duplicate responsible for the divergence.
- Multiple native build directories exist (`build`, `build-asan`, `build-ninja`, and prior clip-editing validation directories), but only `native/audio-engine/build/Release` is now promoted, and the packaged resolver uses only `resources/native` in normal operation.
- Electron ships `resources/default_app.asar`; it is Electron's default asset, not the MiniHub application. MiniHub loads an unpacked `resources/app` directory.
- The shortcut did not point to a second installation. It pointed to the stale `dist/MiniHub` tree inside this repository.
- No MiniHub/Electron process was alive at audit start. The app uses `requestSingleInstanceLock()`, so a hung surviving process could cause a second shortcut launch to focus the old process. Clean shutdown was verified repeatedly: the main Electron processes and native engine all exited. The repaired sync fails visibly if Windows locks a running packaged binary; it cannot silently claim a refreshed launch.

### Build and launch correction

The recovery changed only provenance/build-launch infrastructure:

- `scripts/sync-dist.mjs` now promotes current `src/`, `package.json`, build resources, and the canonical Release native engine together.
- The sync writes `dist/MiniHub/resources/app/runtime-provenance.json` with sync time, repository HEAD, dirty-worktree flag, source/target roots, and SHA-256 values for main, preloads, renderer, CSS, Sequencer, Clip Editor, and native engine.
- `src/main/diagnostics.js` now creates its user-data log directory, records the exact loaded file paths/hashes, and calculates combined/main/renderer fingerprints.
- A read-only, argument-free `diagnostics:provenance` query exposes the same evidence to the main renderer because this audit sandbox could not read `%APPDATA%\minilab-hub` directly. It exposes no arbitrary path or file operation.
- `scripts/launch-dist.mjs` launches only `dist/MiniHub/MiniHub.exe` and forwards diagnostic launch arguments.
- `package.json` now makes `npm start` build the Release native engine, synchronize the packaged payload, and launch that one normal executable.
- `test/runtimeProvenance.test.cjs` prevents regression to separate source/package launch chains or missing fingerprint coverage.

The final manifest was generated at `2026-08-23T13:04:13.230Z` from repository HEAD `601ec70976c62fda831fe7819a454035370d1f52` with a deliberately recorded dirty worktree. Every current production source hash matched its packaged counterpart after the final `npm start`.

Live normal-runtime fingerprint:

- combined: `ae4c6801ce392c0cfe3600475eb7c0d191fb7502a0ef69538757f19917b46f96`
- main: `897e7dc16ae22cf21f623dd70ec22ded82e01dfd0f3156b6f542c4b8baa51cc0`
- renderer: `6985f6f4aeb1793673f8a17a199a6350136945315b9a5784e648132d47562429`
- native engine: `25488866a4ba1e5415610e719c101a7fba2b5631ca127988fa08f4a2304412bf`

Answer to the audit question:

> Before recovery: **NO**, the files modified and tested by Codex were not the files loaded by the user's normal MiniHub runtime. The divergence occurred at the desktop shortcut's `dist/MiniHub/resources/app` and `resources/native` copies.
>
> After recovery: **YES**, the normal shortcut runtime and `npm start` both execute the synchronized current files and canonical Release native engine proven by matching hashes.

### Feature comparison after provenance recovery

No additional Sequencer product correction was required after the runtime/build relationship was fixed.

- Navigation: current renderer contained both controls and handlers; normal runtime displayed them and moved the playhead from `x=580` to `x=820` on End and back to `x=580` on Start.
- Clip manipulation: click selection, horizontal move, compatible vertical move, left/right resize, and Delete all executed in the normal runtime.
- Clip Editor: current main lifecycle, editor HTML, editor preload, canonical proxy bridge, Piano Roll, audio controls, and quantization were all present after synchronization.
- Full workspace: the exact constraint was the stale CSS/page ownership (`.content` padding, no Sequencer workspace class, auto-height page, and `.seq-scroll { max-height:510px }`). Current source already fixed the ownership chain as `body/app-body flex → content.sequencer-workspace → sequencer-page grid → seq-arrangement minmax(0,1fr) → seq-scroll height:100%`, with `ResizeObserver` cleanup.

### Automated recovery gauntlet

Recovery used **2 correction cycles**, within the maximum of 3:

1. Established provenance, synchronized packaged renderer/native payloads, added hash diagnostics, and converged the authoritative launch path.
2. Added the read-only runtime provenance query after sandbox policy prevented direct reading of the normal user-data log.

No third correction cycle was required.

Final automated results:

| Gate | Result |
|---|---:|
| Focused Sequencer, Clip Editor, project-transition, engine-safety, and provenance tests | **68/68 passed** |
| Complete JavaScript suite | **495/495 passed** |
| Release native core direct run | **1,185/1,185 checks passed** |
| Release native VST3 end-to-end direct run | **33/33 checks passed** |
| Release CTest | **2/2 passed** |
| Production/runtime JavaScript syntax checks | **passed** |
| `git diff --check` | **passed**; existing LF→CRLF warnings only |
| Authoritative `npm start` build → sync → packaged launch | **passed**, clean exit `0` |

The complete JavaScript suite includes real native MIDI recording-result ingestion, native audio take commit, project transitions, save/load, playback publication, export, routing, and security regressions. The Release build produced both `mlh_native_tests.exe` and `mlh-audio-engine.exe` before the direct and CTest runs.

### Normal runtime validation

The recovered app was launched from the exact shortcut target with the normal `%APPDATA%\minilab-hub` profile; no isolated `--user-data-dir` was used. A local debugging port was the only added argument.

1. Runtime fingerprint matched the final manifest and current source/build: **PASS**.
2. Sequencer opened after creating its required explicit Patch Bay node: **PASS**.
3. Go to Start was visible and functional: **PASS**.
4. Go to End was visible and functional: **PASS**.
5. MIDI tracks were created through the visible UI: **PASS**.
6. MIDI clips were created through the visible timeline: **PASS**. Live hardware recording could not be performed because the runtime reported no MiniLab/MIDI input and no VST/Arpeggiator destination; the complete suite's native recording-result test passed.
7. Clip selection: **PASS**.
8. Horizontal and compatible vertical movement: **PASS**. The clip moved from `left=144px` to `left=222px` and from the first to the second MIDI track ID.
9. Both resize edges: **PASS**. Right resize changed width `96px → 144px`; left resize then changed `left=222px → 246px` and width `144px → 120px`.
10. Delete: **PASS**; live clip count changed `1 → 0` using a real Delete key event.
11. Double-click opened a distinct `MIDI Clip — MiniHub Clip Editor` BrowserWindow: **PASS**.
12. Piano Roll appeared only in the MIDI Clip Editor: **PASS**.
13. Post-recording quantization controls appeared and worked: **PASS**; one note moved from `left=330px` to `left=360px` with 1/4, 100%, entire-clip quantization.
14. Closing and reopening the editor retained the canonical note and controls: **PASS**.
15. At the normal window size, content and Sequencer page both measured `1004 × 707`; arrangement height was approximately `543.67px`: **PASS**.
16. After resize, content and page both measured `864 × 607`; arrangement height was approximately `443.67px`: **PASS**.
17. Sidebar remained `220px` wide with the same Home/System/Nodes entries and styling: **PASS**.
18. Shutdown closed all Electron and native-engine processes: **PASS**.
19. Cold restart used the same executable, app path, fingerprints, and native hash: **PASS**.
20. After cold restart, a fresh explicit Sequencer node/track/clip again exposed Start/End and reopened the dedicated MIDI Clip Editor with Piano Roll and quantization: **PASS**.

Screenshots:

- `artifacts/runtime-provenance/post-recovery-sequencer-workspace.png`
- `artifacts/runtime-provenance/post-recovery-midi-clip-editor.png`

### Security and environment

- No Electron security setting changed.
- `contextIsolation`, `nodeIntegration`, sandbox state, local-content loading, CSP, IPC validation, and the narrow Clip Editor bridge remain unchanged.
- The new provenance query is read-only, accepts no caller-provided path or argument, and is not exposed to the Clip Editor.
- No OS-elevated process or application privilege was used.
- The sandbox denied direct read access to the normal `%APPDATA%\minilab-hub` log. The in-app read-only provenance query supplied equivalent non-invasive evidence, as required by the audit fallback rule.

### Final pass matrix

| Pass condition | Result |
|---|---:|
| Exact runtime provenance established | **PASS** |
| Previous source/runtime mismatch explained | **PASS** |
| Normal MiniHub launch executes intended files | **PASS** |
| Start/End visible and operational | **PASS** |
| Dedicated Clip Editor visible and operational | **PASS** |
| Clip selection/move/compatible vertical move/both resizes/delete | **PASS** |
| Canonical post-recording quantization | **PASS** |
| Sequencer fills remaining workspace and resizes | **PASS** |
| Clean shutdown and cold restart retain corrected behavior | **PASS** |
| Complete JavaScript/native/CTest regressions green | **PASS** |

**FINAL: PASS.**

## Previous milestone record (superseded runtime acceptance)

The remaining sections preserve the implementation record from the prior milestone. Their isolated-runtime acceptance and old test totals are historical and are superseded by the provenance recovery above.

## Implementation summary

### 1. Transport navigation

- Added conventional skip-to-start and skip-to-end SVG buttons with `Go to Start` / `Go to End` tooltips and accessible labels.
- Start seeks to PPQ `0` through the existing `setTransport({ seekPpq })` path.
- End seeks to `max(clip.startPpq + clip.lengthPpq)` across the canonical arrangement; an empty arrangement resolves to `0`.
- Seeking does not replace Play/Stop state in the renderer. Active playback remains governed by the existing native transport, including its recording safety behavior.

### 2. Main Sequencer clip manipulation

- Click selection stores the stable clip ID in canonical Sequencer state and updates the visual selected state.
- Selection is treated as non-musical UI state: it is persisted without rebuilding/panicking the native playback plan or invalidating editor windows.
- Horizontal drag moves clips using the existing Sequencer snap division.
- Vertical drag reassigns only between compatible tracks (`MIDI → MIDI`, `Audio → Audio`); incompatible moves fail without detaching or converting the clip.
- Both left and right resize handles are present.
- MIDI trimming uses a non-destructive source window (`sourceOffsetPpq`, `sourceLengthPpq`) and preserves stored source notes.
- Audio resizing maps between PPQ and the existing trim-second fields using the project BPM.
- Sub-threshold drags do not mutate canonical state. Pointer cancellation restores the exact pre-drag clip, including off-grid loaded values and its original track.
- Delete/Backspace removes the selected stable clip ID unless focus is in an editable control.
- All completed manipulation flows publish through `SequencerController.changed()`, so settings, native playback, save/load, export, and open editor views observe the same state.

### 3. Dedicated Clip Editor window

- Double-clicking a clip opens a real secondary Electron `BrowserWindow` using a local `clip-editor.html` document.
- Windows are keyed by stable clip ID. Reopening the same clip focuses/reuses the existing window; different IDs receive separate windows.
- The main process stores window/request lifecycle only. It never mirrors clip data. Editor `get` and `update` requests are proxied to the authoritative Sequencer controller in the main renderer.
- Editor updates carry both stable clip ID and expected project ID. Deleted clips, wrong clip types, stale projects, malformed operations, and project-transition edits fail closed.
- Project New/Load closes all clip editors before native quiesce. New editor opens remain latched off until the authoritative renderer is ready; an aborted transition safely re-enables them.
- Project replacement now waits for the exact correlated native `sequencerQuiesced` acknowledgement instead of only the main-process pipe write. The acknowledgement reports Record that raced the renderer precheck.
- Recording/audio-info events emitted during the handoff are buffered. They replay into the old project if the handoff aborts, are discarded after a committed handoff, and an audio take whose file commit was already awaiting cannot mutate a replacement project.
- Application shutdown closes secondary windows with the existing main-window lifecycle.

### 4. Piano Roll and audio clip handling

- MIDI Clip Editor contains the Piano Roll and note add, select, additive Ctrl/Cmd select, move, resize, and delete interactions.
- Piano Roll note drag uses pointer capture and cleans up on pointerup, pointercancel, window blur, and unload; cancelled/outside-window gestures do not apply stale edits.
- The main Sequencer contains only a compact MIDI clip preview; no permanent Piano Roll or inline clip editor consumes arrangement space.
- Audio clips use dedicated trim/gain controls and the existing waveform preview path. They never render a Piano Roll, and no time-stretch or unrelated audio-processing feature was added.
- Very short audio trims use the same canonical `0.125 PPQ` minimum live, in snapshots, in the native publication, and for Go to End, avoiding live/save divergence.

### 5. Offline MIDI quantization

- Timing domain: **960 integer ticks per quarter note**.
- Grids:

  | Grid | Ticks |
  |---|---:|
  | 1/4 | 960 |
  | 1/8 | 480 |
  | 1/16 | 240 |
  | 1/32 | 120 |
  | 1/8 triplet | 320 |
  | 1/16 triplet | 160 |

- The target is calculated relative to the visible MIDI source window: `lower + round((tick - lower) / gridTicks) * gridTicks`.
- Strength uses deterministic integer-tick interpolation: `round(original + (target - original) * strength / 100)`.
- `0%` is an exact no-op, including off-tick recorded values. `100%` lands exactly on the target tick.
- Scope supports selected notes and the entire visible clip. Empty selected scope safely does nothing.
- Starts-only preserves the exact canonical duration.
- Starts+ends quantizes eligible endpoints independently and enforces a positive minimum duration.
- Fully trimmed-out notes are untouched. For notes crossing a trim boundary, hidden endpoints remain untouched, so extending the clip later recovers the original hidden onset/tail.
- Pitch, velocity, channel, and unrelated note fields are preserved.
- Apply mutates the same canonical model immediately and republishes to arrangement, native playback, save/load, and export.

### 6. Full-workspace layout

- The active Sequencer removes the ordinary content padding only for its own workspace class.
- `.sequencer-page`, arrangement, and timeline scroller use the full available width and height to the right of the unchanged sidebar.
- The toolbar consumes only intrinsic height; the arrangement fills the remainder.
- Timeline overflow remains internal.
- A `ResizeObserver` rerenders virtualization/layout when the content viewport changes, with a window-resize fallback and complete unmount cleanup.
- Clip Editor windows are independent and do not resize or modal-block the main Sequencer.

Runtime measurement at the tested app size:

- content workspace: `1004 × 707`
- Sequencer page: `1004 × 707`
- arrangement height: approximately `543.67`
- timeline overflow: `auto`

## Security and IPC architecture

- `contextIsolation: true` preserved.
- `nodeIntegration: false` preserved.
- The Clip Editor matches the application's current sandbox setting (`sandbox: false`); sandboxing was not disabled relative to the existing main window.
- `webSecurity` was not disabled.
- Only local application content is loaded.
- No raw `ipcRenderer`, engine API, settings API, filesystem API, project API, `require`, or `process` is exposed to the Clip Editor.
- The secondary preload exposes exactly `get`, `update`, and `onChanged`.
- Clip IDs, project IDs, operations, payload size, ID-list element types, numeric types/ranges, and operation-specific payload shapes are validated in the main process.
- Numeric validation is non-coercive: `null`, empty strings, booleans, and numeric strings do not cross as numbers.

## Architectural decisions

- Extended the existing `SequencerModel` / `SequencerController`; no editor-owned clip copy became authoritative.
- Kept Patch Bay connections authoritative for MIDI/audio ingress and egress.
- Kept native PPQ transport and the existing frozen export transaction authoritative for playback/export.
- Added source-window fields only where required for non-destructive MIDI trim; normalization preserves older projects that lack them.
- Kept `compositionEndPpq()`'s historical four-quarter export minimum to avoid export regressions, while adding `arrangementEndPpq()` for the explicitly requested empty-End=`0` navigation behavior.
- Used a correlated native quiesce barrier and a bounded 5-second renderer wait, so a missing native acknowledgement aborts the handoff rather than staging over uncertain engine state.
- Reused the existing visual primitives, canonical note operations, timing model, audio trim fields, and waveform preview. No pre-existing Sequencer clip Piano Roll component existed to duplicate; the dedicated editor is the single clip Piano Roll implementation.

## Milestone files changed

### Electron main/preload

- `src/main/main.js`
- `src/main/preload.js`
- `src/main/clipEditorWindows.js` (new)
- `src/main/clipEditorPreload.js` (new)

### Renderer/model/UI

- `src/renderer/clip-editor.html` (new)
- `src/renderer/js/clipEditor.js` (new)
- `src/renderer/js/core/clipEditorSelection.js` (new)
- `src/renderer/js/core/engineClient.js`
- `src/renderer/js/core/projectManager.js`
- `src/renderer/js/core/sequencerController.js`
- `src/renderer/js/core/sequencerModel.js`
- `src/renderer/js/modules/sequencer/sequencerModule.js`
- `src/renderer/styles/base.css`
- `src/renderer/styles/clip-editor.css` (new)

### Native engine

- `native/audio-engine/src/engine.cpp`
- `native/audio-engine/src/sequencer.cpp`
- `native/audio-engine/test/native_tests.cpp`

### Tests

- `test/clipEditorWindows.test.cjs` (new)
- `test/sequencerClipEditing.test.mjs` (new)
- `test/sequencerUi.test.mjs`
- `test/projectManager.test.mjs`
- `test/engine.test.mjs`
- `test/nativeRealtimeSafety.test.mjs`

The repository was already a materially dirty/untracked worktree before this milestone. Unrelated pre-existing user changes were preserved and were not reset or rewritten.

## Tests added or expanded

- Start/End navigation, active-playback seek semantics, and empty arrangement End.
- Stable-ID selection, compatible/incompatible move, both resize edges, bounds, deletion, serialization, and save/load reconstruction.
- Non-destructive MIDI and audio trim invariants.
- Sub-threshold drag, completed drag, pointer cancellation, exact rollback, and single native publication.
- All six quantize grids, 0/50/100% strength, scopes, starts/starts+ends, exact duration, boundaries, idempotence, serialization, trimmed-out notes, and partially visible hidden endpoints.
- Canonical editor mutation, deleted/stale project handling, transition lock, delayed take commit, aborted-transition event replay, and short-audio canonical length.
- Same/different editor window IDs, duplicate suppression, canonical request proxy, close/invalidate/re-enable lifecycle, operation schemas, strict numeric validation, bounded payloads, and preload security.
- Dedicated MIDI/audio UI separation, absence of main-window Piano Roll, preview source offsets, ResizeObserver layout, and pointer-cancel cleanup.
- Exact native quiesce acknowledgement correlation and native late-Record reporting.
- Native non-destructive trimmed-MIDI plan compilation/playback.

## Executed gauntlet

### Phase A — baseline, before milestone edits

1. `node --test test/sequencer.test.mjs test/sequencerUi.test.mjs test/sequencerProductAcceptance.test.mjs`
   - **43/43 passed**
2. `npm test`
   - **466/466 passed**
3. Existing native build directories were inspected.
   - `native/audio-engine/build-ninja`: no registered tests
   - pre-existing ASAN CTest launch: **0/2**, both exited `0xc0000135` because the ASAN runtime DLL was not on `PATH`; this was an environment launch issue present before the milestone.

### Final targeted and regression tests

1. `node --test test\sequencerClipEditing.test.mjs test\clipEditorWindows.test.cjs test\sequencerUi.test.mjs test\projectManager.test.mjs test\engine.test.mjs test\nativeRealtimeSafety.test.mjs`
   - **66/66 passed, 0 failed**
2. `npm test`
   - **493/493 passed, 0 failed, 0 skipped, 0 cancelled**
3. JavaScript syntax gate using `node --check` over all 17 changed/new JavaScript test and production files
   - **17/17 passed**
4. `git diff --check`
   - **passed**; Git emitted only existing LF→CRLF worktree conversion warnings.

### Native Release build and CTest

1. Visual Studio 2026 x64 build:
   - `cmake --build native\audio-engine\build --config Release --target mlh_native_tests mlh_audio_engine -- /m:1`
   - **PASS**, both `mlh_native_tests.exe` and `mlh-audio-engine.exe` built.
2. `ctest --test-dir native\audio-engine\build -C Release --output-on-failure`
   - **2/2 passed**
   - `mlh_native_core_tests`: passed
   - `mlh_vst3_e2e_tests`: passed

### AddressSanitizer validation

1. RelWithDebInfo `/fsanitize=address` build of `mlh_native_tests` and `mlh_audio_engine`
   - **PASS**
2. `mlh_native_tests.exe --core` with the Visual Studio ASAN runtime directory on `PATH`
   - **1,185 checks passed**, exit `0`, no sanitizer finding
3. `mlh_native_tests.exe --vst3-e2e` with the same ASAN runtime
   - **33 checks passed**, exit `0`, no sanitizer finding

The CTest wrapper for the ASAN VST3 case times out only when CTest changes the working directory to `build-asan`; the exact same freshly built ASAN binary and VST3 case passes directly in about one second. Release CTest passes both registered tests. This is retained as a test-harness/environment limitation, not hidden as a product pass.

### Electron runtime/UI smoke

MiniHub was launched with an isolated user-data directory and Chromium remote debugging. The final smoke performed real DOM events and IPC against the running Electron app:

- created the explicit Patch Bay Sequencer singleton;
- opened the fixed Sequencer page;
- created a MIDI track and clip;
- verified Start/End controls and stable selection;
- verified the page exactly filled the content workspace and timeline scrolling remained internal;
- sent a one-pixel arrangement gesture without a canonical move;
- double-clicked the clip and observed a distinct `MIDI Clip — MiniHub Clip Editor` page target;
- added a Piano Roll note through the editor;
- cancelled an in-progress note drag with `pointercancel`;
- applied quantization and retained one canonical note;
- verified the editor exposed only `get`, `onChanged`, and `update` and that `process`/`require` were unavailable;
- verified no Piano Roll existed in the main arrangement.

Runtime screenshots:

- `artifacts/sequencer-clip-editing/sequencer-workspace.png`
- `artifacts/sequencer-clip-editing/midi-clip-editor.png`

## Gauntlet correction cycles

The bounded loop stopped at the allowed maximum of **4 correction cycles**:

1. **Builder correction:** exact starts-only duration preservation, drag commit/cleanup, initial focused-test corrections.
2. **Adversarial correction:** stale editor/project latch, operation-specific IPC schemas, 0% exact quantize no-op, selection/native-plan separation, and double-click DOM stability.
3. **Adversarial correction:** additive note selection, trimmed preview mapping, resize responsiveness, aborted-transition editor re-enable, hidden-note quantization, and short-audio live/snapshot invariant.
4. **Final adversarial correction:** sub-threshold/cancelled arrangement mutations, partially trimmed hidden endpoints, correlated native quiesce/late-Record event buffering, strict non-coercive IPC numbers, and Clip Editor pointer-cancel/blur/unload cleanup.

Every reproducible milestone defect found in these cycles received a focused regression and the affected suites were rerun. No fifth correction cycle was started.

## Final non-regression gate

The complete suite and native/runtime evidence explicitly cover:

- MIDI recording: **PASS**
- audio recording and take commit: **PASS**
- playback and native arrangement publication: **PASS**
- transport timing and seek: **PASS**
- Patch Bay-authoritative MIDI/audio routing: **PASS**
- project save/load and manipulated/quantized clip serialization: **PASS**
- deterministic frozen-snapshot export: **PASS**
- removable/re-addable Sequencer singleton with preserved arrangement: **PASS**
- New does not auto-create Sequencer: **PASS**
- New/Load/Record protections, including late Record at native quiesce: **PASS**
- VST lifecycle and export transaction protections: **PASS**
- routing/project-transition race protections: **PASS**
- stale/deleted/replaced-project Clip Editor safety: **PASS**
- security settings and narrow IPC bridge: **PASS**
- sidebar grouping and unchanged sidebar ownership: **PASS**

## Limitations and remaining issues

- No physical MiniLab 3 or real audio input device was available during the Electron smoke (`No MiniLab 3 detected`), so physical-device behavior is covered by the existing JavaScript/native protocol and routing suites rather than new live hardware input.
- Audio editing remains intentionally limited to the existing trim/gain/waveform-preview capability. No time-stretch, destructive source rewrite, or unrelated processing was added.
- Compatible vertical clip movement is supported; MIDI/audio conversion is intentionally unsupported.
- The ASAN CTest VST3 wrapper has the working-directory timeout described above. Direct execution of that exact ASAN test binary passes all 33 VST3 checks with no sanitizer report, and the ordinary Release CTest wrapper passes 2/2.
- There are **no known remaining product blockers** for the requested milestone.
