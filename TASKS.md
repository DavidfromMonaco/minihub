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

**One Ring creating the node a new generation's track plays** — set aside by
the author on 2026-09-17, to be rethought.

**What a plugin's commands cannot reach yet** — the author's to decide
(D-042): the Arpeggiator, Mixer and Morpher pages do not redraw when a command
changes them; a Sequencer track solo and an arpeggiator hold do not exist to
be commanded.

**Splice's Expression reads 0.85 through `parameters` while the saved plugin
state holds 1.0** — seen through the agent channel. Unexplained.

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

**A take's waveform, zoomed in, is an outline** — left from the timelines'
navigation (2026-09-24): a take draws the engine's 256 peaks for the whole
file, so zoomed in it is not the signal. Finer peaks for what is on screen
need native work. Not started.
