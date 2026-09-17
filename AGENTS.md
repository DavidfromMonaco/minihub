# AGENTS.md — MiniHub

The single entry point for an agent or a developer arriving at this repository.
This file is the **map**; it replaces none of the documents it points to.
Read it in full, then open only what the task needs.

---

## 0. The rule of conduct

**When a request conflicts with the existing architecture, say so before
building.** Name what would break, and propose the reframing: "if this module is
built that way, this breaks, so here is how to rethink it."

Never build first and report afterwards. Never build in silence hoping it slips
through. A conflict raised up front costs five minutes; the same conflict found
afterwards costs the whole workstream.

The three sources to check a conflict against: [INTENT.md](INTENT.md) (the
scope), the invariants in §4 below (the architecture), and
[DECISIONS.md](DECISIONS.md) (what has already been settled, and why).

---

## 1. What this is, in five lines

A desktop music workstation for Windows, built around the **Arturia MiniLab 3**
MIDI controller: a Patch Bay of typed cables, a native VST3 host, a
sample-accurate MIDI + audio sequencer, Mixer / Morpher / Arpeggiator / One Ring
nodes, and learning that binds physical knobs to VST3 parameters.

Three processes: Electron main (CommonJS) — renderer (Chromium, ES modules, no
build step) — C++17 audio engine (JUCE 9, PortAudio/WASAPI, VST3 SDK).

## 2. Vocabulary — four names, one product

| Form | Where it appears | Do not "fix" it |
|---|---|---|
| **MiniHub** | product name, `dist/MiniHub`, `MiniHub.exe`, the `.minihub` extension, `Documents/MiniHub/Projects` | this is the canonical name |
| MiniLab Hub | nowhere on screen since 2026-09-15 — the window title and the header say MiniHub. Still the first line of each startup log session and the native engine's internal application name | historical; the leftovers are harmless, but it does not come back on screen |
| `minilab-hub` | npm name, `%APPDATA%/minilab-hub/`, startup log | **a path that already exists on the user's disk** — renaming it loses their settings |
| `mlh_` / `mlh-` | native targets and binaries (`mlh_audio_engine`, `mlh-vst3-scanner.exe`) | build prefix, referenced by the scripts |

**MiniLab** alone always means the hardware controller, never the application.

## 3. Where to go, by task

| You are touching… | Read first |
|---|---|
| anything at all | this file + [INTENT.md](INTENT.md) |
| the architecture, a contract, a module | [ARCHITECTURE.md](ARCHITECTURE.md) — table of contents at the top |
| a decision that looks absurd | [DECISIONS.md](DECISIONS.md) **before** "repairing" it |
| what is in progress | [TASKS.md](TASKS.md) — read only that file |
| what was done, what was never started | [ROADMAP.md](ROADMAP.md) |
| a long, multi-session task | [PLANS.md](PLANS.md), then `plans/active/` |
| IPC, the engine protocol | ARCHITECTURE §4 |
| the network, ports, cycles | ARCHITECTURE §6 |
| the native engine, real time | ARCHITECTURE §7 and §8 |
| the sequencer | ARCHITECTURE §9 |
| the UI, the CSP, styling | ARCHITECTURE §10 — visual references in `docs/design-references/` |
| **driving the running app** | §7 bis below — there is a channel; do not click |
| persistence, projects | ARCHITECTURE §11 |

## 4. Absolute rules

These twelve invariants are detailed and justified in **ARCHITECTURE §13**.
Breaking one is a failure, not a trade-off.

1. **No audio sample ever crosses the IPC.** Control and MIDI only.
2. **The network is the routing authority.** The page on screen never influences the signal.
3. **The audio thread never blocks.** No lock, no allocation inside the callback.
4. **A node `id` is never reused.** The `ordinal` is display only.
5. **`register` and `unregister` are symmetric**, routing node included.
6. **A project key is declared exactly once**, in `core/projectKeys.js`.
7. **A system node identifier comes from `core/systemNodes.js`**, never from a literal.
8. **`unmount()` removes everything** — subscriptions and DOM listeners. `#content` is shared.
9. **Every external value is escaped** (`core/html.js`) before it reaches `innerHTML`.
10. **No inline styles** — the CSP (`style-src 'self'`) rejects them silently.
11. **`dist/` must match `src/`** — run `npm run sync:dist` after any change.
12. **The VST catalogue never loses a plugin on its own.** A second path to the
    same plugin is not a plugin (D-044).

## 5. Design prohibitions

"No" carries as much weight as "yes". See [INTENT.md](INTENT.md) for product
scope; here are the technical prohibitions:

- **No JS build step.** No bundler, no transpilation, no framework. What is in
  `src/` is what runs.
- **No runtime dependency.** `package.json` holds only `electron` and `rcedit`,
  in `devDependencies`. Tests use `node:test`, not a runner.
- **No disk access from the renderer.** `contextIsolation: true`,
  `nodeIntegration: false`; everything goes through `window.hubAPI`
  (`src/main/preload.js`).
- **No engine command outside the allow-list** (`src/main/engineCommandPolicy.js`).
- **No second audio stream.** One PortAudio/WASAPI stream; the other back-ends
  are disabled at compile time.

## 6. Conventions

- **Language**: everything is in **English** — code, comments, docstrings,
  identifiers, and `.md` documents alike. The repository is public and
  MIT-licensed; nobody should need French to read the architecture. Commit
  messages from before 2026-09-04 are in French: that is history, not a rule to
  follow. See [DECISIONS.md](DECISIONS.md) D-019.
- `src/main/` is **CommonJS**, `src/renderer/` is **ES modules**
  (`src/renderer/package.json` carries `{"type":"module"}`). That is what lets
  the tests import the renderer with no build step. Do not mix the two.
- **Two stylesheets, two roles — not two rivals.** They do not compete; they
  cover different layers:

  | What you are dressing | Sheet | How |
  |---|---|---|
  | the app shell: header, sidebar, Patch Bay, cables, modals, settings forms | `base.css` | classes `.panel`, `.btn`, `.pill`… |
  | an instrument surface: anything imitating a device faceplate — knobs, switches, step grids | `omni-pearl.css` | put `class="omni-pearl"` on the module root, then build the controls with `ui/omniPearl.js` (`pearlKnobMount`, `pearlSelect`, `pearlSwitch`, `pearlIconButton`) |

  **This is containment, not layering.** The faceplate is not paint applied over
  `base.css`: `.omni-pearl` redefines its **own** complete token set (`--op-*`)
  and consumes no variable from `base.css`, and its components are different
  markup (`pearlKnob` builds an SVG knob around a native `<select>`, where base
  has an `<input type="range">`). A module therefore picks one vocabulary **for
  its whole subtree** — never both mixed. The shell itself is never given a
  faceplate.

  **One shell, at most one faceplate.** A second faceplate means a second set of
  ~35 tokens and a second component library. If a new look is wanted, it
  **extends or replaces** `omni-pearl`; it is not added alongside.
  `npm run check` refuses a third stylesheet. See [DECISIONS.md](DECISIONS.md)
  D-012.

  Today only the arpeggiator wears the faceplate; extending it is decided editor
  by editor, not in bulk. By default, a new module uses `base.css`.

  Trap: `clip-editor.html` loads **only** `base.css`. Any `op-` class landing
  there would be unstyled, with no error message whatsoever — `npm run check`
  now catches it.

- A comment explains **why**, never **what**. The existing files
  (`core/systemNodes.js`, `core/projectKeys.js`) set the expected density: they
  describe the failure mode the structure prevents.
- No magic literal for a shared identity — see invariants 6 and 7.

## 7. Commands

```bash
npm install              # Electron + rcedit
npm test                 # 1241 JS tests, node:test runner, ~10 s
npm run check            # 15 rules (Node stdlib + the profile validator, ~1 s)
npm run build:native     # native Release build (CMake + MSBuild)
npm run build:native:tests
npm run sync:dist        # promotes src/ + engine into dist/MiniHub
npm start                # native build + sync + launch the packaged version
npm run build:installer  # Setup.exe + portable ZIP -> dist/release (needs Inno Setup 6)
```

Native tests, after `build:native:tests`:

```bash
native/audio-engine/build/Release/mlh_native_tests.exe --core
native/audio-engine/build/Release/mlh_native_tests.exe --vst3-e2e
native/audio-engine/build/Release/mlh_native_tests.exe --cross-track-isolation
native/audio-engine/build/Release/mlh_realtime_output_tests.exe
```

**Native SDKs to fetch locally** (never committed, ~682 MB): JUCE 9, the VST3
SDK, PortAudio and LAME under `native/third_party/`. CMake fails with an
explicit message if one is missing.

## 8. Mechanical truth — the definition of "done"

A change is finished only when **everything that touches it is green**:

| Scope changed | Must pass |
|---|---|
| anything in `src/` | `npm test` + `npm run check` |
| anything in `src/` | `npm run sync:dist` (otherwise the provenance test fails) |
| `native/audio-engine/src/` | `npm run build:native` **0 errors 0 warnings** + the four test binaries |
| an ARCHITECTURE §13 invariant | add the test that would have caught it |

A task that starts is added to [TASKS.md](TASKS.md); a task that finishes is **deleted** from it, in the same commit.

What no command proves is not proven. Do not report "it works" on the strength
of having read the code. If a test fails, say so, with its output.

## 7 bis. Driving the running application — do not take the screen

**If you are an agent and you need MiniHub to DO something — build a patch, load
a plugin, write notes, play, save, export — there is a channel for it. Use it.
Do not drive the interface with screenshots and clicks.**

The channel is off by default. Start the packaged build with it on:

```bash
MINIHUB_AGENT_CHANNEL=1 "dist/MiniHub/MiniHub.exe"
```

Where the channel is already turned on in the settings (`agentChannel: true`),
open MiniHub with the client instead: it launches through the Windows shell, the
way a double-click does, and waits until the channel answers. A MiniHub started
from inside a packaged app (Codex Desktop, the Claude app) would have Windows
file every plugin's login and downloads in that app's private storage. MiniHub
notices it at startup and starts itself again through the shell (DECISIONS
D-045), so a direct launch or `npm start` returns at once while MiniHub keeps
running.

```bash
node ../minihub-agent/minihub.mjs start
```

Then talk to it from the client, which lives **outside this repository** at
`../minihub-agent/`:

```bash
node ../minihub-agent/minihub.mjs ping
node ../minihub-agent/minihub.mjs describe
```

`../minihub-agent/AGENTS.md` holds the whole vocabulary and is the file to read
before using it. The short version: `describe` to read the state, then typed
requests for everything else — nodes, cables, plugins, parameters, tracks,
clips, notes, the transport, the tempo, saving, exporting, the windows on
screen, and the web page a plugin such as Splice INSTRUMENT shows in its own
window.

Two things this is NOT. It is not a public API in the sense §6 of
[INTENT.md](INTENT.md) refuses: an operation an agent can ask for is one the
interface can already perform, and the vocabulary lives in
`renderer/js/core/agentRequests.js`, which owns no behaviour of its own. And it
is not code execution: a request is data, validated like a controller profile,
never a script. The bounds are [INTENT.md](INTENT.md) §8 sexies.

If something you need is missing from the vocabulary, **that is a gap to report
and fill**, not a reason to reach for the mouse.

`scripts/runtime-*-gauntlet.mjs` are one-off harnesses that drive the real
application over CDP; they belong to closed investigations and are **not** part
of the definition of "done". See ROADMAP.

## 9. Traps that cost an hour

- **The renderer is not reloaded by `npm start`** until `sync:dist` has run: you
  are then debugging the old code copied into `dist/`.
- **A `console.log` in the renderer travels to the main process** and then to
  disk. On a periodic event (`masterMeter` at 10 Hz) the log explodes. See
  `src/main/engineEventTrace.js`.
- **`core/nodeInstances.js` (1,145 lines) and `modules/routing/routingModule.js`
  (1,496 lines)** are the two files where an innocent change breaks four node
  types at once. Workstream 4 in the ROADMAP.
- **The native engine survives a renderer reload.** VST chains are append-only
  on the C++ side; `core/chainSync.js` rebuilds them after a restart.
