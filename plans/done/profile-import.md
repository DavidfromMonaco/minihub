# Importing a profile — ExecPlan

**Goal** — A controller profile that did **not** ship with the application can be
chosen, and MiniHub runs on it. A friend who writes `korg-nano.json` by hand puts
the file into MiniHub and his keyboard works; nothing has to be rebuilt.

**Origin** — [ROADMAP.md](../../ROADMAP.md) §8, which names it as the next piece
of work in the application: `loadedProfile.js:22` imports the profile at build
time, and `preload.js` exposes no file access for profiles, so the catalogue
[DECISIONS.md](../../DECISIONS.md) D-024 specifies would serve files nothing can
consume. It stands on its own — the hand-written profile needs it as much as the
Builder does — and it is what D-022 froze deliberately.

**Status** — **finished 2026-09-05**, 12 of 12 steps, started the same day.

**Result** — MiniHub reads a profile it did not ship with. The choice is made at
launch and changing it reloads the window, because `MINILAB_NODE_ID` is a
module-level constant evaluated before `app.js` runs a line; the shipped profile
is the fallback, and a chosen one that cannot be honoured says so rather than
disappearing. 727 JS tests, 15 `npm run check` rules, `dist/` synchronised.

Three defects were found by writing it, each of which would have shipped a silent
failure: cables deleted by a profile change (D-029), the faceplate throwing on any
other keyboard (D-028), and `layout` still required so a profile written without a
photograph would have been refused at import (D-030).

**What this leaves for the next hands, and it is not mechanical** — nothing here
has been run in the real application. The IPC is proven against a stubbed
Electron, the panel against its own markup, the drawing against a static render.
What is owed: import a profile in the running MiniHub, see the Settings panel,
and play through a keyboard that is not the MiniLab — which needs either a second
device or a profile written by hand for one. Port selection and real MIDI are
exactly what `npm test` cannot see, and that was true of Étape A too.

---

## Context

Four things verified in the code on 2026-09-05, before anything was written. Two
of them decide the shape of the work.

**1. The profile cannot arrive asynchronously.** `MINILAB_NODE_ID` is a
module-level constant (`core/systemNodes.js:40`), evaluated when the ES module
graph loads — which is *before* `main()` in `app.js` reaches
`await hub.settings.load()`. A profile fetched through an async IPC call arrives
after every consumer has already frozen its value. So the profile has to be
present **before the first module evaluates**, and only `preload.js` can do that:
it runs before page scripts and has Node.

The consequence is the design, not a compromise: the profile is a **launch-time**
choice, and changing it reloads the window. That is what keeps `MINILAB_NODE_ID`
a constant, keeps its ~30 consumers untouched, and does exactly what
`loadedProfile.js`'s own docstring asks for — *"what changes when that day comes
is this file and its callers' import shape, not thirty call sites"*. The
application already survives a renderer reload (`core/chainSync.js` rebuilds the
engine's chains).

**2. Changing profile silently deletes cables.** `network.js:270` `restore()`
skips a connection whose node is absent — `console.warn`, nothing else — and
`_persist()` then writes the file without it. The controller node id **is** the
`profileId`, so the moment another profile loads, every cable from the controller
in a saved project points at a node that does not exist, is dropped, and is gone
at the next save.

This is specification §6.1 one level up: the same silent-loss shape that
`normalizeControlBinding` was fixed for. Bindings are already safe — they
validate shape, not belonging, and an unresolved one is kept and reported
`missing-target`. Cables are not. Shipping the import without this ships a
data-loss path, so it is step 1 and not a footnote.

**3. Validation stays in the renderer.** `src/main/` is CommonJS and cannot
import `midi/controllerProfile.js`, which is an ES module the `module boundary`
check rule keeps that way. Main reads bytes; the renderer validates — at import
time, to reject with the accumulated errors, and again at launch, because a file
can be hand-edited between two launches. `loadedProfile.js`'s line *"The profile
is NOT validated here"* stops being true and changes with it.

**4. The `one profile ships` check rule reads the import line itself.**
`scripts/check-invariants.mjs:402` extracts `import profile from '…'` out of
`loadedProfile.js` and calls that import *the decision*. It fails the moment the
loader stops importing statically. The rule is re-expressed, never deleted:
D-022's refusal of the plural is not what this workstream lifts.

**5. The faceplate crashes on a foreign profile.** Raised by the author, and it
is bigger than three pages: `ui/miniLabControlSurface.js` is **one** function
drawn in **three** places — the MiniLab page (`modules/minilab/minilabModule.js`),
the VST page's Learn panel (`nodeInstances.js:230`, `renderControlBindings`) and
the Patch Bay node (`MINILAB_SURFACE` → `core/nodeGeometry.js`).

Knobs, faders and pads it draws from `family` and the profile's coordinates, and
those are generic. Five controls it fetches **by id**: `shift`, `pitch-bend`,
`modulation`, `main-encoder`, `main-click`. `vega-49.json` declares none of them,
and the very next thing done with the result is `control.id` — so the render
throws `TypeError: Cannot read properties of undefined (reading 'id')`, measured
2026-09-05, not deduced. Two of the three pages go down with it.

**6. A profile with no `layout` gets a node with no sockets.** D-023 made
`layout` optional; nothing downstream learned that. `MINILAB_SURFACE_BOX` spreads
`profile.device.layout` — absent gives `{}`, not a failure — and
`nodeGeometry.js:70` keeps only the ports found in `node.surface.ports`. A node
that declares a surface it cannot fill therefore renders 166 px tall with **zero**
control ports: the controls exist in the network, decode correctly, and have no
socket to cable. Silent, and exactly the shape D-023 warned about.

To reread: ARCHITECTURE §4 (IPC), §10 (UI), §11 (persistence), §13 (invariants
4, 6, 7). D-023 (`layout` optional), D-012 (shell vs faceplate).
`MINIHUB_CONTROLLER_PLATFORM_SPEC.md` §3.2, §3.3, §6.1, §6.2. D-007, D-015,
D-020, D-022.

## Constraints

- Invariant 4 — a node `id` is never reused; the controller's id stays the
  `profileId`.
- Invariant 7 — a system node identifier comes from `core/systemNodes.js`.
  `MINILAB_NODE_ID` stays a constant, resolved once per launch.
- D-007 — the IPC surface is a fixed allow-list. New `profile:*` channels are
  declared, not passed through.
- D-015 — no file lands in a folder the user has not chosen. A profile is
  application data, not a document: it goes to `userData/profiles/`, which is
  where `settings.json` already lives, and no picker memory is involved.
- Specification §3.3 — migration is empty. A user who never imports anything sees
  no change, and his projects open identically.
- The shipped profile stays the fallback. An absent, unreadable or invalid
  chosen profile falls back to it rather than launching with no controller.
- `midi/{parseMidi,controllerProfile,portRoles,decodeControl}.js` stay
  import-free (§3.5, the `shared decoder` rule). `loadedProfile.js` is not in
  that set and may import the validator.

## Out of scope

Named because each one is tempting from inside this work:

- **The plural.** One profile is loaded at a time. D-022 stands: no multi-input
  `MidiManager`, no N controller nodes, `selectedInputId` stays singular.
- **The catalogue and the Builder** (Étape C). This makes a file consumable; it
  does not fetch one, list one from the site, or update one.
- **Editing a profile inside MiniHub.** A profile is written elsewhere and
  imported. No in-app editor, no calibration, no layout capture.
- **`cc14`, and a consumer for `mode: relative`.** Both are recorded in
  `test/conformance/vega-49.json` and belong to the decoder, not here.
- **Renaming `profile` to `setup`** in the code. D-026: 417 occurrences for a
  word only the code reads.
- **A faceplate drawn to another device's own coordinates.** The HTML surface is
  CSS-positioned for the MiniLab's panel; making it coordinate-true means a
  second drawing engine, in SVG because invariant 10 rules out positioning by
  style attribute. This plan makes a foreign keyboard *usable and legible*, not
  *photographic*. It is the natural companion to D-023's list mode and deserves
  its own workstream.

## Steps

- [x] 1. `network.js` keeps a connection it could not restore: `restore()`
      collects what `connect()` refused because a node was absent, `serialize()`
      writes those back out, and one resolves the day its node returns. An
      unresolved cable never routes and never reaches the engine.
      Check: `node --test test/network.test.mjs test/routing.test.mjs` — 44 pass.
      Then `npm test` 684 pass, `npm run check` 15 rules, `sync:dist` run.
- [x] 2. `loadedProfile.js` resolves instead of importing: it takes what preload
      injected, validates it, and falls back to the shipped profile when there is
      nothing, when the file is unreadable, or when validation fails — recording
      which of the three happened. The shipped JSON stays statically imported as
      that fallback, so `MINILAB_NODE_ID` stays a constant.
      Check: `node --test test/loadedProfile.test.mjs` (new) — **done**, 6 cases.
- [x] 3. The `one profile ships` rule is re-expressed against the fallback rather
      than the import line: one profile under `midi/profiles/`, and it is the one
      the loader names. Probe it by breaking it deliberately.
      Check: `npm run check` — **done**, probed on both halves plus the new one.
- [x] 4. `src/main/controllerProfiles.js` (CommonJS) owns `userData/profiles/`:
      list, read the selected one, store an imported file, forget one. Settings
      gain `selectedProfileFile` — a file **name**, never an absolute path, so a
      moved folder cannot make it point outside.
      Check: `node --test test/controllerProfiles.test.cjs` (new) — **done**, 9 cases.
- [x] 5. `preload.js` hands the profile over synchronously, before the first
      module evaluates (`window.hubProfile`), and exposes the async half on
      `hubAPI`: list, import, select, forget.
      Check: `node --test test/profileIpc.test.cjs` (new) + `npm run check` — **done**;
      probed by turning `sendSync` into `invoke`, which nothing else in the
      repository notices.
- [x] 6. The import path: main opens the picker, the renderer validates with
      `validateControllerProfile()` **before** asking main to store anything, and
      shows the accumulated errors when it refuses. Selecting reloads the window.
      Check: `node --test test/profileImport.test.mjs` (new) — **done**, 15 cases.
- [x] 7. The format learns to say what is written on the hardware, and what
      cannot be played. Two optional fields, decided by the author on
      2026-09-05: `printed` on a control — the text the panel carries next to it
      — and `silent: true` — a real control that sends nothing. A silent control
      is **drawn and never routed**: it produces no CONTROL source, so no Patch
      Bay port and no binding key, which is what keeps
      `test/conformance/control-sources.json` byte-identical at 25 sources.
      `computeCompleteness()` gains `silent` so those controls stop counting as
      `untested`, which they are not. `minilab-3.json` then declares `HOLD`,
      `OCT −`, `OCT +` and its display as silent, and the eight pad legends as
      `printed`.
      Check: `node --test test/controllerProfile.test.mjs test/minilabProfile.test.mjs`
      + `npm run check` (the `profile is data` rule validates the shipped file)
      — **done**: 687 JS tests, 15 check rules, `sync:dist` run. The MiniLab now
      declares 29 controls, 25 of them playable; the frozen 25 control sources are
      untouched, so no saved project moves.
- [x] 8. The control surface stops naming controls: `miniLabControlSurfaceHtml()`
      renders every shape from `family`, `layout` and `printed`, and fetches
      nothing by id. A profile that declares no `strip` simply draws no strip,
      instead of throwing. The MiniLab's faceplate is unchanged on screen because
      step 7 put its four decorations into its own profile. Drawn in three
      places, so it is fixed in one. **`printed` is always drawn** — subdued if
      it must be, never dropped: it is what the user matches against the words
      on the object under his fingers, and a label he cannot see is worth
      nothing. The author's rule, 2026-09-05.
      Check: `node --test test/miniLabSurface.test.mjs` + a new case rendering
      `test/conformance/vega-49.json` without throwing — **done**: 690 JS tests,
      15 check rules, `sync:dist` run, and both drawings compared by eye against
      the previous version rendered from `HEAD`.
- [x] 9. No `layout` means a list, not an empty node. A profile without
      coordinates gives the routing node **no** `surface`, so its control ports
      stack in the dock like any other node's; the MiniLab page shows the controls
      grouped by family instead of a faceplate. D-023, in the two places that
      read the field.
      Check: `node --test test/miniLabSurface.test.mjs test/routing.test.mjs`
      — **done**: 693 JS tests, 15 check rules, `sync:dist` run, list mode seen.
- [x] 10. The Settings surface, in `base.css` vocabulary (shell, not faceplate):
      which controller is in use and where its profile came from, a button to
      import, the list to choose from, and the sentence saying the window
      reloads.
      Check: covered by `test/profileImport.test.mjs` (markup + binding) — the
      panel row got no test file of its own, because the section is where the
      logic lives and the modal only embeds it. **The eye is still owed**: this
      panel has not been seen in the running application.
- [x] 11. Documentation: ARCHITECTURE (the launch-time resolution, the new IPC
      channels, the surface's two modes), a DECISIONS entry for why the choice is
      made at launch and not live, one for `printed` / `silent`, ROADMAP §8,
      specification §4.3, §6.1, §6.2, §6.3.
      Check: `npm run check` + reread — **done**: D-027 to D-030, ARCHITECTURE §4,
      ROADMAP §8, specification §0 revision v2.3.
- [x] 12. `npm run sync:dist`, then the full run.
      Check: `npm test && npm run check`

## Settled 2026-09-05 — what is written on the hardware belongs in the format

Four things on the faceplate were not controls and had no field: the words
`HOLD`, `OCT −`, `OCT +`, the imitation display reading `PAD 1 · C1 / 36`, and
the eight pad legends (`Arp`, `Pad`, `Prog`…, already flagged in the file as
*"hardware text with no field in the profile format yet"*).

Three answers were put to the author — drop them, declare only the two that are
buttons, or keep a decoration block for the shipped profile alone. He refused all
three and gave the reason that reframes them: **a user has to recognise every
control, and what he recognises it by is what is written on his hardware.** That
is not decoration, it is the label on the object under his fingers. So it is not
a MiniLab special case to be tolerated — it is a field every profile is entitled
to, and the MiniLab is simply the first to fill it in.

Hence step 7. Two consequences worth naming:

- **The Builder will need to ask for both**, when Étape C comes. `+ silent`
  already exists there; `printed` does not.
- **A profile carrying either field is refused by a MiniHub older than this
  change**, because the validator refuses unknown fields by design. Nothing is
  released and there is one user, so the window to do this for free is now.

## Fallback point

`0f4d7e2` — D-026, working tree clean, 678 JS tests and 15 check rules green.

## Done when

- `npm test` and `npm run check` green, `npm run sync:dist` run.
- A profile that never shipped is imported, selected, and the application runs on
  it: the Patch Bay draws that device's controls, the header names it, and a MIDI
  message from the real controller decodes through it. **Verified with hardware**,
  because port selection is what `npm test` cannot see.
- A user who imports nothing sees no change: his project opens with every cable,
  node position and binding it was saved with.
- Switching profile and switching back returns the cables. This is the one that
  says step 1 worked.
- The three surfaces that draw the controller — Patch Bay node, MiniLab page, VST
  Learn panel — render a foreign profile without throwing, with a layout and
  without one. This is the one that says steps 7 and 8 worked.

## Log

2026-09-05 — **Second run, and the interface moved again.** The profile panel was
drawn on the controller's page but read `RunningMiniLab 3`: `.kv` was scoped
`.modal .kv`, so outside the Settings window there was no layout at all. De-scoped
like `.folder` before it, and the origin note was lifted out of the row — that row
is `space-between`, so a third element in it spreads instead of reading as a note.

**"Not your keyboard?" was there and did nothing.** It navigated to the
controller's NODE id (`minilab-3`) while the module system is keyed by its PAGE
id (`minilab`), and `ModuleSystem.activate()` answers `false` for an unknown id
**without saying so**. `AUDIO_OUTPUT_NODE_ID` is deliberately both at once, which
is what made the assumption feel safe.

The first fix was a shared constant. `npm run check` refused it twice — first as a
device word in `core/systemNodes.js`, then as one in an import path — and it was
right both times. That pushed to the answer that is not a better constant but a
question: **`controllerModuleId(modules)` in `core/controllerNode.js` asks which
module owns the controller's routing node**, exactly as `controllerName()` already
asks the network what the keyboard is called. A shell that spells a page id is a
shell that can spell the wrong one.

Three tests, one of them honestly labelled a source read: the navigation lives in
a delegated click handler built inside `mount()`, and reaching it means standing
up the whole VST editor against a shim that does not parse HTML. Both probes fail
— the node id back, or the lookup answering `routingNode.id`. 730 JS tests.

**Seen and deliberately not touched**: `routingModule.js` `openNodeEditor()` opens
a node's page by its NODE id, guarded by `hub.modules?.get(nodeId)`. Clicking the
controller's Patch Bay card therefore opens nothing — the same mismatch, but
guarded, so silent and harmless. It wants the same `controllerModuleId()` answer,
and it is a decision rather than a defect.

**What the real application has and has not shown**, as of the end of this
session:

| Checked in the running app | Not yet |
|---|---|
| launches, project intact, faceplate drawn | importing a profile |
| the Profile panel on the controller's page | the cable round trip (D-029) |
| "Not your keyboard?" present | a refused profile's fault list |
| | the list mode of a profile with no `layout` |

Three fixtures are waiting in `artifacts/profile-test/` (git-ignored):
`vega-49.json` legal and placed, `vega-49-no-layout.json` legal and unplaced,
`broken.json` with three faults.


2026-09-05 — **First run in the real application, by the author, and it moved the
interface.** Nothing was broken: the one alarm — "my save was lost on opening" —
was a recent-project shortcut pointing at a test file he had deleted, and the
code did exactly what it should (read fails, stale pointer forgotten). Verified
before touching anything: no error in the log, his project file intact, and a
settings round-trip on his real `settings.json` losing no key.

Two things were in the wrong place, and both are his observation:

- **Importing a profile belonged on the controller's own page**, not in Settings.
  Settings is where a user says where files are written; the page carrying the
  device's name is where he goes when the KEYBOARD is what is wrong. The section
  moved there whole, and left Settings entirely — one place, not two.
- **The VST Learn panel was a dead end.** It draws the controls of the loaded
  profile and said nothing about where a profile is chosen. It now carries
  "Not your keyboard?", which opens the controller page.

Moving the section out of the modal required de-scoping `.modal .folder` to
`.folder` in `base.css`; those classes are used by exactly two files, so nothing
else moved. 728 JS tests.


2026-09-05 — Plan written after reading the code rather than the specification.
Two findings moved the shape: the profile must be resolved before the module
graph evaluates (so a profile change is a window reload, not a live swap), and
`network.js` drops an unresolved cable silently, which makes a data-loss path out
of the feature unless it is fixed first.

2026-09-05 — **Step 1 done.** The trap was not in `restore()` but next to it:
`_emit()` built the `network:change` payload from `serialize()`, and that event is
what `engineSync`, `controlBindings`, the sequencer and the Patch Bay read as the
live routing. Widening `serialize()` to carry the waiting cables would have handed
phantom cables to the engine. So the two lists were separated by name —
`serialize()` is what gets **written**, `connections()` is what is **routing** —
and the one other emitter (`nodeInstances.js:382`) was moved across too. Six tests
added; four of them fail against the previous behaviour, verified by putting it
back, including the acceptance one (switch profile, save, switch back, the cables
return). 684 JS tests.

2026-09-05 — **Steps 2 and 3 done.** `loadedProfile.js` resolves instead of
importing, and `resolveProfile(handover, shipped)` is exported and pure — the
decision has to be runnable in a test, because what it produces is a module-level
constant nothing can swap afterwards, which is the trap this workstream exists to
get out of. Four ways to fail, all ending on the shipped profile and none of them
in silence: nothing chosen, the file gone or not JSON, the profile invalid (every
fault kept, since the validator accumulates them so a file is fixed in one pass),
and a handover that makes no sense.

The `one profile ships` rule kept passing and had started to lie: the static
import is no longer *the decision*, it is what MiniHub falls back to. Re-expressed
rather than deleted — D-022's refusal of the plural is not what this lifts — and a
third clause added that turns out to be the load-bearing one: **the loader must
call `validateControllerProfile`**. Nothing else stands between a hand-edited JSON
and the routing node's id, and its absence would fail no test, because every test
runs on the profile that ships. All three clauses probed by breaking them.

2026-09-05 — **Step 9 done, and it was a prerequisite rather than a finishing
touch.** `layout` was still REQUIRED in the validator: D-023 declared it optional
in specification only, so a profile written without a photograph — exactly the
kind the Builder produces — would have been refused at import. Building steps 2
to 6 first would have been building a door that turns away half its visitors.

Three things it changed:

- `layout` optional on the control and on the device, with placement made
  **all or nothing**. A half-placed profile is the dangerous one:
  `nodeGeometry.js` draws a surface node's ports from `surface.ports`, so a
  control with no coordinate gets no socket at all — it decodes, it appears in
  Learn, and nothing can be cabled to it. Refusing the file is the only place
  that is visible.
- `MINILAB_SURFACE_BOX` was `{ ...profile.device.layout }`, which turns an absent
  box into `{}` — truthy, so every caller downstream would have believed it had a
  panel of width `undefined`. It is null now, and `MINILAB_SURFACE` with it, which
  is what makes the routing node fall back to the dock.
- `controlListHtml()` answers the **same contract** as the panel — same
  `data-source-control-id`, same state classes, same silent rule, same `printed`.
  That is what lets the MiniLab page and the VST Learn panel keep working without
  learning a second mode, and it is the difference between a fallback and a
  second interface to maintain.

2026-09-05 — **Step 8 done**, both renderers, and it needed a seam the tests
could not do without: `controls` is now an argument to
`miniLabControlSurfaceHtml()` and `appendMiniLabControlSurfaceSvg()`, defaulting
to the loaded profile's. Without it "this draws any keyboard" could only be
asserted, never run — the profile is fixed at module load and nothing can swap
it. Same reasoning as `core/controllerNode.js`.

Verified by eye, not only by test: the previous renderer was extracted from
`HEAD`, both were rendered to static pages against the real `base.css` and
compared. Two differences, one of them a regression that the tests would never
have caught — the display's caption line lost its capitals, because the old
markup spelled `PAD 1 · C1` in the HTML and the profile says `Pad 1 · C1`. Case
is presentation, so `text-transform` in `base.css` carries it now. The second is
not a regression and is the author's to judge: the encoder's push reads
`MAIN CLICK` where it read `CLICK`, because the word is the profile's label.

The fixture device drew what it should: four controls in the boxes that fit them
and six — `wheel`, `pedal`, `encoder`, `breath` — in `ml-extra`, the row that
exists so a control with nowhere to go is not a control that vanishes. Rendering
it also found a defect no assertion had: a pad with no `printed` printed its own
label twice, so the second line is written only when the panel says something the
label does not.

2026-09-05 — **Step 7 done, taken out of order** because it is the direct
consequence of the decision above and stands alone. Three things it taught:

- `silent` had to be **optional in `completeness`**, absent meaning none.
  Requiring it would invalidate every profile written before today, the Builder's
  output included, for a counter that is zero in all of them.
- `npm run check` caught the four new ids itself — `immutable control ids`
  refuses a profile that gained an id nobody recorded. They are recorded now,
  with the reason a silent id is worth recording although nothing persists it
  yet.
- Nothing changed on screen, which is the point: the four decorations are still
  drawn by the hard-coded HTML, and the profile now merely also declares them.
  Step 8 is what makes the renderer read them instead.

**And a finding that resizes step 8.** The HTML faceplate does not use the
profile's coordinates at all: `base.css:1285-1303` positions every region in
percentages written for this panel — `.ml-knobs { left:30%; grid-template-columns:
repeat(4,1fr) }`, `.ml-pads { repeat(8,1fr) }`. Only the Patch Bay SVG reads
`layout`. So a coordinate-true HTML faceplate for another device is not a
refactor, it is a second drawing engine — and invariant 10 forbids the obvious
way to build one, since a style attribute is dropped silently by the CSP. Step 8
is therefore cut at: nothing is fetched by id, every declared family is drawn
into the regions that exist, silent controls are drawn and not clickable,
`printed` is always shown. **A foreign profile gets an approximate faceplate, not
its own panel.** Drawing a device truly to its own coordinates is named in Out of
scope below.

2026-09-05 — The author named the three surfaces the profile change also hits,
and he was right: Patch Bay, VST page, MiniLab page. Reading them found one cause
under all three (`ui/miniLabControlSurface.js` is drawn in all of them) and a
harder failure than expected — it fetches five controls by id and throws when a
profile lacks them, measured against `vega-49.json`. Plus D-023's optional
`layout`, which nothing downstream learned about. Two steps added, and an open
question that is the author's to settle. §6.6's `id == "minilab-3"` in the native
engine is **gone** — grep finds no device literal under `native/audio-engine/src/`
— so the plural is no longer holding a C++ debt.
