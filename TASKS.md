# Tasks in progress

Only work that has started and is not finished — plus, listed apart, the problems
the author has asked to keep here until he takes them up. **When a task is
finished, delete its entry**, in the same commit. What was done lives in git and
[ROADMAP.md](ROADMAP.md), and so does the rest of what has never been started.

## Started, not finished

**The Patch Bay cards the mockup promised** — asked 2026-09-25, controller
cards excepted. Built and green: header tags, numbered VST chains, the
Arpeggiator's, One Ring's and Sequencer's readouts, the output's meters, a
strip per Mixer / Morpher input fed by the engine's new per-input meters
(native build 0 warnings, the four native suites passing), the meters' rise
and release. Left: `sync:dist` -- the author is using the MiniHub the check
launched, and dist cannot be replaced under it -- then seeing a Mixer's strips
move with real signal.

**The project's name, the clock ruler, track mute, the players, the context
menus** —
asked 2026-09-25 by the author, the day he reported every entry awaiting his
test as tried and working.
- Done, in the author's test: the header's top left names the open project
  where it said "MiniHub", with a • while it has unsaved changes; the grey
  name at the far right is gone. A saved project is called what its file is
  called (`projectNameFromPath` in `core/projectManager.js`): a save by the
  agent channel to another path used to keep the old name, which is how
  Codex's `Codex.minihub` of 2026-09-24 kept reopening as "Untitled". Seen in
  the application: a file holding "Essai A" inside, saved as `Essai B`,
  opens as "Essai B".
- Done, in the author's test: the arrangement's clock ruler measures time on
  its own, down to the hundredth of a second as the zoom allows, instead of
  stopping at the second and leaving the fine divisions to the bar ruler — the
  opposite of what he had asked. It draws only the marks around the view.
  Seen in the application: 0:28.0, 0:28.2, 0:28.4 at the top zoom.
- Done, in the author's test: a track's mute silences its clips and no
  longer what it passes (D-054). In Codex's session two Audio Players reached
  the output through an armed audio track, and muting it silenced them; a
  MIDI track's mute zeroed its instrument, and whatever else it played. Seen
  in the application: a player through an armed track, muted, peaks at
  0.054 against 0.055 unmuted.
- Done, in the author's test: an Audio Player's page steps back and forward
  five seconds and back to the start, and mutes that player alone (`muted`
  in its content, sent as a level of zero). Seen in the application: a
  muted player at 0.000 while a second one played at 0.161; paused at 0.9 s,
  a step back landed on 0.0.
- Done, in the author's test: the Patch Bay's context menus, which he found
  unergonomic, rebuilt on `ui/contextMenu.js` as node editors do them. The
  empty canvas (right-click or double-click) lists every node type under its
  family, narrowed by typing, Enter taking the first; then Paste, Select All,
  Align, Show All Nodes. A node offers Open Plugin Window, Open Page,
  Duplicate (Ctrl+D, new), Copy, Disconnect All Cables, Delete -- on the whole
  selection it belongs to, a right-click on an unselected node selecting it.
  A cable offers Disconnect. Ctrl+C and Ctrl+V now carry several nodes, in
  their arrangement. Found on the way: the shared menu never ran an entry in
  the application (it closed on the press, before the click), so the
  Sequencer's clip menu did nothing; fixed. Seen with real mouse and keys over
  CDP: "arp" + Enter created an Arpeggiator, a cable's Disconnect unplugged it,
  a double-click opened the list and a click on Mixer made one, Duplicate made
  a selected copy that one undo removed, and the Sequencer's clip menu duplicated a clip.
- Built, in the author's test, not seen in the application: typing in the
  canvas menu also finds the installed plugins ("val" offers the Valhallas,
  their maker beside them), and taking one places a VST node with that plugin
  already loaded. Asked 2026-09-25 while the author played; no window was
  opened during that time, so it is checked by `npm test` only.

**One Ring, made native** — started 2026-09-16 on the author's word, in place
of the Matrix node (ROADMAP item 7). One Ring becomes a node of MiniHub with
every function of the VST, its clock in the engine, its commands through the
same CTRL OUT path, and a new page after hardware sequencers.
Steps 0 to 15 of 19 done or waived: the node runs in MiniHub and its page
works, both tried by the author on 2026-09-17; requests answer One Ring's
vocabulary; scenes go from A1 to D8. Step 16, the page of part two in tabs,
was tried by the author and reported working on 2026-09-25. Left: the
demonstration with him (step 17) and the documents (step 18).
- Part two, asked 2026-09-17: One Ring plays notes — it captures what reaches
  a new MIDI IN, varies it through its channels and scenes, plays instruments,
  and writes its generations into new Sequencer tracks, which can feed the
  next. The author answered its three questions the same day and asked for
  every change that can be made in the meantime. Built and checked while the
  author was away: the material and its capture, four voices, the writer and
  feedback, and their requests (steps 11 to 13), and their page, in tabs
  (step 16).
- Set aside by the author on 2026-09-17, to be rethought: One Ring creating
  the node a new generation's track plays.
- Found while planning it: every Sequencer sync panicked every chain, so a
  note edited during playback cut every instrument. Built (step 10): a sync
  that keeps the routing no longer panics. Not heard by the author yet.
- Not seen yet: a sequence copied from the VST, in the application.
Plan: [plans/active/one-ring-native.md](plans/active/one-ring-native.md).

**A plugin commands MiniHub's modules over a CTRL OUT cable — in the author's
test** — built 2026-09-15 for One Ring, a VST3 kept outside this repository
(DECISIONS D-042, ARCHITECTURE §6 *Commands from a plugin*). Seen in the
application with the installed One Ring: an arpeggiator's rate, a mixer's
master, a track's mute, the tempo and Stop, each from its own channel; a cable
pulled stopped the commands and plugged back resumed them.
Since the same evening an agent programs One Ring (0.4.0) through the `plugin`
request (D-043): seen setting channels, running, reading the clock, stopping,
and the sequence surviving a save and a reload.
- Ahead: One Ring is becoming a node of MiniHub itself (the entry above). This
  cable path stays: the native node goes through it, and so does any plugin.
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
end (patches, plugins, notes, save, export, Splice's web page, quit). On GitHub
since 2026-09-16; while the author tests it, neither the release notes nor the
site mention it.
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
- Closed 2026-09-25, on the author's word ("mets à jour tout ce qui concerne le
  mode agent"): `set-binding` plugs its cable and redraws the bar, and takes a
  `range`; `clear-binding` unplugs; `play-scope` and `loop` are new kinds,
  both read back in `describe`, which also gives a track's input and
  monitoring. `../minihub-agent/AGENTS.md` describes all of it, the Audio
  Player, the transport's `pause`, `go-end` and `bars`, D-045 and D-054, and
  `outils/verify-all.mjs` checks the new kinds. Run against the application
  once he had closed his: 39 of 39, the knob cable plugged and unplugged, a
  range stored, Plays and the loop read back, a player read, muted and
  played. The client's own list of project-gated kinds lacked `loop`
  (`stale-project`); added -- that list has to follow `MUTATING` in
  `agentRequests.js` by hand.

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
- `../minihub-agent/AGENTS.md` says so since 2026-09-25; `minihub.mjs` still
  warns when `launchedInsidePackage` is named, which now means the relaunch
  did not happen.

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
documents, step 8 of the plan, on standby since 2026-09-16 to free the slot
for One Ring.
- Not seen yet: the drawn knob following the plugin's own knob, or the MiniLab's.
Plan: [plans/done/bindings-bar-docked.md](plans/done/bindings-bar-docked.md).


## Kept for the author, not started

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

**The Clip Editor has no rulers** — asked by the author on 2026-09-18. The piano
grid draws its beat lines (`--ce-beat` in `src/renderer/js/clipEditor.js`) and
nothing names them: no bar ruler along the top, no position in time, where the
Sequencer has both (`rulerStride` in `modules/sequencer/sequencerModule.js`).
With a clip open there is no way to say which bar is on screen. Not started.

**The rubber band does not survive a repaint** — found on 2026-09-18 while
fixing the rail and the middle-button pan, which had the same defect and are
fixed. `startMarquee` in `modules/sequencer/sequencerModule.js` captures the
canvas, its rectangle and the band element; a repaint replaces all three, and
the band is left drawing on a detached node. It takes a repaint DURING the
drag, which only playback's follow-scroll can cause, so it needs the transport
running and a rubber band at the same time. Not reproduced in the application.

**A take's waveform, zoomed in, is an outline** — left from the timelines'
navigation (2026-09-24): a take draws the engine's 256 peaks for the whole
file, so zoomed in it is not the signal. Finer peaks for what is on screen
need native work. Not started.

**A cable into the controller's MIDI In is dropped in silence** — found
2026-09-18 while building templates: when no MIDI output is selected on the
controller's page, `midiManager.send` answers `false` and nothing says so.
Reported to the author, not acted on.
