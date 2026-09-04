# INTENT.md — what MiniHub must be, and must not become

This document does **not** describe the code. It describes the intent the code
must obey, and above all the directions it must not drift in.

An agent reads this file **before** proposing anything. A technically good
proposal that contradicts this document is a bad proposal.

When this document and an attractive idea collide, this document wins — or it is
changed explicitly, with its reason, and [DECISIONS.md](DECISIONS.md) records the
change once the code is written.

---

## 1. In one sentence

MiniHub is a **musical sandbox** built around the Arturia MiniLab 3 controller,
where the wiring of a Patch Bay — and not the interface on screen — decides what
you hear.

## 2. Who it is for

**One user: its author.** Every decision is settled in favour of that use, on
that machine. There is no hypothetical user whose needs must be anticipated.

**A conditional horizon of sharing.** If the product becomes good enough to be
worth something to other people, it may be distributed. That is neither a goal
nor a deadline: it is a possibility kept open. The one practical consequence,
and the only one: **do not hard-code what is specific to this machine** —
absolute paths, device names, plugin identifiers, personal directories.
Everything else about distribution (installer, first run, licensing) is **out of
scope until the decision is made**.

Do not confuse this with "preparing for distribution". Adding installation,
update or onboarding machinery today would be working for a user who does not
exist.

## 3. The two uses that define the product

MiniHub must hold **both at once**. A proposal that serves one by degrading the
other is to be rejected or rethought.

| Use | What it demands |
|---|---|
| **Finish a complete track** | The sequencer, recording and export must be solid and faithful enough to finish a track with no other software. Exact timing, export without surprises, projects that reopen intact. |
| **Play generative music live** | The network must stay editable while sound is running. No routine operation may force an audio dropout, a reload, or a state rebuilt by hand. |

The tension between the two is the heart of the architecture: it explains the
topology/values split ([DECISIONS.md](DECISIONS.md) D-004), the append-only VST
chains that outlive plans, and the absolute ban on blocking the audio thread.

## 4. What MiniHub is

- A **Patch Bay** where nodes are joined by typed cables, and where the network is
  the sole routing authority.
- A native **VST3 host**: serial chains, native editors, persistent plugin state.
- A **sequencer** for sample-accurate MIDI + audio arrangement, with recording,
  multi-format export and a clip editor.
- A set of **processing nodes**: Mixer, Morpher, Arpeggiator.
- **Control learning** that binds physical knobs and pads to VST3 parameters.

## 5. The hardware: the MiniLab is the reference, not a cage

The MiniLab 3 is the **reference use case**: it is what gets modelled, drawn and
tested, and it is what trade-offs are settled against.

But the architecture must **not make a second controller impossible**. A hardware
identifier rooted in the core of the network is a defect, not a simplification —
that is what [DECISIONS.md](DECISIONS.md) D-008 fixed on the JS side and has not
finished fixing on the C++ side.

The distinction not to cross: **not making it impossible ≠ generalising now.**
Writing an abstraction layer for controllers that do not exist in this project is
speculative work.

**Windows is final.** WASAPI, the Windows VST3 format, `%APPDATA%`, `rcedit`
stamping: these are commitments, not debt. Any cross-platform abstraction
proposed "just in case" is to be refused.

## 6. What MiniHub is not, and does not become

- **Not a multi-user product.** No accounts, no user profiles, no sync, no
  sharing of projects between machines. Controller profiles are the single
  exception, and they are shared as files — see §8 ter.
- **Not a service.** Startup depends on no server, no database, no account. The
  application must stay fully usable offline (see §7), and the companion site is
  never a runtime dependency.
- **Not a platform extensible by code.** No in-house plugin system, no user
  scripting language, no public API, no callback of any kind. The plugins are
  VST3. Extension by **declarative data** — one controller profile — is allowed,
  and nothing beyond it; see §8 ter.
- **Not a project with dependencies.** The absence of a bundler, a framework and
  any runtime dependency is a choice of identity, not technical lag
  ([DECISIONS.md](DECISIONS.md) D-003).
- **Not a DAW clone.** A feature is never justified by "other DAWs have it". It
  is justified by one of the two uses in §3.

**Out of scope by default**: sends, sidechains, minimap, undo/redo, automatic
network layout, node groups. The `video` and `image` node types exist in the
registry with empty ports; **nothing must implement them** until this line
changes.

The refusal is not permanent on principle: it is permanent **by default**.
Lifting one of these is done here, explicitly, with its reason — as preset
management was in §8, and automation in §8 bis.

## 7. The internet: allowed, confined

MiniHub **is not an offline application on principle**: nothing in its
architecture forbids reaching the internet. But **no feature uses it today**, and
none is planned — the preset module that motivated this section was abandoned
([DECISIONS.md](DECISIONS.md) D-013).

What follows therefore does not describe anything that exists: it is the frame
the first network call will have to respect, the day there is one.

- **The application stays fully usable offline.** No existing feature may start
  depending on a connection. Losing one degrades; it never prevents playing or
  opening a project.
- **No user data leaves.** No telemetry, no usage statistics, no project upload,
  no account.
- **Network access belongs to the main process.** The renderer has neither disk
  nor sockets: its CSP is `default-src 'self'` and must not be widened. Every request
  goes through an allow-listed command, with its validator, like everything else
  ([ARCHITECTURE.md](ARCHITECTURE.md) §4).
- **All remote content is an external value.** It is validated before entering
  state, and escaped before reaching `innerHTML` (invariant 9).
- **No automatic update check**, until the distribution question is settled (§2).

## 8. Refusal upheld: preset management

**Status: settled 2026-09-03. Out of scope.**

This refusal was lifted on 2026-09-02, and an ExecPlan carried the workstream to
step 8 of 9 before being stopped. **The refusal is upheld**;
[DECISIONS.md](DECISIONS.md) D-013 holds the measurements that settled it,
including the two that suffice: no `.vstpreset` file exists on the machine, and
the need is already served twice — by each VST3's own preset browser, and by
`capturePluginStates` / `persistPluginStateChunk`, which already persist every
plugin's state inside the project.

Do not reopen this on the argument "there are presets to recover". What would
legitimately reopen it is something else, and D-013 names it: **recalling a
MiniHub configuration** — a VST chain plus an arpeggiator plus MiniLab bindings,
recallable in another project. No plugin will ever do that, and it leaves the
machine at no point.

## 8 bis. Refusal lifted: automation, in the form of a Matrix node

**Status: settled 2026-09-03. In scope.**

`automation` sat in §6 from the start. The refusal is lifted, for a reason that
was already written elsewhere in this document: §3 names **"play generative music
live"** as one of the two uses that *define* the product. A setup that cannot
change state on its own over time is not playing generative music — it is playing
a loop. The refusal had therefore contradicted §3 from the beginning; what was
missing was noticing it.

What is lifted is **precisely bounded**, and not a word more:

- a **Matrix** node, one per project, added by hand, governing the nodes it is
  **actually wired to** by a `control` link;
- scenes, target states, ramps and output rules with a reproducible seed.

What **stays** out of scope, and what the Matrix must never become:

- no **automation lane** in the sequencer — no line, no point, no curve drawn on
  the arrangement. That is the DAW automation of §6, and it stays refused;
- no scripting language (§6, "not an extensible platform");
- no model-driven or online generation (§7);
- no second DAW inside the application.

The difference fits in one sentence: the Matrix **governs nodes**, it does not
**draw curves over time**. A request that slides it towards the second form
reopens the refusal in §6; it does not extend this lifting.

Target specification: `SPECIFICATION_MATRIX_MINIHUB.md`. Decisions:
[DECISIONS.md](DECISIONS.md) D-016 (the lifting), D-017 (the clock), D-018 (the
shared Learn).

## 8 ter. Refusal lifted: a controller is data, and that data is shared

**Status: settled 2026-09-04. In scope.**

§6 refused an extensible platform and a multi-user product. That refusal is
lifted for **one thing**: a controller is described by a declarative profile,
and those profiles are shared between people who own the same hardware.

The reason is not that the project grew ambitious. It is that the refusal was
already costing something concrete. `MINILAB_CONTROL_SOURCES` in
`midi/minilabControls.js` **is** a profile — it is simply written as a
JavaScript literal instead of a data file. The hardware is welded into the core,
which §5 already names a defect. Extracting it is owed whether or not anyone
else ever plugs in a keyboard.

What is lifted is **precisely bounded**:

- a **declarative profile format**, versioned, describing one controller: its
  port identity, its controls, their MIDI bindings, their layout;
- **profiles as files in the repository**, contributed by pull request. That is
  the whole sharing mechanism.

The rule that holds all of it together: **extensible by data, never by code.**
A profile is a scalar, an array or an object. Never JavaScript, never a script,
never a command, never a system path, never a DLL, never an executable URL,
never a callback. `npm run check` enforces this, so it is a rule and not a
hope.

What **stays** refused, and what this lifting must never be read as permitting:

- no accounts, no login, no user profiles, no sync between machines;
- no server, no database, no backend of any kind. Sharing is a folder and a pull
  request — no votes, no moderation tiers, no submission API;
- no sharing of **projects**. §6 still holds: a `.minihub` file stays on the
  machine that made it;
- no runtime dependency on the site. MiniHub works with no network and with no
  site, and shutting the site down makes no installation unusable;
- no telemetry, and no MIDI event leaving the browser during calibration.

The difference in one sentence: MiniHub accepts a **description of hardware**
written by someone else. It does not accept their code, their account, or their
music.

One consequence worth writing down, because it is what makes this expensive to
get wrong: a published `controlId` is **immutable**. Control ids become port ids
persisted inside projects, so renaming one in a profile silently breaks cables
in every project that used it. A profile evolves by adding, never by renaming.

Target specification: `MINIHUB_CONTROLLER_PLATFORM_SPEC.md`. Decision:
[DECISIONS.md](DECISIONS.md) D-020.

## 8 quater. One other controller, not N

**Status: settled 2026-09-04. In scope.**

§8 ter lifted the refusal for the profile **format**. This is the smaller,
separate question of what the application does with it: today MiniHub works with
a MiniLab 3 and with nothing else, so a friend holding any other keyboard cannot
use it at all.

Lifted, and only this: **the single controller slot stops being a MiniLab slot
and becomes a profile slot.** Port roles come from the profile, the controller
node takes its identity from the profile, the sequencer accepts the controller
node rather than one hard-coded id, and the header names whatever is connected.

**Not lifted: the plural.** `selectedInputId` stays singular. No multi-input
`MidiManager`, no N controller nodes, no settings migration. Plugging in a
*different* keyboard is what someone needs; using *two at once* is what nobody
has asked for, and §5's line holds — an abstraction for hardware that does not
exist in this project is speculative work.

Nor is a second profile **shipped**. The application carries exactly one. That a
second one works is proved by a fixture under `test/`, because writing device
data for hardware nobody here owns is the same speculation by another route.

Why this one has a user when the plural does not: the application repository
stays private until a friend configures his own keyboard, and this is the work
that makes that possible. The refusal of the plural lifts the day a second
keyboard is on a desk, by the same mechanism that lifted this.

Decision: [DECISIONS.md](DECISIONS.md) D-022.

## 9. Trade-offs

**The rule of conduct, non-negotiable:** when a request conflicts with the
existing architecture, **say so before building**, naming what would break — "if
this module is built that way, this breaks, so here is how to rethink it". Never
build first and report afterwards. Never build in silence hoping it slips
through.

**The default order**, when two qualities collide:

1. **Do not break what works.** A regression on an audio path costs more than any
   feature gained.
2. **Solidity and readability** of the existing code.
3. **New features.**
4. **Visual elegance.**

*The author confirms the preference for solidity; the exact order of ranks 3 and
4 remains to be validated by use.*

A corollary already applied in this repository: a consolidation pass comes before
a new module, and a stated invariant must become a test or an `npm run check`
rule — otherwise it is only a wish.

## 10. What failure looks like

- The network stops being the authority: what you hear depends on the open page.
- The audio thread starts blocking, and dropouts become "normal".
- Playing live requires an audio dropout to change anything.
- Adding a node type becomes a multi-file workstream again.
- A dependency, a bundler or a framework enters the renderer.
- The application stops working offline.
- The documentation starts lying again: `dist/` diverges from `src/`, a stated
  invariant is no longer true, a decision is undone with no entry in
  [DECISIONS.md](DECISIONS.md).

## 11. Open questions

These are **not settled**. While they remain open, an agent must neither assume
them resolved nor start work that depends on them.

1. **A non-negotiable performance threshold** — is there a numeric target (say,
   holding a 256-sample block with N plugins loaded) that, once missed, must
   block a change?
2. **Ranks 3 and 4 of §9** — features before visual elegance, or the reverse?

The visual language is **no longer an open question**: the model is settled
([DECISIONS.md](DECISIONS.md) D-012 — one `base.css` shell, at most one
`omni-pearl` faceplate, never mixed, `base.css` by default). What remains is an
aesthetic choice made editor by editor, and it blocks nothing.
