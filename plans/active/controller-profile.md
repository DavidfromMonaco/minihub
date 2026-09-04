# Controller profile — ExecPlan

**Goal** — The MiniLab 3 is described by a declarative profile file that the
application loads, instead of a JavaScript literal welded into
`midi/minilabControls.js`. Nothing about the product changes; the hardware stops
being code.

**Origin** — `MINIHUB_CONTROLLER_PLATFORM_SPEC.md` Étape A · [DECISIONS.md](../../DECISIONS.md)
D-020 · [INTENT.md](../../INTENT.md) §5 ("a hardware identifier rooted in the core
is a defect") and §8 ter.

**Status** — in progress · started 2026-09-04.

## Context

`src/renderer/js/midi/minilabControls.js` is 67 lines and already *is* a
profile: 25 frozen control sources, three lookup maps built from them, and
`decodeMiniLabControl()`. Converting it invents nothing.

Files that consume it, and therefore define the contract that must not move:
`core/controlBindings.js` (417 lines), `core/controlRouting.js`,
`core/nodeInstances.js`, `modules/minilab/minilabModule.js`,
`ui/miniLabControlSurface.js`, plus `test/controlRouting.test.mjs` and
`test/miniLabSurface.test.mjs`.

Hardware geometry currently lives in `core/nodeGeometry.js`:
`MINILAB_NODE_HEIGHT = 166`, `PORT_ROW = 30`, `PAD_BOTTOM = 12`, and a literal
branch `if (node.id === MINILAB_NODE_ID) return MINILAB_NODE_HEIGHT;`.

`src/renderer/js/midi/parseMidi.js` is 78 lines with no dependency and is the
piece the site Builder will later copy verbatim (spec §3.5). It is not modified
here, only kept shareable.

Sections to reread: spec §3.2 (immutable ids), §3.3 (empty migration), §3.4
(`confidence`), §4 (the format), §6.1, §6.7, §9. ARCHITECTURE §13 invariants 6
and 7. DECISIONS D-008, D-019, D-020.

## Constraints

- **No existing project moves.** `profileId` stays `minilab-3`, control keys stay
  `k1`/`f2`/`p3`/`pitch-bend`, port ids stay `control-k1`, binding keys stay
  `minilab-3:k1`, and the network node id stays `minilab-3`. Spec §3.3 — this is
  why the reference profile is named this way and not `arturia.minilab3`.
- **Decoding stays additive** (spec §6.7): K1 routed to CONTROL must still leave
  CC 74 on its native MIDI path.
- Invariant 7: a system node identifier comes from `core/systemNodes.js`.
- Invariant 6: a project key is declared once, in `core/projectKeys.js`.
- A profile carries only scalars, arrays and objects (D-020). No function, no
  script, no system path, no URL, no callback.
- Invariant 11: `npm run sync:dist` after every step touching `src/`.
- The four pre-existing `C4996` warnings in `midi_network.cpp` are **not** this
  plan's to fix. They are ROADMAP work with their own commit.

## Out of scope

Named explicitly, because each will be tempting once the format exists:

- **any second controller.** Étape B. This plan changes no behaviour and adds no
  device.
- **the site Builder.** Étape C, separate codebase, and it comes after this.
- **the shared profiles folder.** Étape D.
- **multi-input `MidiManager`**, generic Patch Bay node, N controller nodes.
- **the Matrix.** On standby; see `plans/done/noeud-matrix.md` and the two points
  in it this plan makes stale.
- inventing profile fields no consumer reads yet. The format describes the
  MiniLab 3 as it is, and grows when a second device proves it must.

## Steps

- [x] 1. Profile schema + validator + conformance corpus, as new files, wired to
      nothing yet. The corpus is recorded MIDI streams with their expected
      decoding (spec §3.5).
      Check: `npm test` — 612 green (590 + 22), `npm run check` 9 rules clean.
      Both new tests probed: a single CC changed in the declaration fails the
      corpus, and disabling the dangerous-string scan fails the malicious-profile
      test.
- [x] 2. `profiles/minilab-3.json` reproducing the 25 sources exactly, with a
      test asserting the loaded profile equals `MINILAB_CONTROL_SOURCES` field
      for field.
      Check: `npm test` — the equivalence test must fail if one CC is changed.
      618 green. Probed twice: K1's CC 74 changed to 75 fails the equivalence
      test, and one knob moved by a pixel fails the layout test.
- [x] 3. `MINILAB_CONTROL_SOURCES` derives from the loaded profile, keeping its
      exported shape. No consumer touched.
      Check: `npm test` + `npm run check` — 618 green, 9 rules clean, and the
      packaged application launched to prove the JSON module actually loads in
      Chromium. Probed: K1's CC changed inside the profile fails six tests across
      three files, two of which predate this workstream.
- [x] 4. `decodeMiniLabControl()` driven by the profile, still additive.
      Check: `npm test`, plus the corpus giving identical results before/after.
      621 green, 9 rules clean, and the 94 frozen corpus cases passed **without
      being touched**. Probed: K1 pinned to channel 1 in the profile fails three
      tests, the corpus among them.
- [x] 5. Bindings validated against the profile; a binding whose profile is
      absent is **kept**, not dropped (spec §6.1).
      Check: new test — a binding with an unknown profile survives a
      save/load cycle. 625 green, 9 rules clean, application relaunched. Both
      halves probed separately: restoring the membership check fails all four new
      tests, removing the `missing-target` branch fails only the status one.
- [ ] 6. `layout` moves from `core/nodeGeometry.js` into the profile;
      `MINILAB_NODE_HEIGHT` and the `node.id === MINILAB_NODE_ID` branch go.
      Check: `npm test` + `npm run check`
- [ ] 7. Three `npm run check` rules: `profile is data`, `immutable control ids`,
      `no hardware literal`.
      Check: each rule must fail on a deliberate probe, then pass once removed.
- [ ] 8. Finish D-008 on the C++ side: `native/audio-engine/src/midi_output.h:49`
      hard-codes `id == "minilab-3"` in `isPhysicalMidiDestination()`.
      Check: `npm run build:native` + the four native binaries.
- [ ] 9. Remove the literal. `midi/minilabControls.js` becomes a thin loader.
      Check: the full list under "Done when".

## Fallback point

Commit `011097a` on `master` — the state before this plan, with 590 JS tests and
3,952 native checks green.

## Done when

- `npm test` and `npm run check` green, with the ~30 new tests spec §9 asks for;
- `npm run sync:dist` run, provenance test green;
- `npm run build:native` with no **new** warning, and the four native binaries
  green;
- the profile reproduces the 25 sources identically;
- **no existing project modified** — `Saves/Duo Nappe Arpeggios.minihub` opens
  with its 4 cables, 4 node positions and 2 instances, exactly as it does today;
- a malicious profile (script, URL, system path, prototype pollution) is refused
  field by field;
- a profile with an unknown `formatVersion` is refused without touching any
  project.

## Log

2026-09-04 — Plan written. Gate crossed by D-020, INTENT §8 ter. The Matrix plan
was moved to `plans/done/` unstarted (0 of 23 steps) to free the single active
slot; it waits on the author, and two of its points are already stale — see the
note added at its head.

2026-09-04 — Step 1 done. Three new files:
`src/renderer/js/midi/controllerProfile.js` (the schema, the validator, and
`computeCompleteness`, importing nothing so it can be copied verbatim into the
Builder), `test/conformance/midi-corpus.json` (94 recorded cases), and the two
tests that run them.

Four things the code said that the specification did not, all of them affecting
later steps:

- **The decoder ignores the MIDI channel for a CC.** `decodeMiniLabControl()`
  looks the controller number up in one flat map; K1 on channel 16 decodes as
  K1. The format's `when` carries a `channel`, so a profile-driven decoder that
  honours it would be a **behaviour change**, not a port. Corpus case
  `k1-channel-16` locks today's answer. Step 4 has to decide deliberately, and
  either way the case has to be updated with a reason.
- **`family` for the main encoder is `main`, not `encoder`.** Spec §4.3's
  example says `encoder`; `ui/miniLabControlSurface.js` switches on `family` to
  choose a shape, so the reference profile keeps `main` or the surface changes.
  §4.1 wins over the example.
- **`semantics` has no one-to-one mode.** `momentary-or-toggle` and
  `velocity-momentary-pressure` describe the *set* of modes a control carries,
  not a single one. Step 3 derives semantics from the set, not from a lookup.
- **`completeness` cannot add up.** The four counters §4.5 names have no slot for
  `documented`, so `observed + inferred + untested ≤ declared`. Implemented as
  specified, with the gap written into the function's comment rather than
  silently patched with a fifth counter.

Two decisions taken inside the step, both narrower than they look: the corpus
lives in `test/conformance/` rather than under `src/` (the application never runs
it, and shipping test data in `dist/` buys nothing — the Builder copies the file
from there), and the validator **refuses unknown fields** instead of ignoring
them, which is what makes `formatVersion` mean something.

2026-09-04 — Step 2 done. `src/renderer/js/midi/profiles/minilab-3.json`, 25
controls, `completeness` computing to exactly the figures spec §4.5 prints as its
example. `test/minilabProfile.test.mjs` holds it against the literal.

The path is under `src/renderer/js/midi/`, not the repo root the step line
suggested: step 3 loads it from the renderer, and `sync:dist` ships the `src/`
tree as it stands. A repo-root `profiles/` would need a second copy rule.

Four judgement calls, each of which could have gone the other way:

- **One layer, `default`, labelled "Any mode".** Today's decoder is layer-blind:
  every declared CC is accepted whatever mode the device is in. Splitting the
  alternates into `daw`, `arturia`, `user` would have described a device nobody
  here has observed — the main encoder has four CCs, so it would have been three
  guesses dressed as facts. Layers arrive when someone watches the device change
  mode, and §3.2 lets a revision **add** them without moving a single id.
- **`confidence`**: the message a control sends out of the box is `observed`; the
  alternates in the literal came with no record of where they were read, so they
  claim `inferred`. A test asserts exactly one observed binding per control, so
  nobody can quietly promote a guess.
- **`main-click` gets mode `toggle`**, which the projection maps back to the
  legacy `momentary-or-toggle`. Whether that button latches is a device setting,
  not a property of the message — the format has no word for "either", and
  inventing one for a single control would have been worse than the shim.
- **`layout` carries the control position**, not the port position. The offsets
  in `miniLabPatchPortPosition()` (+15 on a knob, +24 on F2 and F4) stay in code
  until step 6 decides whether they are layout or drawing.

Also worth knowing before step 3: **nothing in `src/` reads `semantics`** except
`minilabControls.js` itself. Only `controlRouting.test.mjs` asserts the strings.
The projection is therefore a compatibility shim over a field with no behaviour
behind it, which is why a five-entry lookup was acceptable where a new profile
field would not have been.

2026-09-04 — Step 3 done. `midi/minilabControls.js` imports the profile and
derives the 25 sources; the maps, the helpers and `decodeMiniLabControl()` are
untouched. No consumer changed, no test changed except the one that used to hold
the profile against the literal.

**The literal is gone now, not at step 9.** Deriving a constant and keeping the
hand-written version of it are mutually exclusive; there is no state where both
exist and one of them is the source. What step 9 still has to do is smaller than
it reads: turn the file into a thin loader once the decoder (step 4) and the
layout (step 6) have also left it.

Which raised the real question of the step: **once the sources come from the
profile, what does the equivalence test compare against?** Comparing the
derivation to the profile it derives from proves nothing. So the 25 sources were
recorded as `test/conformance/control-sources.json` *before* the change — what
the application said on 2026-09-04 — and that recording is now the guard. It
keeps biting through steps 4 to 8, where the literal would have been deleted and
forgotten.

Three smaller things:

- **The JSON module import was verified in the real application, not only in
  Node.** `import profile from './profiles/minilab-3.json' with { type: 'json' }`
  is a Chromium question as much as a Node one, and `npm test` cannot answer it:
  a module the renderer's CSP refuses fails silently as far as the suite is
  concerned. `app.js:13` imports `controlRouting.js`, which imports this file, so
  a failed import takes the whole renderer down. The packaged application was
  launched: it booted, reached `syncMidiNetwork` and `syncAudioNetwork`, and
  logged not one error-shaped line.
- `decodeMiniLabControl()` looked the pitch strip up by the literal string
  `'minilab-3:pitch-bend'`. It now goes through a key map. One fewer identity
  spelled out in code, and one fewer thing for step 7's `no hardware literal`
  rule to have to forgive.
- `sourceNodeId` still comes from `MINILAB_NODE_ID` (invariant 7) while the
  source ids are built from `profile.profileId`. A test pins the two equal, which
  is what keeps that asymmetry honest until Étape B makes the node id come from
  the profile for real.

The built-in profile is **not** validated at launch. It ships with the
application and a test holds it against the format; validating it on every start
would buy a guarantee already bought. A profile from anywhere else goes through
`validateControllerProfile()` — that is what step 5 is about.

2026-09-04 — Step 4 done, and it needed the arbitration the step 1 log asked
for. The author's answer: **`when.channel` becomes optional, and absent means
any channel.** He has never used MIDI channels, which is the common case, and the
third option was the only one that lets the profile describe the decoding rather
than contradict it.

The rule that follows is mechanical, and a test enforces it: **a channel is
declared exactly where the decoding enforces one.** On the MiniLab 3 that is the
pads, on channel 10, and nowhere else — 44 channels dropped from the profile, 16
kept. Written anywhere else, a channel would silently stop a control from
answering the day someone moves the keyboard's global channel.

No `formatVersion` bump. Making a required field optional accepts every profile
that was valid a minute earlier, and no profile exists outside this repository
yet.

The decoder is now an index — `kind:number` to the controls that answer it, with
the channel tested only where a binding names one. Two things worth knowing:

- **`polyaftertouch` maps to the profile kind `note`.** A pad struck, released
  and leaned on is one control and one binding; the phase goes in the result, not
  into three declarations. The `polyaftertouch` kind stays in the format for a
  device that uses aftertouch as a control of its own, which this one does not.
- The order of the old three-branch decoder (pitch bend, then CC, then note) no
  longer matters, because the message type selects the kind and the kinds are
  disjoint. That was worth checking rather than assuming: CC 102 is a pad's
  pressure, and it used to be caught by the CC branch before the note branch ever
  ran.

**The acceptance criterion was the corpus, and the corpus was not touched.** The
94 cases recorded at step 1 — before any of this existed — pass unchanged
against a decoder that now reads a JSON file. That is the whole point of having
frozen them.

**What is still not proven**: no physical MiniLab was moved to another global
channel during any of this. The corpus is a recording, not the device.

2026-09-04 — Step 5 done. The one step of this plan that repairs something
rather than moving it.

`normalizeControlBinding()` no longer asks whether a binding's control exists. It
asks whether the key is well formed — `<profileId>:<controlId>`, both
identifiers — and nothing else. Belonging is resolved at use, against the profile
actually loaded, and a binding that resolves to nothing is **kept**, reported
`missing-target`, and refused by `route()`. Kept is not obeyed.

The failure this closes was not hypothetical. Bindings live in the `.minihub`
file. Profile missing for any reason → every binding it names dropped in silence
on load → the next save writes the file without them. The test therefore does the
whole cycle, including the save, because the load alone never lost anything: it
is the write afterwards that made it permanent.

Two changes that look smaller than they are:

- **`isProfileIdentifier()` is exported from `controllerProfile.js`**, and
  `controlBindings.js` composes the binding key from it. The alternative was a
  second regular expression in a second file, and its drift would have been
  silent in the worst possible way — a key accepted by one side and refused by
  the other is a binding that disappears.
- **An identifier is now bounded at 64 characters.** It was bounded only by the
  200-character limit that applies to every string, and a persisted key has to be
  bounded more tightly than free text. No `formatVersion` bump, for the same
  reason as step 4: nothing outside this repository holds a profile yet.

`bindingStatus()` gained its new case **before** the `disconnected` one, which is
a correction and not only an addition: an unresolvable source used to be reported
as disconnected, telling the user to plug in a cable for a control that cannot be
plugged in at all.

**Out of scope, and named because it will look like an omission**: the interface.
`renderControlBindings()` walks the loaded profile's controls, so a kept orphan
is invisible rather than shown as `missing-target`. With one built-in profile
that cannot go missing, there is nothing to display today; the orphan needs a
place on screen only when a profile can really be absent, which is Étape B.
