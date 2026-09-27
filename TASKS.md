# Tasks in progress

Only work that has started and is not finished — plus, listed apart, the problems
the author has asked to keep here until he takes them up. **When a task is
finished, delete its entry**, in the same commit. What was done lives in git and
[ROADMAP.md](ROADMAP.md), and so does the rest of what has never been started.

**Nothing waits here for the author to try it** (his word, 2026-09-27): what is
built and checked by the tests is done; if something does not work, he says so.

## Started, not finished

Nothing.

## Kept for the author, not started

**Splice's Expression reads 0.85 through `parameters` while the saved plugin
state holds 1.0** — seen through the agent channel. Narrowed on 2026-09-27,
not explained: Expression is linear (0.85 displays 85%), the saved state
holds it as `i_expression` in Splice's own XML and follows the parameter, and
with no instrument loaded 1.0 saved comes back 1.0 after a reload. So the gap
needs an instrument loaded; the likely cause is the instrument, loading after
the state, setting its own Expression. Checking it takes a project with a
Splice instrument in it, or loading one — both the author's to allow.

