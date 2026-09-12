# Ctrl+Z everywhere — ExecPlan

**Goal** — `Ctrl+Z` and `Ctrl+Shift+Z` undo and redo the last project edit, from
any page of the shell and from a Clip Editor window, against one linear history.
**Origin** — asked 2026-09-12 ("ctrl z et ctrl shift z globale, qui marche de
partout"). ROADMAP item 13, [DECISIONS.md](../../DECISIONS.md) D-032,
[INTENT.md](../../INTENT.md) §8 quinquies.
**Status** — in progress

## Context

**Read D-032 and INTENT §8 quinquies first.** What this must NOT undo is where
the risk is, and both texts are already written:

> the history undoes **what you authored**, never **what you performed**.

Authored: the network, the nodes and their content, the cables, the node
positions, the tracks, the clips, the notes. Performed: the transport, the
tempo, a knob turned during a take, a plugin's own internal state, the audio
device, the master fader. One linear history, no branching, no panel, no
persistence — it dies with the window, and switching project starts a new one.

The pieces that already exist and are what make this affordable:

- `core/projectKeys.js` — `PROJECT_KEYS` is the single declaration of what a
  project is made of. The history's scope is a subset of it, and the subset is
  the line D-032 draws.
- `core/settingsStore.js` — `onSet(key, value)` already fires on every write and
  is already used to mark the project dirty. That is the whole change-detection
  problem, in one seam, without touching `nodeInstances.js` or
  `routingModule.js` — the two files D-032 warns an inverse-operation history
  would have to traverse.
- `core/network.js` — `serialize()` / `restore(connections)` already round-trip
  the cables, and D-029 makes a cable whose node is absent survive until the
  node comes back.
- `core/nodeInstances.js` — `delete(id)` already tears a node down properly
  (module unregistration, engine teardown) and `createFromSnapshot()` already
  builds one back.
- `core/chainSync.js` — already rebuilds the engine's VST chains from the
  persisted model. D-032: undo restores the network and the engine is
  resynchronised from it, never sent a reverse command.
- `sequencerModel.js` — `model.snapshot()` and `normalizeSequencerState` already
  make the sequencer snapshot-shaped.

**What does NOT exist, and is the actual work**: an in-place rehydration. Every
project change today goes through `_replace()`, which stages the project in
`sessionStorage` and calls `location.reload()`. A reload per `Ctrl+Z` is absurd,
so the live objects have to be restored without navigating.

## Constraints

- **Invariant 2**: the network is the routing authority. Undo restores the
  network; the engine follows from it.
- **Invariant 4**: a node `id` is never reused. Undo brings a node back under
  the id it had — it is a restoration, not a new node.
- **Invariant 5**: `register` and `unregister` are symmetric, routing node
  included. A restore that adds and removes nodes goes through the existing
  `delete()` / `createFromSnapshot()`, never around them.
- **Invariant 6**: a project key is declared once, in `core/projectKeys.js`.
- **Invariant 8**: `unmount()` removes everything.
- A slider emits one `input` per pixel of a drag. Without coalescing, one drag
  is two hundred undo steps.
- The history is cleared by `beginProjectTransition` / `finishProjectTransition`
  and never spans two projects.
- The Clip Editor is a **separate BrowserWindow with its own document**. Its
  Ctrl+Z must reach the same history, which means an IPC hop, not a second
  history.

## Out of scope

- **Anything performed.** The transport, `transportBpm`, `masterOutput`, the
  audio device, a plugin's internal state. Also `networkViewport` and the
  sequencer's own view fields (zoom, scroll, selection, snap): undoing an edit
  must not scroll the timeline or move the canvas under the cursor.
- **Persistence.** No history on disk. D-014's other remedy — successive saved
  versions of the `.minihub` — stays the answer to the durable need.
- **Branching, a history panel, a visible tree.** One line, backwards and
  forwards.
- **A note arriving from a take.** `_acceptMidiRecording` is the boundary: the
  take is a performance, the clip it produces is authorship.
- **`Ctrl+Z` inside a plugin's own editor window.** Asked and **refused by the
  author on 2026-09-12**, so it is written here rather than left to be asked
  again.

  That window belongs to the ENGINE process -- a hand-built Win32 frame with the
  VST3 view attached as a child (D-021). When it has focus the keys go to the
  plugin and nothing reaches Chromium, so answering there means a keyboard hook
  in the engine that SWALLOWS Ctrl+Z before the plugin sees it. Most plugins
  implement their own undo on that key, and inside a plugin's window that is
  what the gesture means: undo the last thing I did *in this plugin*. Taking it
  would break a working function to offer one that undoes a cable in the Patch
  Bay.

  If the absence ever becomes a nuisance in use, the answer is a DIFFERENT
  keystroke in that window -- one no plugin claims -- never this one.

## Steps

- [x] 1. `core/editHistory.js`: the store. A snapshot is the authored keys;
      `undo()` / `redo()` move one step; a restore never records itself; the
      depth is capped.
      Check: `node --test test/editHistory.test.mjs`
- [x] 2. Capture: hook `settings.onSet` for the authored keys, coalesced on a
      quiet window so one slider drag is one step. Cleared on project
      transition.
      Check: `node --test test/editHistory.test.mjs`
- [x] 3. Apply: rehydrate in place — cables through `network.restore()`, node
      positions through `NetworkLayout`, the sequencer through its model, and
      the routing module re-rendering from the network rather than its cache.
      Check: `node --test test/editHistoryApply.test.mjs`
- [x] 4. Apply, the expensive half: `nodeInstances` as a diff — delete what the
      snapshot does not have, `createFromSnapshot` what it does, update the
      content of what stayed. The engine follows through `chainSync`.
      Check: `node --test test/editHistoryApply.test.mjs`
- [x] 5. The keyboard, in the shell: one binding that works on every page, and
      does not fight `sequencerModule`'s own `document` keydown.
      Check: `node --test test/editHistoryKeyboard.test.mjs`
- [x] 6. The keyboard, in a Clip Editor window: its Ctrl+Z crosses the IPC to
      the same history.
      Check: `node --test test/clipEditorWindows.test.cjs`
- [x] 7a. Undo / Redo in the application menu, with their accelerators shown.
      Check: `node --test test/appMenu.test.cjs`
- [ ] 7b. A control in the shell header, disabled when there is nothing to do.
      It listens to `history:changed`, which is already emitted.
      Check: `npm run check`
- [ ] 8. Documents: D-032 marked implemented, INTENT §8 quinquies, ROADMAP.
      Check: `npm test` + `npm run check` + `npm run sync:dist`

## Fallback point

`66e0d8e` — the roadmap update, everything green, `dist/` synchronised.

Steps 1 and 2 are **additive**: a history is recorded and nothing reads it. The
point of no return is step 4, the first one that destroys and rebuilds live
nodes.

## Done when

`npm test`, `npm run check`, `npm run sync:dist`. Plus what no command proves,
and what has to be SEEN in the running application:

- delete a node, `Ctrl+Z`, and it is back with its cables and its plugins;
- drag a fader through fifty values, `Ctrl+Z` once, and it is where it started;
- `Ctrl+Z` from the Clip Editor undoes the last project edit, whatever page made
  it;
- undo never moves the transport, the tempo, the master fader or the canvas.

## Log

2026-09-12 — Opened. The slot was held by `bindings-bar-docked.md`, four of
eight steps landed and committed; parked in `plans/done/` with the result
"standby" — nothing stale in it, it was parked the day it was opened.

2026-09-12 — Steps 1 to 7a landed. 891 tests, 15 check rules, `dist/` synced.

**The bound that was discovered while building, and is now written into the
code**: a node's CONTENT is not a step. Only the node SET is — which nodes
exist, of what type, under what number. A VST chain lives half in the renderer
and half in the engine as running plugin instances, so restoring one means
reconciling with the engine, which is a workstream of its own. Recording a step
the restore could not honour is worse than not recording it: `Ctrl+Z` would
claim to have undone something it had not.

What that leaves working, completely: nodes created and deleted (a deleted node
returns with its content), cables, node positions, and the whole sequencer —
tracks, clips, notes. What it leaves out: editing a VST chain, an arpeggiator
pattern, a mixer level, in place.

Two other things the code settled:

- **The present is refreshed even when nothing steps on it.** Otherwise a node
  edited and then deleted would come back with the content it had at the last
  recorded step rather than at the deletion.
- **`network.restore()` could not be reused as-is.** It is additive, which is
  right for startup and wrong for undo: putting the canvas back has to CUT a
  cable drawn since. `replaceConnections()` sits next to it.

Left: the header control (7b), and the documents (8) — D-032 and INTENT §8
quinquies still say "decided, not implemented".

2026-09-12 — **Reported from use: it worked in the Patch Bay and nowhere else.**
Two causes, both mine, both fixed.

- **The keyboard guard was `input, select, textarea`.** The Patch Bay is SVG
  with no form control in it; every other surface is built out of real ones,
  because that is what Omni Pearl draws a faceplate around. So focus sat on a
  control almost always and the guard ate the keystroke almost always. The
  browser only owns Ctrl+Z where there is TEXT to undo: `isTextEditingTarget`
  now answers for a textarea, a contenteditable and the text-like `<input>`
  types, and for nothing else. The Clip Editor window had the same over-broad
  line in front of its own history check; it uses the shared predicate now.
- **A node's content was not compared at all**, so drawing in the arpeggiator
  produced no step. The bound was too wide: it is not "content", it is a VST
  node's **plugin list** and only that — a plugin is a running native instance.
  An arpeggiator pattern, a mixer level, a control binding are parameters the
  engine is told about by the republish `engineSync` already performs, so they
  go back whole. `NodeInstanceManager.restoreContent` is what knows the
  difference, and it emits the same two signals an ordinary edit of that node
  sends.

897 tests, 15 check rules, `dist/` synced.
