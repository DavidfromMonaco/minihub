# Cleanup pass 2 — progress record

Working record for the second audit/refactoring pass. One commit per completed
pass, so an interrupted session can resume from the last green commit.

## Baseline (commit `6ee0b5e`)

- 183 JS tests passing (`node --test "test/*.test.mjs"`)
- native Release engine builds clean, zero warnings (`--clean-first`)
- app launches: engine handshake OK, 47 VST3 plugins scanned, 9 audio devices,
  persisted chain rebuilt automatically, clean shutdown, no orphan processes

## Passes

| # | Scope | State |
|---|-------|-------|
| 0 | Baseline: tests, native build, real app launch | done — `6ee0b5e` |
| 1 | Node identity vs visible naming (lowest free ordinal); creation/copy/paste parity | done |
| 2 | Single authoritative deletion path; listener/lifecycle consolidation | done |
| 3 | Central engine state; remove duplicate IPC and redundant module workarounds | done |
| 4 | Native C++ conservative cleanup + RT safety re-check | done |
| 5 | MIDI all-notes-off on disconnect / route loss / chain deletion | done |
| 6 | Dead code, CSS, comments, README, persisted-settings schema | done |
| 7 | Full regression verification + final report | pending |

## Rules for this pass

- No redesign, no new features, no new dependencies.
- Every change must have a concrete, stated benefit.
- Stable internal IDs stay unique forever; visible ordinals are display-only.
- Preserve the MiniLab -> VST3 -> Audio Output vertical slice.
