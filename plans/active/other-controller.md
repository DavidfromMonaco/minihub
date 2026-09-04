# One other controller — ExecPlan

**Goal** — MiniHub works with a controller that is not a MiniLab 3, one at a
time. A friend writes a profile for his own keyboard and uses the application;
nothing in `src/` assumes which device is plugged in.

**Origin** — [DECISIONS.md](../../DECISIONS.md) D-022 · [INTENT.md](../../INTENT.md)
§8 quater · `MINIHUB_CONTROLLER_PLATFORM_SPEC.md` §4.2, §6.4, §6.5 · the closing
entry of [plans/done/controller-profile.md](../done/controller-profile.md), which
named the decoder's remaining dependency on `midi/minilab.js`.

**Status** — not started.

## Context

Étape A made the MiniLab a file. What is left is that the *application* still
knows it by name in four places, verified in the code on 2026-09-04:

- `src/renderer/js/midi/minilab.js` — `isMiniLabName()`, `isPerformanceInputName()`
  and `miniLabScore()` decide which MIDI port can carry what is played, by
  matching port names against `/minilab/i` and `\b(mcu|hui|din\s*thru)\b`. The
  profile already has the field for this: `device.ports[].role` and `.priority`
  (spec §4.2), written and validated at Étape A, read by nobody.
- `src/renderer/js/core/sequencerController.js:9` — `isCanonicalMidiIngress`
  requires `from.nodeId === MINILAB_NODE_ID`, and five sites use it. Three error
  messages name the device (lines ~678, ~684, ~686).
- `src/renderer/js/ui/header.js:50` and `:53` — `'MiniLab 3 connected'` and
  `'No MiniLab 3 detected'`, as strings.
- `src/renderer/js/core/controlBindings.js` — three uses of `MINILAB_NODE_ID` to
  test whether a cable comes from the controller.

Sections to reread: spec §4.2 (port roles), §6.4 (why the plural is expensive),
§6.5 (sequencer ingress). ARCHITECTURE §13 invariants 2 and 7. D-018, D-020,
D-021, D-022.

## Constraints

- **`selectedInputId` stays singular** (D-022). `MidiManager` is not refactored,
  the settings shape does not move, and no project migrates.
- **No identity moves.** `profileId` stays `minilab-3`, port ids stay
  `control-k1`, binding keys stay `minilab-3:k1`. The `immutable control ids`
  rule and `test/projectCompatibility.test.mjs` are what hold this.
- **Exactly one profile ships.** A second profile exists only as a test fixture.
- The corpus `test/conformance/midi-corpus.json` is frozen and must keep passing
  unchanged: it is what says the decoding did not drift.
- Invariant 11: `npm run sync:dist` after every step touching `src/`.
- Invariant 7: a system node identifier still comes from `core/systemNodes.js`
  while there is one controller. Its **value** may come from the profile; its
  declaration does not move.

## Out of scope

- **The plural.** N controller nodes, multi-input `MidiManager`, settings
  migration, generic Patch Bay node. D-022 refuses it until a second keyboard
  exists.
- **Shipping a second profile.** Device data for hardware nobody here owns.
- **D-018's Learn arbiter.** It refactors `ControlBindingManager` and its owner
  name must become `controller:<profileId>` — but implementing it is its own
  workstream, and doing it inside this one pays for both at once.
- **D-021's docked bindings bar.** Same file, different question.
- The pad function labels and the faceplate decoration (`ui/miniLabControlSurface.js`).
  They need a format field, and one device cannot say what that field should be.

## Steps

- [ ] 1. Port roles read from `device.ports`. A new dependency-free resolver
      scores a port name against the loaded profile; `midi/minilab.js` becomes a
      caller of it, keeping its exported names so nothing else moves.
      Check: `npm test` — `hardwarePersistence.test.mjs` and
      `midiInputSelection.test.mjs` unchanged, and a new test where a profile
      with different port names selects the right input.
- [ ] 2. `decodeMiniLabControl()` asks the resolver instead of importing
      `midi/minilab.js`. The decoder becomes copyable verbatim, which is what
      spec §3.5 asks and Étape A left owed.
      Check: the frozen corpus passes **unchanged**.
- [ ] 3. The controller node's identity comes from the loaded profile.
      `MINILAB_NODE_ID` keeps its value and its declaration; what changes is that
      the module reads it from the profile and a test pins the two equal.
      Check: `npm test` + `npm run check`, and
      `test/projectCompatibility.test.mjs` still opens the old project whole.
- [ ] 4. `isCanonicalMidiIngress` accepts the controller node rather than one id;
      the three sequencer error messages stop naming the device.
      Check: `sequencer*.test.mjs`, plus a test where a controller with another
      profile id is a legitimate recording source.
- [ ] 5. The header names the connected device from the profile.
      Check: new test — with a fixture profile named otherwise, the header says
      that name and no `ui/` file contains a device name as a string.
- [ ] 6. A second profile as a **test fixture** proves the machinery is
      device-agnostic: different port names, different control ids, different
      layout, its own small corpus.
      Check: the fixture decodes its own corpus, and the MiniLab corpus is
      untouched by its presence.

## Fallback point

Commit `8efe6a7` on `master` — Étape A finished, 631 JS tests, 12 check rules,
3,954 native checks.

## Done when

- `npm test` and `npm run check` green;
- `npm run sync:dist` run, provenance test green;
- the MiniLab corpus passes **unchanged**, and the fixture profile decodes its
  own;
- `test/projectCompatibility.test.mjs` still opens the pre-profile project with
  every cable, position, instance and binding;
- no file under `src/renderer/js/core/` or `src/renderer/js/ui/` names a device;
- the application launches, and its MIDI input selection still picks the MiniLab
  when the MiniLab is what is plugged in — verified in the real application,
  because port selection is exactly what `npm test` cannot see.

## Log

2026-09-04 — Plan written. Étape B of the specification was **not** taken as
written: D-022 splits it, keeps the half that has a user, and refuses the plural
until a second keyboard exists. The author confirmed the same day that he owns
one controller.
