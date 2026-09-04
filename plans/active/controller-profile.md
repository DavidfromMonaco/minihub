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

- [ ] 1. Profile schema + validator + conformance corpus, as new files, wired to
      nothing yet. The corpus is recorded MIDI streams with their expected
      decoding (spec §3.5).
      Check: `npm test`
- [ ] 2. `profiles/minilab-3.json` reproducing the 25 sources exactly, with a
      test asserting the loaded profile equals `MINILAB_CONTROL_SOURCES` field
      for field.
      Check: `npm test` — the equivalence test must fail if one CC is changed.
- [ ] 3. `MINILAB_CONTROL_SOURCES` derives from the loaded profile, keeping its
      exported shape. No consumer touched.
      Check: `npm test` + `npm run check`
- [ ] 4. `decodeMiniLabControl()` driven by the profile, still additive.
      Check: `npm test`, plus the corpus giving identical results before/after.
- [ ] 5. Bindings validated against the profile; a binding whose profile is
      absent is **kept**, not dropped (spec §6.1).
      Check: new test — a binding with an unknown profile survives a
      save/load cycle.
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
