# One other controller — ExecPlan

**Goal** — MiniHub works with a controller that is not a MiniLab 3, one at a
time. A friend writes a profile for his own keyboard and uses the application;
nothing in `src/` assumes which device is plugged in.

**Origin** — [DECISIONS.md](../../DECISIONS.md) D-022 · [INTENT.md](../../INTENT.md)
§8 quater · `MINIHUB_CONTROLLER_PLATFORM_SPEC.md` §4.2, §6.4, §6.5 · the closing
entry of [plans/done/controller-profile.md](../done/controller-profile.md), which
named the decoder's remaining dependency on `midi/minilab.js`.

**Status** — steps 1 and 2 of 6 done.

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

- [x] 1. Port roles read from `device.ports`. A new dependency-free resolver
      scores a port name against the loaded profile; `midi/minilab.js` becomes a
      caller of it, keeping its exported names so nothing else moves.
      Check: `npm test` — `hardwarePersistence.test.mjs` and
      `midiInputSelection.test.mjs` unchanged, and a new test where a profile
      with different port names selects the right input.
- [x] 2. `decodeMiniLabControl()` asks the resolver instead of importing
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

2026-09-04 — Step 1 done. `src/renderer/js/midi/portRoles.js` is the new
dependency-free resolver; `midi/minilab.js` keeps its three exported names and
holds nothing but the binding to the profile that ships. 646 JS tests (13 new in
`test/portRoles.test.mjs`), 12 check rules, `sync:dist` run.

Four things the step decided that the plan did not say:

- **The specification does not define how `match.name` is compared**, and
  equality is the wrong answer. Windows hands the same physical port back as
  `Minilab3 MIDI` on one machine and `MIDIIN2 (Minilab3 MIDI)` on another, and
  the same device is spelled `Minilab3` by its driver and `MiniLab 3` by its
  manual. The rule is therefore: the physical name CONTAINS the declared one,
  both lower-cased with whitespace removed. What it refuses is a fallback — a
  port no declaration matches belongs to no profile, with no fuzzy resemblance
  to the vendor or the model string, because a fallback is the old regular
  expression coming back one device at a time. A profile may declare its own
  catch-all if its author wants one; the longer declaration wins, so a catch-all
  never swallows a specific port.
- **`priority` cannot express "never", so `role` had to be enforced
  separately.** The pass-through port declares priority 0 and so does a
  stranger's keyboard. Ranking alone therefore arms the DIN THRU port whenever
  it is the only one a machine enumerates — it is, after all, the best port
  present — which is the original bug in its quietest form: an input is
  selected, the header says connected, and no key press ever arrives.
  `bestPerformancePort()` filters by `role` first. This is a **behaviour
  change**, deliberate: specification §4.2 says a `control-surface` or `ignore`
  port is never auto-selected, no existing test pinned the old answer, and two
  new ones pin the new one.
- **The ranking left `MidiManager` entirely.** `findMiniLabInputId()` was a
  filter and a sort written in the manager; it is now one call. That is what
  lets a test drive the real selection code with a foreign profile instead of
  re-implementing the algorithm next to it — the test that proves the machinery
  is device-agnostic now fails if the machinery changes, which a copy would not.
- **`miniLabScore('Minilab3 DIN THRU')` returns 0 where it returned 1.** The
  profile says priority 0; the distinction that mattered — can this port carry a
  note — is `role` now, and nothing reads the number for that question.

`isMiniLab3Name` went with the regular expressions. It was on the ROADMAP's
"genuinely dead" list, and it was the last function whose body spelled a device
name.

One piece of evidence the tests cannot give, taken from the user's own disk
rather than from a fixture: `%APPDATA%/minilab-hub/settings.json` holds
`midiInputPreference.name = "Minilab3 MIDI"` — the port name this machine
actually saw is the one the profile declares, verbatim. The real-application
check the plan still owes is therefore not a blind one.

2026-09-04 — Step 2 done. The decoding left `minilabControls.js` for
`src/renderer/js/midi/decodeControl.js`. The frozen corpus passes **unchanged**
— `test/conformance/midi-corpus.json` is untouched, byte for byte. 654 JS tests
(8 new in `test/decodeControl.test.mjs`), 13 check rules, `sync:dist` run.

The step as written said "asks the resolver instead of importing
`midi/minilab.js`". Doing only that would have left the decoder unshareable for
a second reason the step did not name, so the extraction went further:

- **What made the decoder uncopyable was not the device name, it was the node
  id.** `decodeMiniLabControl()` returned `sourceNodeId`, `control-<id>` port
  ids and the legacy `semantics` word — MiniHub's names for the thing that
  answered, not the decoding of the message. The shared decoder returns the
  profile's own `control` and `binding` plus the numbers, and nothing else;
  `minilabControls.js` puts the four persisted names on afterwards, in nine
  lines. Swapping one import would have removed the device name and kept the
  file unshareable.
- **The corpus cannot see this boundary.** It checks the finished CONTROL event,
  so a decoder that quietly went back to knowing a node id would still pass all
  94 cases. `test/decodeControl.test.mjs` watches the seam instead of the
  result: the shared result carries none of `type`, `sourceNodeId`,
  `sourcePortId`, `sourceControlId`, `semantics`, `label`.
- **A fourth `npm run check` rule, `shared decoder`.** "Copyable verbatim" was
  prose, and the way it breaks is silent: an import that is perfectly legitimate
  here, a corpus that still passes here, and a divergence that surfaces on the
  other side of a repository boundary. The rule names the set — `parseMidi.js`,
  `controllerProfile.js`, `portRoles.js`, `decodeControl.js` — and refuses any
  import leaving it. Verified by breaking it on purpose before restoring.
  Recorded in the specification's §9 table, which had listed three rules to add
  and did not foresee this one.
- **The index is cached per profile in a WeakMap.** Deriving the `kind:number`
  table per message would rebuild twenty-five controls' worth of Map entries for
  every knob tick, and a knob sweep is a hundred messages a second. Keyed on the
  profile object, so two profiles never share a table — which is a test, because
  a coarser cache would answer the second profile with the first one's controls.

`midi/minilab.js` now has exactly one caller left, `midiManager.js`. Steps 3 to 5
are what remove it.
