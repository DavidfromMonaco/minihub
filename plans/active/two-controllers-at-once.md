# Two controllers at once — ExecPlan

**Goal** — A MiniLab 3 and a BeatStep are both loaded, both play, and both appear
in the Patch Bay at the same time. Choosing a keyboard stops being a choice.
**Origin** — asked on 2026-09-05, after a BeatStep profile built with the site
Builder was loaded: "si j'ai un minilab 3 et un beat step, je veux pouvoir switch
dans la même session, voire même utiliser les deux en même temps".
**Status** — every step landed 2026-09-05: `npm test` 762/762, `npm run check`
15 rules, `npm run sync:dist` exit 0. Step 3 split in two when it was measured
against the code; see the entry below.

**Not yet seen running.** Everything below is proved by tests, and the
application has not been launched with two profiles loaded since. The plan's own
working note says a symptom is fixed when it has been SEEN fixed; that pass has
not happened, and neither has a commit.

## Working note — read this before step 1

The session that opened this plan went badly, and not because the code was hard.
Three times "the node is fixed" was announced when one cause out of four had been
treated, and the author was left relaunching the application to discover it
himself. His instruction for the next session, in his own words: don't do
anything stupid and take your time.

Concretely, on this workstream:

- **Verify, then announce.** A visual symptom is fixed when it has been SEEN
  fixed — a bench page or the running app — never on the strength of having read
  the code. AGENTS.md §8 already says it; it was ignored.
- **Cut by symptom, not by file.** List every cause of a symptom before touching
  one of them, and say "one of the N causes" until they are all done.
- **`npm run sync:dist` fails while the app is open** (a locked DLL). Check the
  exit code, not the last line, or the application keeps running the old code and
  the next hour is spent debugging a build that was never installed.
- The steps below are ordered so that each one is provable on its own. If the
  time runs short, stop at a step boundary rather than half-finishing two.

## Context

The device-agnostic half is already done and is what makes this affordable:

- `midi/decodeControl.js` and `midi/portRoles.js` take **a profile as an
  argument** — they never import one. Nothing there has to change.
- Identities are already prefixed by profile: a node id **is** a `profileId`, a
  control source is `<profileId>:<controlId>`, a port is `control-<controlId>`
  inside its own node. `minilab-3:k1` and `arturia-beatstep:k1` cannot collide.
- [DECISIONS.md](../../DECISIONS.md) D-029: a cable whose node is absent is kept,
  written back out, and reconnected the day its node arrives. That is exactly the
  behaviour needed when only one of the two keyboards is on the desk.
- ARCHITECTURE §4 (IPC), §6 (network), §10 (UI). D-020 (profiles are data),
  D-025 (a profile is identified by the hardware it describes).

What assumes a single controller, and nothing else does — measured 2026-09-05,
five call sites in five files:

| File | What it does with `MINILAB_NODE_ID` | What it needs |
|---|---|---|
| `core/controlBindings.js` (×3) | `connection.from.nodeId !== MINILAB_NODE_ID` | membership in the set of controller nodes |
| `core/controlRouting.js` | `emitData(MINILAB_NODE_ID, …)` | the node of the profile that decoded |
| `core/midiRouting.js` (×2) | `emitData(MINILAB_NODE_ID, 'midi-out', msg)` | the node whose port received it |
| `midi/minilabControls.js` | `sourceNodeId: MINILAB_NODE_ID` | the source's own profile |
| `modules/minilab/minilabModule.js` | registers one node and one page | one of each per loaded profile |

Plus two singletons outside that list:

- `midi/midiManager.js` — `selectedInputId`, one armed port.
- `main/controllerProfiles.js` — `selectedProfileFile`, one chosen file, carried
  across renderer writes by `carrySelectedProfile`.

## Constraints

- `MINILAB_NODE_ID` is a **published identity**: it is in every saved project's
  cables and in every learned binding key. A loaded profile keeps its own id as
  its node id — no renaming, no prefixing, no migration of saved projects.
- Invariant 7: a system node identifier comes from `core/systemNodes.js`, never
  from a literal. That file stops exporting one constant and starts answering a
  question; it does not stop being the single source.
- Invariant 5: `register` and `unregister` stay symmetric, per profile.
- Invariant 2: the network remains the routing authority. Two controllers means
  two source nodes, not a page that decides which one is live.
- `preload.js` must still put the profiles on the page **before** the module
  graph evaluates (`midi/loadedProfile.js` explains why); the handover becomes a
  list, it does not become asynchronous.
- A project saved with one controller opens unchanged, and a project saved with
  two opens with one keyboard connected without losing the other's cables (D-029).

## Out of scope

- Hot-plugging a **profile** without reloading the window. The reload stays, and
  since 2026-09-05 it no longer costs anything: `ProjectManager.reloadKeepingProject()`
  hands the open project — unsaved edits included — through the same staging a
  project switch uses. Removing the reload means making the node id mutable for
  ~30 consumers; it is a separate workstream and probably an unnecessary one.
- Merging two keyboards into one node, or any "primary controller" notion.
- The site Builder, which describes one device per file and is right to.
- Anything about the MIDI **output** side of a controller beyond what already
  exists per node.

## Steps

- [x] 1. `main/controllerProfiles.js`: `selectedProfileFile` becomes a list of
      names, `readSelectedProfile` becomes `readSelectedProfiles`, and
      `carrySelectedProfile` carries the list. Reading an old settings file with
      a single string must still work.
      Check: `node --test test/controllerProfiles.test.cjs test/profileIpc.test.cjs`
- [x] 2. `preload.js` hands over an array; `midi/loadedProfile.js` exposes
      `LOADED_PROFILES` (never empty — the shipped profile is the fallback) and
      `PROFILE_ORIGINS`, one origin per entry.
      Check: `node --test test/loadedProfile.test.mjs`
- [x] 3a. `core/systemNodes.js`: `CONTROLLER_NODE_IDS` and `isControllerNode(id)`
      arrive BESIDE `MINILAB_NODE_ID`, and `core/controlBindings.js` moves to
      them -- its three sites were testing membership in a set that happened to
      hold one element, which is the whole of what they needed.
      Check: `npm test` + `npm run check`
- [x] 3b. `MINILAB_NODE_ID` stops being exported and its last four consumers go
      with it. Done after 6, as predicted. `core/controlRouting.js` now emits on
      `control.sourceNodeId` — the decoded control's own node — and
      `core/midiRouting.js` on the message's `profileId`, falling back to the
      first controller only for a port no loaded profile claims. A panic goes
      through EVERY controller node: the event does not say which cable went
      away, and a note held on the other keyboard is just as stuck. **This cannot happen before 4, 5 and 6**, measured 2026-09-05
      against the code rather than against the table above: `core/controlRouting.js`
      and `core/midiRouting.js` need the node of the profile that DECODED, and
      that does not exist until `midiManager` arms one port per profile (step 6)
      -- `hub.events.on('midi:message')` carries no profile today.
      `midi/minilabControls.js` (step 4) and `modules/minilab/minilabModule.js`
      (step 5) hold the other two. Dropping the export first would leave all four
      reading `CONTROLLER_NODE_IDS[0]`, which is the "primary controller" this
      plan puts out of scope -- written as an implementation detail rather than
      as a product notion, which is exactly how one gets in.
      Check: `npm test` + `npm run check`, and no `MINILAB_NODE_ID` left in `src/`
- [x] 4. `midi/minilabControls.js` derives its sources **per profile**; the
      exported constants become per-profile lookups. This is the file that
      freezes `test/conformance/control-sources.json`, and the shipped profile's
      sources still come out field for field identical.

      What it took, beyond that file: the two lookups keyed on strings that are
      unique only WITHIN a profile were split by how unique they actually are.
      `getMiniLabControlSourceByPort` takes the node now (`control-k1` is a
      socket on every keyboard that has a first knob), while
      `getMiniLabControlLayout` moved to the source id `<profileId>:<controlId>`,
      which is unique on its own and which every caller already held — so no
      second argument had to be threaded through the drawing code.
      `controllerNodeOfSource` answers "whose knob is this", which is what
      `isConnected` needed: "from a controller, on that port" reported
      `minilab-3:k1` as cabled because the BeatStep beside it was.
      `surfaceOfNode` replaced the single `MINILAB_SURFACE`; the one-device
      exports stay, as the first keyboard's.
      Check: `node --test test/minilabProfile.test.mjs test/deviceAgnostic.test.mjs`
      plus `test/twoControllers.test.mjs`, below.
- [x] 5. `modules/minilab/minilabModule.js` registers one page and one node per
      loaded profile, and unregisters symmetrically. `createMiniLabModule(hub,
      profile)` takes the profile as an argument — a module-level read is a
      constant no test can swap — and `app.js` loops over `LOADED_PROFILES`.

      The page id is `controller-<profileId>` and NOT the node id.
      `test/profileImport.test.mjs` pins that the two differ, because
      `ModuleSystem.activate()` answers false for an unknown id without saying
      so and the Open button was once dead from exactly that. Making them equal
      would have been convenient and would have re-opened the trap.
      Check: `npm test`
- [x] 6. `midi/midiManager.js` arms one port per profile: a message is decoded
      with the profile whose declared port it arrived on, and a port no profile
      claims stays unarmed and says so. `midi:message` carries `profileId`.

      The rule that made this safe: **the selected port decides**. The profile
      claiming it is armed on it, the OTHER profiles then arm their own best
      performance port among what is left, and if no profile claims the
      selection nothing is armed at all — the user is driving by hand. With one
      profile loaded the map holds at most the selected port, so the filter is
      exactly what it always was and "only the explicitly selected port may enter
      live routing" still holds. A port is claimed once: two profiles on one
      cable would emit every message twice, on two nodes.
      Check: `node --test test/midiInputSelection.test.mjs test/midiPanic.test.mjs`
- [x] 7. The controller section moves from "Use" to per-profile Load/Unload, and
      says what is loaded rather than what is selected. Import ADDS rather than
      replaces — an import that unselected the MiniLab would unplug a keyboard
      the user never mentioned.

      **Buttons, not a checkbox.** Same semantics, and it reuses `.btn`/`.pill`
      rather than introducing an unstyled native control on a panel where
      appearance is the point. The built-in row has no button of its own: it is
      what runs when the set is empty, not a member of it, and a button that
      "selects" it would really be a button that unloads everything else.
      Check: `node --test test/profileImport.test.mjs`
- [x] 8. A conformance test with **both** fixtures loaded at once: a CC 74 from
      the MiniLab's port and a CC 74 from the Vega's port decode to different
      controls, on different nodes, with no cross-talk.

      **Landed early, with step 4**, as `test/twoControllers.test.mjs` — because
      nothing else in the suite can load two profiles, so step 4 had no way to be
      proved without it. It injects `globalThis.hubProfiles` before importing the
      module graph dynamically (a static import is hoisted above the injection
      and would silently test one keyboard); `node --test` gives each file its
      own process, so the injection cannot leak.

      Seven tests, all green: both keyboards load as controller nodes; CC 74
      decodes to `minilab-3:k1` and to `vega-49:dial-one` on their own nodes; a
      keyboard does not answer for a port it does not own; a port id resolves
      inside its own keyboard only; every source is listed once; each keyboard
      draws from its own box.

      Extended to eleven once 5, 6 and 3b landed: two pages and two routing
      nodes with their own sockets and their own boxes; a control leaving by the
      node of the keyboard that sent it; raw MIDI doing the same, with the
      first-controller fallback for an unclaimed port; a panic reaching both
      nodes; and each keyboard armed on its own cable, with an unclaimed
      selection arming nothing.
      Check: `npm test` + `npm run check` + `npm run sync:dist`

## The defect the eight steps shipped with, and its fix

Reported by the author, 2026-09-05, immediately after step 8: **"on ne peut pas
utiliser les deux en meme temps"**. He was right, and the tests were all green.

Reproduced from his own `%APPDATA%/minilab-hub/profiles/` (one file:
`arturia-beatstep.json`). Selecting the BeatStep gave `LOADED_PROFILES =
['arturia-beatstep']` -- the MiniLab was GONE, not joined.

**Cause.** The shipped profile was never a member of the list. It was the
fallback for an EMPTY list, and it had no file name, so no selection could name
it. Every step from 1 to 8 was built on a model in which the user's main
keyboard could not appear beside another one -- which is the one arrangement the
plan exists to produce. Eleven tests passed because all of them injected two
FILE profiles, a situation that cannot occur on a real machine: only one profile
ships, and it is not a file.

**Fix, in two layers -- the second found while checking the first.**

1. The shipped profile answers to `<profileId>.json`. `resolveProfiles`
   substitutes it for a selection of that name that main could not read, which
   is what main will always report for a profile with no file. An imported file
   of the same name still wins (D-025: the profile IS the hardware), so an
   updated `minilab-3.json` simply takes over.
2. The panel reads its loaded set from `data-profile-loaded` on the row, not
   from the presence of an Unload button. The shipped row runs whenever the list
   is empty and deliberately has NO Unload -- there is nothing to unload to -- so
   reading the buttons reported an empty desk, and adding a BeatStep wrote a
   list without the MiniLab in it. The same disappearance, one layer up.

Both are covered by tests that fail without them, including one named for the
author's exact situation.

## The wrong faceplate, and what it settled

Reported from the running application 2026-09-05, with a screenshot: the MiniLab
was cabled to VST 1 and the Learn panel was drawing the BeatStep. Both keyboards
were on the desk and in the sidebar, so steps 1-8 held; the panel did not. It
drew the FIRST LOADED profile and had always done so, which with one keyboard
was indistinguishable from drawing the right one.

**The panel follows the cables now**, one faceplate per keyboard wired into
`ctrl-in`, each named when there is more than one, deduplicated (a keyboard
usually arrives on several cables, one per mapped knob). With nothing cabled: one
keyboard on the desk is still drawn greyed out, since there is nothing to
mistake it for; two or more draws neither and says to cable one, because
choosing between them is the guess that caused this.

**A rule was proposed, tried, and reversed within the hour** — worth recording
because the reversal is the useful half. "One controller per VST" was settled
first, and a guard went into `network.connect()` refusing a second source on a
CONTROL input. The author then revised it: only the MIDI input is one-to-one.
Nothing should stop a second controller on the CONTROL side — playing on one
keyboard while another drives the parameters is a real desk. The guard came back
out. What could only handle one keyboard was the panel, not the cabling.

**Not implemented, and not assumed:** whether the MIDI input should REFUSE a
second cable. It was stated as a fact rather than as a request, and enforcing it
would also refuse Sequencer + keyboard into one plugin, which nothing has asked
for.

## What is left

- **Seeing it run.** No launch with two profiles loaded. That is the one thing
  tests cannot stand in for, and the reason this plan opened with a working note
  about announcing before verifying.
- **Committing.** Two distinct workstreams sit uncommitted in the same tree: the
  device-independent drawing from the session before, and this one.
- ~~The controller page's own mini-keyboard is still 25 keys from C2~~ —
  **settled 2026-09-05 by removing it, and nothing replaced it.** The author's
  call, in two steps: the drawing does not have to be exact, the user just has to
  see the signal arrive — and the event monitor on that same panel already shows
  it live, with the control's NAME, which is more than a lamp can say and is how
  you identify a control you are unsure of. A lamp was built, did not work (its
  element was never cached, so every flash was swallowed by a guard) and was
  removed rather than repaired: the monitor was the better answer either way.
  It did close a defect beside it, which stays: the page did not filter
  `midi:message` by profile at all, so one page counted both instruments.
- The Learn panel draws the first keyboard's surface only. `renderControlBindings`
  builds its states from every source on the desk but draws one panel; with two
  keyboards the second one's controls are selectable from the toolbar and absent
  from the drawing.

## Fallback point

The point of no return is **step 3b**, at the end of step 6 -- not step 3, which
is where this plan first put it. Everything up to and including 3a is additive:
`MINILAB_NODE_ID` is still exported and still correct, `LOADED_PROFILE` and
`PROFILE_ORIGIN` still answer, and the only visible change is that the settings
file holds a list where it held a string -- which step 1 reads either way.

Abandoned after 3a, the application is exactly what it was, with one keyboard
selected at a time, and nothing to undo.

## What step 4 turned out to be

Measured 2026-09-05, before starting it: it is wider than "minilabControls.js".
Two lookups in that file are keyed on strings that are only unique WITHIN a
profile -- `getMiniLabControlSourceByPort('control-k1')` and
`getMiniLabControlLayout('k1')` -- so both need the node to answer, and their
callers (`core/controlBindings.js`, `ui/miniLabControlSurface.js`,
`core/nodeInstances.js`) move with them. `MINILAB_SURFACE_CONTROLS` and
`MINILAB_SURFACE_BOX` describe ONE device and become per-node as well.

That is the same set of files as the uncommitted device-independent drawing
work. Doing both at once means a regression cannot be attributed to either, so
the drawing work wants committing first.
