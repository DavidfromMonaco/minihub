# Tasks in progress

Only work that has started and is not finished — plus, listed apart, the problems
the author has asked to keep here until he takes them up. **When a task is
finished, delete its entry**, in the same commit. What was done lives in git and
[ROADMAP.md](ROADMAP.md), and so does the rest of what has never been started.

## Started, not finished

**A plugin commands MiniHub's modules over a CTRL OUT cable — in the author's
test** — built 2026-09-15 for One Ring, a VST3 kept outside this repository
(DECISIONS D-042, ARCHITECTURE §6 *Commands from a plugin*). Seen in the
application with the installed One Ring: an arpeggiator's rate, a mixer's
master, a track's mute, the tempo and Stop, each from its own channel; a cable
pulled stopped the commands and plugged back resumed them.
Since the same evening an agent programs One Ring (0.4.0) through the `plugin`
request (D-043): seen setting channels, running, reading the clock, stopping,
and the sequence surviving a save and a reload.
- Not seen yet: the author's own sequences; Codex building Orbites with the
  requests; Record through a cable in the application (the test rig covers it,
  guards and refusal message included).
- Not heard yet: a seek no longer cutting the sound — One Ring's SEEK 0 at the
  end of its cycle, as Metamorphose first had it. Since 2026-09-15 a seek
  releases the sequencer's and the arpeggiators' notes instead of putting All
  Sound Off on every chain. Seen in the application: play, seek, stop, no error.
  Heard by the author the same day: the arpeggiator no longer cuts the pad.
- Left for the author to decide: the Arpeggiator, Mixer and Morpher pages do not
  redraw when a command changes them; a Sequencer track solo and an arpeggiator
  hold do not exist to be commanded.
- One Ring's `AGENTS.md` still says the connection is not applied.

**An agent drives MiniHub from outside — in test** — works end to
end (patches, plugins, notes, save, export, Splice's web page, quit). Its
commits stay local while the author tests it.
Plan: [plans/done/agent-channel.md](plans/done/agent-channel.md) (standby while
the author tests).
- Not seen yet: a Codex session starting from the session rules and the first
  session note in `../minihub-agent/` (applied 2026-09-13).
- Unexplained: Splice's Expression reads 0.85 through `parameters` while the
  saved plugin state holds 1.0.
- Seen 2026-09-16: Splice kept its login across four restarts of the author's
  MiniHub, two of them with a fresh Splice — the login lives in Splice's own
  folder, not in the project. A MiniHub Codex opens with `start` uses that
  same folder (its logs, 2026-09-13).
- Optional: an MCP wrapper, so Codex calls requests as tools.
- Gap: `set-binding` plugs no cable (Learn does, since 2026-09-14) and does not
  redraw an open bindings bar.
- Gap: the sequencer's Loop, From and To cannot be set through the channel,
  nor read in `describe` (reported by Codex for Metamorphose).

**Splice asks to log in again — in the author's test** — diagnosed 2026-09-16. Splice keeps its login
in its own folder under AppData, and Windows files that folder inside a
packaged app's storage when that app launched MiniHub. The author's machine
holds three copies: the author's own, Codex's (2026-09-12), and the Claude
app's (2026-09-13) — a MiniHub launched from Claude Code is redirected too,
without the package identity `launchedInsidePackage` looks for. Separately, the
scan of 2026-09-15 started Splice for 0.2 s through a second list entry, and
the login was refused the next day: the likely cause, not proven.
- Done: one list entry per plugin (D-044). Seen in the application: 56
  plugins instead of 59, and a rescan that leaves Splice's folder untouched.
  The author said to go on.
- Done, in the author's test: MiniHub starts again through the shell when
  Windows files its AppData inside another app's package (D-045). Seen in the
  application launched from Claude Code and inside Codex's package, with a
  command-line switch carried across, and no relaunch on a plain launch.
- Not seen yet: Splice keeping its login when Codex or Claude Code opens
  MiniHub directly.
- Left alone on purpose: the old Splice copies in Codex's and the Claude app's
  storage.
- Outside this repository, unchanged: `../minihub-agent/AGENTS.md` and
  `minihub.mjs` still say a direct launch leaves plugin logins in Codex's
  storage — the author's to update.

**Learning a knob in one window: the bindings bar docked under the plugin
editor** — 7 of 8 steps. The bar opens under every plugin window, follows it,
and arms Learn on any knob, cabled or not: the capture plugs the cable in the
Patch Bay, Clear unplugs it. A bound knob or fader shows where its parameter
stands and moves it under the mouse; a binding that does nothing for now (cable
pulled out, plugin not running) is drawn dashed. Since 2026-09-15 the bar is the
only place a knob is learned: the VST node's page has no bindings panel any more.
A plugin too tall to leave room under the bar (Analog Lab V on the author's
1080-pixel screen) gets it beside the window, as a column, instead of over its
controls. Seen with Dexed and Analog Lab V: the author learned F1 from the bar
onto Analog Lab V's Reverb Volume, and the capture plugged its cable. Left: the
documents, step 8 of the plan.
- Not seen yet: the drawn knob following the plugin's own knob, or the MiniLab's.
Plan: [plans/active/bindings-bar-docked.md](plans/active/bindings-bar-docked.md).

**The Patch Bay's context menus** — still hand-built in `routingModule.js`;
`ui/contextMenu.js` exists and only the sequencer uses it.

## Kept for the author, not started

**Kilohearts plugins do not load** — added on the author's request, 2026-09-15.
kHs Gain, kHs Filter and kHs Reverb end in error: "setProcessing(true) failed".
`start()` in `native/audio-engine/src/plugin_host.cpp` accepts only `kResultOk`
or `kResultTrue` from that call; JUCE's own VST3 host also accepts
`kNotImplemented`. Which code these plugins return is not verified. A native
change: `npm run build:native` 0 errors 0 warnings, and the four test binaries.

**Massive X moves a parameter by itself, and Learn takes it** — added on the
author's request, 2026-09-15. In the author's session that morning, for the 36 s
after its window opened, Massive X reported a parameter moving about 23 times a
second with nobody touching it (`vstParameterTouched` in the startup log, at the
engine's cap of 30 per second), until a change of plugin state stopped it. Two
Learns armed during that stream ended after 50 ms and 30 ms, most likely on that
parameter; the third, armed once the stream had stopped, took the author's
gesture. The engine records a value only inside a gesture
(`native/audio-engine/src/gesture_learn_state.h`), so Massive X was opening
gestures of its own. Which parameter it was, and what starts the stream, is
neither logged nor verified.

**MiniHub.exe still names itself Electron** — raised 2026-09-15, the author's to
decide. The executable's version resource says "Electron" for the product and
the file description, "GitHub, Inc." for the company: `scripts/sync-dist.mjs`
stamps only the icon onto it with `rcedit`. Windows likely shows that name, in
Task Manager for one — not verified.
