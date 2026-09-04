# PLANS.md — how an execution plan is produced

An **ExecPlan** is a living working document for a task that does not fit inside
one session. It lives in `plans/active/`, it is **updated during** the work, and
it moves to `plans/done/` when the task is finished.

It replaces neither [ROADMAP.md](ROADMAP.md) (the *what*, at project scale) nor
[ARCHITECTURE.md](ARCHITECTURE.md) (the *how*, at code scale).

---

## 1. When to write a plan — and when not to

**Write a plan if at least two of these are true:**

- the task touches more than five files, or more than one process (renderer,
  main, native);
- it does not finish inside a single working session;
- it is reversible only at the price of a `git revert` (moving code, changing a
  persisted format, renaming an identity);
- it crosses an ARCHITECTURE §13 invariant or a [DECISIONS.md](DECISIONS.md)
  entry.

**Do not write a plan** for a local fix, adding a test, a rename inside one
file, or any task whose description fits in one sentence and whose verification
fits in one command. A plan for that is noise you then have to maintain.

## 2. Rules

- **One active plan at a time.** `plans/active/` holds zero or one file. Two
  simultaneous workstreams on this project means two unfinished workstreams.
- **The plan is alive.** Every finished step is ticked in the file, with the
  command that proved it. A plan written once and never reopened served no
  purpose: it is the file you reread after a `/clear`, a crash, or three days
  away.
- **One step = one mechanical check.** If you cannot write the command that
  proves a step is done, the step is badly cut.
- **The plan does not re-describe the architecture.** It *points* at the
  relevant sections. A plan that copies ARCHITECTURE.md will be wrong before the
  workstream ends.
- **What is out of scope is written down.** This is the section that stops a
  three-day workstream becoming a three-week one.
- **Finished means moved.** `git mv plans/active/X.md plans/done/X.md`, with the
  result line filled in. Nothing stays in `active/`.
- **An abandoned plan also goes to `done/`**, with the result "abandoned" and the
  reason. What did not work is worth as much as what did.
- **So does a plan put on standby**, with the result "standby", who it waits on,
  and — this is the part that matters — **what in it has gone stale** while it
  waited. A plan parked with no such note is worse than no plan: it reads as
  ready and is not. The slot is for the work in progress, not for intentions.

## 3. Required structure

The file name is a lowercase `slug` describing the task:
`plans/active/split-nodeinstances.md`.

```markdown
# <Title> — ExecPlan

**Goal** — one sentence. What will be true at the end and is not true today.
**Origin** — ROADMAP §N, or the reason that started the workstream.
**Status** — in progress | blocked (on what) | finished YYYY-MM-DD | abandoned (why)

## Context
The files involved, the ARCHITECTURE.md sections to reread, the DECISIONS.md
entries the task comes near. Nothing else.

## Constraints
What must not move: invariants crossed, persisted formats, public APIs. One
constraint per line.

## Out of scope
What this plan will not do, and will be tempting. Name it explicitly.

## Steps
- [ ] 1. <precise action, one file or one coherent group>
      Check: `<command>`
- [ ] 2. …

## Fallback point
The commit or branch to restart from if the workstream goes wrong.

## Done when
The full list of green commands (see AGENTS.md §8), plus the criteria specific
to this task.

## Log
YYYY-MM-DD — what was done, what was surprising, what changed in the plan.
```

## 4. Cutting the steps

A step is good when it leaves the repository **green**: `npm test` and
`npm run check` pass at the end of every step, not only at the end of the plan.
A workstream that cannot be cut that way needs a preparatory step first, one
that makes it possible — typically, adding the tests that lock the current
behaviour before moving anything.

State the action, not the intention: "extract `createDisposers()` into
`core/disposers.js` and use it in the nine listeners of `mount()`" rather than
"clean up listener handling".
