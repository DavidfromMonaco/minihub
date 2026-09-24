# Tasks in progress

Only work that has started and is not finished — plus, listed apart, the problems
the author has asked to keep here until he takes them up. **When a task is
finished, delete its entry**, in the same commit. What was done lives in git and
[ROADMAP.md](ROADMAP.md), and so does the rest of what has never been started.

## Started, not finished

**Five changes asked in one session — in the author's test** — asked
2026-09-24 by the author during a session, built after he quit MiniHub
("fais tout"). Each seen in the packaged application (agent channel and CDP):
- A new node joins its own kind in the NODES list — VST, Audio Player, Audio
  Input, Mixer, Morpher, Arpeggiator, One Ring (`NODE_LIST_ORDER` in
  `core/nodeTypes.js`). A default, not a sort. Seen: five nodes created in a
  mixed order listed by kind; Mixer 1 dragged between the VSTs stayed there,
  Mixer 2 followed it, VST 3 went after VST 2.
- A cable's input end dragged onto another input is plugged there
  (`moveConnectionEnd`). Seen: moved to a Mixer, refused on a CTRL IN and left
  in place, unplugged on empty canvas, and one Ctrl+Z put a move back.
  Ctrl + click on a cable had stopped unplugging it (the selection frame took
  the press); fixed the same day and seen: a click selects, Ctrl + click
  unplugs.
- Several nodes selected in the Patch Bay: Shift or Ctrl + click, a frame drawn
  on empty canvas, a drag moving them all, Delete, Ctrl+A, Escape. Seen, with
  the MiniLab left alone by Delete and one Ctrl+Z restoring two deleted nodes.
  Ctrl+C still copies one node only.
- **Plays** All / Sequencer / Players in the header (DECISIONS D-053). Seen:
  three exports of Dexed plus an Audio Player, each holding only what the
  scope plays; live, Sequencer left the player stopped under Play and All
  started it mid-play. Under 1050 px the words Plays, Tempo and BPM drop so the
  device pill keeps its text (111 px at 960).
- A range per knob assignment: "Range [Low] −2.00 [High] +2.00 [Full]" in
  the bindings bar, each button beside the end it sets, as the author laid it
  out (`range` in `core/controlBindings.js`). Seen with kHs Pitch
  Shifter (its Pitch is ±24 semitones): ends at −2 and +2, the bar reading
  "−2.00 → +2.00", the drawn K5 dragged to its top, bottom and middle giving
  +2.00, −2.00 and +0.00. Tried by the author with the MiniLab's K5: "ça
  fonctionne", once he understood that an end takes the value the plugin
  shows. He had read "Min" as "the lowest possible", pressed it at +0.30 and
  left the top at +24; each button stands beside its value since, and both
  ends are always written out ("max" for a top never set). Seen in the bar since:
  the Range line on one row, the help whole, the bar 860 px under a narrow
  plugin. The Plays list opens dark (its options carry the shell's colours).
- The white strip beside kHs Pitch Shifter: its 236 px bar cut the help and the
  toolbar, and a widened plugin window cannot stretch the plugin. The bar is
  now at least 860 px under a plugin (`STRIP_MIN_WIDTH`), and a plugin that
  cannot resize gets a window without a resizing border or Maximize
  (`canResize` in `plugin_host.cpp`). Seen: a 252 x 363 frame, a 720 px bar (860 since),
  help and toolbar whole.
- Outside this repository, the author's to update: `../minihub-agent/AGENTS.md`
  describes neither the Plays scope nor a binding's range, and the channel
  cannot set either.

**Navigation in the three timelines, and the NODES list in any order — in
the author's test** — built 2026-09-24 on the author's word: "more precise
navigation tools, present in all three" (the arrangement, an audio take's
Clip Editor, a MIDI clip's), the navigation bar first, zoom in and out too.
He reported that the arrangement had no navigation bar: its four-pixel grey
rail hid itself and was not found.
- One bar for the three (`ui/navigationBar.js`), in its own row under the
  timeline: drag the thumb to travel, press beside it to jump there, drag one
  of its ends to zoom with the other end held, − and + for a step. It replaces
  `ui/scrollRail.js`.
- An audio take is no longer a fixed picture of the whole file: it zooms
  (the bar, Ctrl+wheel under the cursor, Fit) under a clock ruler down to the
  hundredth of a second (`ui/secondsRuler.js`).
- Seen in the application over CDP: the bar under all three, the thumb drag,
  an end drag (the other end did not move), −, +, Fit, Ctrl+wheel on a take.
- Still coarse: a take's waveform is the engine's 256 peaks for the whole
  file, so zoomed in it is an outline, not the signal. Finer peaks, asked of
  the engine for what is on screen, is the next step, and needs native work.
- The sidebar's NODES list is ordered by dragging a node, the other half of
  the same request ("just grab them and move them, no arrows"). The order is
  `hub.nodes`' own and so the project's (`NodeInstanceManager.move`); a press
  that barely moves is still a click; Escape cancels; Routing stays first; a
  node an undo brings back returns to its place. Reordering is not an undo
  step. Seen in the application: a drag up, a drag down, the line and the
  pale node mid-drag, a click after it, the order after a save and a reload.
- The arrangement's transport row stays one line at every window width and
  compacts in steps instead of widening the page (at 1224 px it was 12 px too
  wide and clipped the + at the end of the navigation bar). Wrapping it onto
  two lines was tried first and refused by the author. First Tempo,
  Métronome and "Track" go, then Play, Record and Stop become symbols and the
  track count goes, then the export format; each keeps a tooltip. Seen on one
  line with nothing clipped at 960, 1100, 1224, 1400 and 1700 px.
- Then, on the author's word, the Sequencer's own transport buttons (start,
  end, Play, Record, Stop) are gone and Record joined the header's Play and
  Stop, visible from every page: amber with its reason as tooltip when a take
  cannot start (pressing it says why), red while one runs. The Sequencer keeps
  its status line. What is left of its title row drops Tempo, Métronome and
  "Track" under about 860 px. The header's device pill now ends in an ellipsis
  rather than wrapping when squeezed. Seen at 960 and 1224 px; a take started
  from the header not seen, no MIDI keyboard being connected during the check.

**The plugin list folds a brand — in the author's test** — built 2026-09-21 on
the author's word, after Kilohearts' 35 "kHs" effects filled the VST node's
plugin list. A brand with two plugins or more in a family is one row, its
plugins opening beside it; a lone plugin stays a line; the families stay the
headings. The page draws that list (`ui/pluginMenu.js`, `foldPluginsByBrand`
in `core/vstChain.js`), so it no longer opens white; the select still holds
the choice that "+ Add VST" reads.
- Checked by `npm test` and `npm run check` only. The author tries it himself
  in MiniHub.

**Kilohearts plugins load — in the author's test** — fixed 2026-09-21. Every
"kHs" effect ended in "setProcessing(true) failed": they keep the VST3 SDK's
own answer to that call, `kNotImplemented`, which the engine took for a
refusal. It is accepted now, as JUCE's host does (`processingStartAccepted`
in `plugin_host.cpp`), and a real refusal names its code. All 35 installed
kHs load through the engine's host in `mlh_native_tests --load-plugin <path>`;
not seen in MiniHub yet.

**An Audio Player node — in the author's test** — built 2026-09-21 on the
author's word: an OmniBox he can put an audio file in, "at least WAV and MP3",
to cable into VSTs and process the audio. An Audio OmniBox with one AUDIO OUT:
a WAV, MP3, AIFF, FLAC or OGG file chosen on its page, Play/Pause, Stop, Loop,
Level, a click on the overview to place it; the Play, Pause and Stop at the top
of MiniHub drive it too (DECISIONS D-051, ARCHITECTURE §7 *`AudioPlayer`*).
- Seen in the application through the agent channel, on the 48 kHz headphone
  output: a 44.1 kHz WAV and an MP3 of it, through ValhallaSupermassive to the
  output; the transport's Play, Pause, resume and Stop, the loop's wrap, an MP3
  without loop ending at its start, the node's own buttons, and the header's
  Stop ending a player started alone. An export with the plugin bypassed
  differs from one without, so the file really is processed. The page and the
  Patch Bay card seen in a capture.
- Not heard by the author yet. The page is plain (`base.css`) until he says what
  it should look like.
- Outside this repository, the author's to update: `../minihub-agent/AGENTS.md`
  does not describe `create-node audio-player`, its content
  `{ filePath, loop, level }`, nor the `audio-player` request (`play`, `pause`,
  `stop`, `seek` with `seconds`).

**Templates, and a Home that says what MiniHub is** — built 2026-09-18 on the
author's word, replacing the "Basic template" placeholder, which only ever made
an empty project under another name.
- File > Save as Template writes the open project into
  `Documents/MiniHub/Templates`, beside Projects and with its own folder memory,
  and moves nothing about the project: not its file, not its name, not its
  dirty flag, not the recent-project keys Home reads.
- Home's Templates card and File > New from Template both open that folder. A
  project started from a template has no file and a fresh identity, so the
  first Ctrl+S goes to the projects folder and the template is never
  overwritten. Changing a template means Save as Template again.
- An empty templates folder opens no dialog: MiniHub says how one is made.
- The controller node's input port is called MIDI In. "Hardware" narrowed it to
  an external machine, which it never was.
- Home now opens on the sentence that MiniHub works with any MIDI controller,
  in bold and in the mixer accent, above what the four cards do.
- MiniHub ships one template, made by the author on 2026-09-18: the controller
  into an empty VST node, that node into the audio output. It is copied into
  the user's templates folder at startup when it is not already there, so it
  reaches the installer, the portable ZIP and an existing install alike.
- Not seen yet: the Home sentence on screen, the two dialogs in the author's
  hands, and the shipped template arriving on a machine that never had one.
- What it is for, the author's words: an example for somebody who has no idea
  how to use MiniHub. Its cables name the shipped profile's controller node on
  purpose — replacing it with one's own keyboard and saving a template, or an
  ordinary project, is what the example is teaching.
- Left as found: a cable into the controller's MIDI In is dropped in silence
  when no MIDI output is selected on its page (`midiManager.send` answers
  `false` and nothing says so). Reported to the author, not acted on.

**One Ring, made native** — started 2026-09-16 on the author's word, in place
of the Matrix node (ROADMAP item 7). One Ring becomes a node of MiniHub with
every function of the VST, its clock in the engine, its commands through the
same CTRL OUT path, and a new page after hardware sequencers.
Steps 0 to 15 of 19 done or waived: the node runs in MiniHub and its page
works, both tried by the author on 2026-09-17; requests answer One Ring's
vocabulary; scenes go from A1 to D8. Step 16, the page of part two in tabs,
is built and waits for the author's trial.
- Part two, asked 2026-09-17: One Ring plays notes — it captures what reaches
  a new MIDI IN, varies it through its channels and scenes, plays instruments,
  and writes its generations into new Sequencer tracks, which can feed the
  next. The author answered its three questions the same day and asked for
  every change that can be made in the meantime. Built and checked while the
  author was away: the material and its capture, four voices, the writer and
  feedback, and their requests (steps 11 to 13), and their page, in tabs
  (step 16), tried in a browser on a fake engine only.
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
- Gap: `set-binding` plugs no cable (Learn does, since 2026-09-14) and does not
  redraw an open bindings bar.
- Gap: the sequencer's Loop, From and To cannot be set through the channel,
  nor read in `describe` (reported by Codex for Metamorphose).
- Gap, outside this repository: `../minihub-agent/AGENTS.md` does not describe
  the transport operations added on 2026-09-18 (`pause`, `go-end`, `bars`) —
  the author's to update.

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
documents, step 8 of the plan, on standby since 2026-09-16 to free the slot
for One Ring.
- Not seen yet: the drawn knob following the plugin's own knob, or the MiniLab's.
Plan: [plans/done/bindings-bar-docked.md](plans/done/bindings-bar-docked.md).

**The Patch Bay's context menus** — still hand-built in `routingModule.js`;
`ui/contextMenu.js` exists and only the sequencer uses it.

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
