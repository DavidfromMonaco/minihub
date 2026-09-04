# One other controller — ExecPlan

**Goal** — MiniHub works with a controller that is not a MiniLab 3, one at a
time. A friend writes a profile for his own keyboard and uses the application;
nothing in `src/` assumes which device is plugged in.

**Origin** — [DECISIONS.md](../../DECISIONS.md) D-022 · [INTENT.md](../../INTENT.md)
§8 quater · `MINIHUB_CONTROLLER_PLATFORM_SPEC.md` §4.2, §6.4, §6.5 · the closing
entry of [plans/done/controller-profile.md](../done/controller-profile.md), which
named the decoder's remaining dependency on `midi/minilab.js`.

**Status** — 6 steps of 6 done. One line of the Done-when is still owed:
the port selection verified with the controller plugged in.

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
- [x] 3. The controller node's identity comes from the loaded profile.
      `MINILAB_NODE_ID` keeps its value and its declaration; what changes is that
      the module reads it from the profile and a test pins the two equal.
      Check: `npm test` + `npm run check`, and
      `test/projectCompatibility.test.mjs` still opens the old project whole.
- [x] 4. `isCanonicalMidiIngress` accepts the controller node rather than one id;
      the three sequencer error messages stop naming the device.
      Check: `sequencer*.test.mjs`, plus a test where a controller with another
      profile id is a legitimate recording source.
- [x] 5. The header names the connected device from the profile.
      Check: new test — with a fixture profile named otherwise, the header says
      that name and no `ui/` file contains a device name as a string.
- [x] 6. A second profile as a **test fixture** proves the machinery is
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

2026-09-04 — Step 3 done. `MINILAB_NODE_ID` keeps its name and its declaration
in `core/systemNodes.js`; its value is now `LOADED_PROFILE.profileId`. 654 JS
tests, 13 check rules, `sync:dist` run. `test/projectCompatibility.test.mjs`
opens the pre-profile project whole, unchanged.

- **A fourth file was reading `./profiles/minilab-3.json` by path.** Which
  profile is loaded was a decision written three times — in `minilab.js`, in
  `minilabControls.js`, and about to be written again in `systemNodes.js`. It is
  `midi/loadedProfile.js` now, one line of substance, and the day the profile
  stops shipping and starts being chosen it is the file that changes rather than
  every reader. Three imports, one decision.
- **The test that guarded this identity became tautological, and had to be
  replaced rather than kept.** `minilabProfile.test.mjs` asserted
  `profile.profileId === MINILAB_NODE_ID`; with the id derived, that is the same
  expression twice. It now pins the derived value against the literal
  `'minilab-3'` and against `published-control-ids.json`, the hand-written
  register of what shipped — the node id has to be a *published* identity, not
  whatever the profile says today. Losing this quietly was the real risk of the
  step: the assertion would have kept passing forever while guarding nothing.
- **One drift `npm run check` cannot see.** The `system node ids` rule skips
  `systemNodes.js`, since that file is its owner — so writing the literal back
  in there breaks no rule. The third assertion compares `MINILAB_NODE_ID`
  against a fresh read of the profile file from disk, which is what fails if the
  constant becomes a second copy of the word and the profile is renamed later.
- **What is NOT proved, plainly.** That a profile with `profileId: 'vega-49'`
  makes the node `vega-49` is one property access evaluated at module load, and
  no test can swap it: `mock.module` needs
  `--experimental-test-module-mocks`, and adding that flag to `npm test` for one
  assertion costs the whole suite a warning and an experimental API. It is read,
  not run. Step 4 is where the same question becomes testable, because
  `isCanonicalMidiIngress` takes its node as an argument.

2026-09-04 — Step 4 done. `isCanonicalMidiIngress` asks the network what kind of
node a cable leaves instead of comparing an id. 655 JS tests, 13 check rules,
`sync:dist` run.

- **The right question was already in the codebase, under another name.**
  `midi-output` is MiniHub's word for a hardware MIDI endpoint — `network.js`
  exempts that type from cycle detection for exactly that reason, and
  `sequencerController.js` already used it to decide where to send raw MIDI. So
  ingress is `type === 'midi-output' && portId === 'midi-out'`, and no new
  marker property was invented. The port half is not tidiness: a node
  representing an external MIDI *destination* is the same type with a `midi-in`
  and no `midi-out`, and without it the sequencer would accept a cable that can
  only run the other way.
- **The same question had a second, private answer.**
  `modules/sequencer/sequencerModule.js` decided "is the input cable connected"
  with its own copy of the id comparison, so the Patch Bay summary and the
  Record button would have disagreed the day a profile changed. The predicate is
  exported and both call it. Not in the step as written; leaving it would have
  been a half-migration with no test that notices.
- **The three messages name the node, not a device.** They said "MiniLab 3",
  which is the sequencer telling someone with another keyboard to connect one he
  does not own. They now name the routing node, which is what he sees in the
  Patch Bay — and only when there is exactly one hardware MIDI source, because
  naming one of two would send him to the wrong card. The plural falls back to
  "your controller". Every render site already passes these strings through
  `escapeHtml` or `textContent`, which matters now that the text can come from a
  profile file.
- **A dead fixture node stopped being dead.** `test/sequencer.test.mjs` declared
  a `midi-source` node of type `midi-output` that nothing referenced. Under the
  new rule it is a second hardware source, which made every ingress assertion in
  the file ambiguous and the block message fall back to the generic phrase. It
  was removed rather than worked around.
- **One existing test changed meaning for the better.** "a rogue MIDI cable
  cannot impersonate the canonical MiniLab recording ingress" used an
  arpeggiator's `midi-out`; it passed before because the id did not match, and
  passes now because the type does not. Renamed to say what it actually proves.

`core/controlBindings.js` was listed in this plan's Context as a fourth place
naming the device. It is not: its three comparisons are against
`MINILAB_NODE_ID`, whose value came from the profile at step 3, and a control
cable really does leave one specific node's control port. Nothing to do there.

2026-09-04 — Step 5 done. Nothing under `src/renderer/js/core/` or
`src/renderer/js/ui/` names a device any more, and a `npm run check` rule fails
the build if one comes back. 661 JS tests (6 new in
`test/headerDeviceStatus.test.mjs`), 14 check rules, `sync:dist` run.

- **The header does not read the profile, and that is the point.** Reading
  `LOADED_PROFILE.device.model` here would have been one line and untestable —
  step 3 already had to write down that a profile-derived constant is fixed at
  module load and no test can swap it. The header asks the network what the
  controller node is called, so a fixture names a node `Vega 49` and the
  assertion is on the real code path. It also settles a second question the plan
  did not ask: the header and the sequencer's blocking messages now say the same
  string because they read the same place, and a message that sends the user to
  a card called something else is worse than a message that names nothing.
- **The step as written was one file; it was four.** Naming the header from the
  node would have changed nothing while the node's own name was the literal
  `'MiniLab 3'` in `modules/minilab/minilabModule.js` — step 4's three messages
  included, which had been reading that literal since the day they were fixed.
  The name is now `DEVICE_NAME` there, one constant, and it carries the page
  title, the nav entry, the status pill and the routing node. The Learn panel's
  instruction (`core/nodeInstances.js`, "Select an observable control on the
  MiniLab") was the fourth: it is in `core/`, it is prose the user acts on, and
  the plan's Done-when covers it even though its Context did not list it.
- **`device.model`, not the profile's `name`.** The profile is titled
  "Arturia MiniLab 3" — the file's name for itself, which may carry a vendor or a
  variant. What a status pill and a Patch Bay card have room for is the device,
  and `device.model` keeps every visible string byte-identical to what shipped
  yesterday. Both fields are required by the format, so neither can be missing.
- **`core/controllerNode.js` answers null rather than a fallback name.** Two
  hardware MIDI sources means naming one is a guess (D-022 says there is one, so
  this is the defensive branch, not the common one). The phrase is left to each
  caller: "your controller" reads as English inside the sequencer's sentence and
  as gibberish inside "No ... detected", which is why a single shared fallback
  string would have been wrong.
- **`isCanonicalMidiIngress` now expresses its node half as `isControllerNode`.**
  Same shape, one definition. The stricter form — the node must DECLARE a
  `midi-out`, not merely be of type `midi-output` — changes no behaviour, and
  `Network.connect()` is why: it refuses a connection from a port the node does
  not declare, so no connection in any network can distinguish the two.
- **A fourteenth check rule, `device name out of the shell`.** Its words come
  from the shipped profiles, so it follows a profile rather than a list someone
  maintains. What makes it exact is punctuation: once `_` and `-` count as word
  characters, `MINILAB_NODE_ID`, `minilab-control-surface` and
  `data-minilab-control-id` are single tokens and pass untouched, while prose
  puts spaces around the device and does not. One subtraction, and it is not an
  exception: MiniHub's own names contain the device's for historical reasons
  (AGENTS.md §2), so `MiniLab Hub` is removed from a line before it is read.
  Verified by breaking it on purpose — both a model and a vendor — before
  restoring. The faceplate file the plan puts out of scope needed no exemption,
  which is the sign the boundary is the right one.
- **What is NOT proved.** That the *shipped* build follows a *different* profile
  is still one property access at module load. `test/headerDeviceStatus.test.mjs`
  asserts the end of the chain twice instead — against the literal
  `'MiniLab 3 connected'`, which says what a user sees in this build, and against
  `${LOADED_PROFILE.device.model}`, which says where it comes from. The fixture
  tests are what prove the machinery is device-agnostic; these two are what fail
  if a name is hardcoded back in or a profile is edited without anyone noticing
  the whole shell follows it. The application has not been launched for this
  step; the plan's real-application check remains owed at the end.

2026-09-04 — Step 6 done. `test/conformance/vega-49.json` is a controller nobody
owns, with `vega-49-corpus.json` beside it: 27 cases, 13 of them refusals. 674 JS
tests (13 new in `test/deviceAgnostic.test.mjs`), 15 check rules, `sync:dist`
run. The MiniLab corpus is untouched, byte for byte — `git diff` on
`midi-corpus.json` is empty, and the interleaved test says the same thing at
runtime.

- **The fixture is built to be unlike, and one collision is deliberate.** Other
  port names, other control ids, another layout box, pads on another channel —
  and CC 74, which is the MiniLab's K1, so that "the profile decides, not the
  number" is an assertion rather than a hope. A test guards the unlikeness
  itself: the day someone edits the fixture to resemble the shipped profile, the
  proof weakens silently, and that test is what makes it fail instead.
- **It exercises five things the shipped profile never has.** Two layers with a
  control emitting a different message on each (spec §4.3, the correction the
  format exists for, unexercised until now); a binding on layer `*`; a
  `control-surface` port ranked ABOVE a performance port, so role and priority
  cannot be mistaken for one another; a catch-all port declaration; and a
  control with no binding at all, which is what makes `completeness.untested` a
  counter rather than a constant. A format is only as tested as its widest
  profile, and the widest one was 25 knobs of the same shape.
- **The fixture found two gaps, and the corpus records them out loud.** `cc14`
  and `channelpressure` are declarable kinds with no decoding path — a profile
  can declare a 14-bit fader and MiniHub answers nothing, silently. `mode` and
  `range` are validated and read by nobody: a `relative` encoder decodes as an
  absolute byte. Neither is fixed here (that is new behaviour, not this
  workstream), and neither is left to be discovered by whoever plugs in the
  first encoder: they are corpus cases whose `why` says what they are, plus a
  coverage test that fails the day cc14 starts decoding.
- **The expectations were computed from the rules, never from the decoder.** A
  corpus generated by running the code under test proves that the code equals
  itself. Every value here comes from the byte layout and the normalisation
  rules of the specification; the generator is not committed, so nobody can
  "regenerate to make it pass".
- **The proof was mutation-tested, because a test that has never failed is a
  claim.** Two deliberate breakages: ranking ports before filtering by role, and
  caching one decoder index across profiles. The first fails one test. The
  second — the cross-profile bug — passes the fixture corpus run on its own and
  fails only the interleaved test, which is precisely why that test interleaves.
- **A fifteenth check rule, `one profile ships`.** The plan's constraint was
  prose: exactly one profile in `src/`, a second one only as a fixture. The rule
  reads which file `loadedProfile.js` imports and refuses both a stranger in the
  profiles directory and a loader pointing at a file that is not there. Verified
  by shipping the fixture on purpose.
- **That experiment exposed a false positive in step 5's rule, and it was worth
  more than the experiment.** With the fixture shipped, "device name out of the
  shell" flagged the word `instruments` in `vstChain.js` — because the fixture's
  vendor is "Nebula Instruments". A vendor whose name contains an ordinary
  English word would have turned an exact rule into one everyone learns to
  ignore, on the day a second controller ships and nobody is looking. A
  multi-word vendor is now matched WHOLE and never word by word; the model is
  still matched word by word, which is what catches the shorthand "the MiniLab".
  Rechecked afterwards on all four shapes: model word, vendor word, and both
  full names as phrases.
- **The application was launched.** It runs from `dist/`, the header says
  "No MiniLab 3 detected", the sidebar entry and the page title say "MiniLab 3",
  and the MIDI input list offers "Minilab3 MIDI (preferred — unavailable)" —
  every one of those strings arriving from the profile through the routing node.
  What is NOT verified is the other half of the last Done-when line: no MIDI
  input was enumerated at all, because the controller is not plugged into this
  machine right now. Port selection with the hardware present is the one thing
  this workstream still owes, and it stays owed rather than being called done.
