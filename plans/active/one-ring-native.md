# One Ring, made native — ExecPlan

**Goal** — One Ring runs inside MiniHub as a node of its own, with every
function of the VST: its clock in the engine, its commands through the Patch
Bay's CTRL OUT, a sequence saved by the VST opened in it without loss, and a
page of its own in a new hardware-style design. Then, part two: it plays notes
— it captures what reaches its MIDI IN, transforms it through its channels and
scenes, plays instruments from its MIDI OUT, and writes its generations into
the Sequencer's clips, where one can become the material of the next.
**Origin** — [ROADMAP.md](../../ROADMAP.md) item 7, decided by the author on
2026-09-16 in place of the Matrix node, started the same day on his word:
"commence à travailler sur l'intégration de One Ring en natif". His direction
for the look: every function kept, the whole design redone after hardware
sequencers — the Korg SQ-64, the Roland P-6, the Cre8audio Programm.
Part two: asked by the author on 2026-09-17, in a brief written with Codex
after trying the node ("tout fonctionne bien, mais je voudrais des fonctions
en plus") — One Ring as the generative engine of a piece. The author's
instruction for that day: check that it is possible and prepare it, no code.
**Status** — **in progress, 2026-09-17.** Steps 0 to 8 done: the page works,
the author says. Part two (steps 10 to 17) designed and planned; the author
answered its three questions the same day and asked for every change that can
be made while away ("fais toutes les modifications que tu peux, je reviens
check dans quelques heures"): steps 9, 11, 12 and 13 are done, each checked
and committed, and step 10 is built and waits to be heard. The author's second
round, the same day: the page of part two is written without a still first
(step 14 waived), scenes grow to A1 to D8 (step 15, new), and One Ring creating
nodes is set aside.

## Context

**The source** — One Ring 0.4, kept by the author outside this repository (not
a git repository). What it is made of, all of it read before this plan was
written:

- `src/core/` — `model` (the project, its validation, MUTATE), `generative`
  (the counter-based random draws, conditions, value sources), `commands` (the
  target registry and value validation), `engine` (the scheduler, ~350 lines,
  written for the audio thread). About 1,000 lines, no JUCE.
- `src/plugin/Processor.cpp` — the clock (host tempo and position; Play starts
  it; after Stop it keeps the last tempo until its own STOP), the lock-free plan
  swap, the packet queues. `Serialization.cpp` — the saved state, JSON,
  version 1. `Editor.cpp` — every control. `Requests.cpp` — the request
  vocabulary.
- `tests/core_tests.cpp`, `README.md` (the functions, as a user reads them),
  `docs/REQUEST.md` (the original specification).

**Every function, the list this plan answers to** — nothing on it is dropped:

- 16 channels; each one: a target and a command, 4/8/16/32/64 steps, a
  resolution from 1/4 to 1/32, 1/2/3/4/8 or endless repeats, Trigger or Legato
  (Legato only for a target that declares a release), enabled, offset (in
  steps, negative wraps), swing, humanize, which fields MUTATE may change,
  Follow Actions run in order when a finite channel completes;
- each of 64 cells: active, probability, a value (fixed, a range, or a list of
  choices), conditions (first loop, last loop, every N loops, if a channel is
  active or inactive) combined with the probability, LOCK STEP and per-field
  locks;
- scenes A–D holding all 16 channels; STORE SCENE; recall Immediate or Next
  bar, Restart or Keep positions;
- a seed, NEW SEED, MUTATE (one channel or all), the mutation count saved;
- RUN and STOP of its own; per channel START, STOP, RESTART, RESET, TOGGLE,
  ENABLE, DISABLE; its own channels and scene recall usable as targets by its
  steps and Follow Actions;
- what it shows: each channel's playhead and activity, the scene, running, the
  beat and tempo, refused and guarded counts, the connection status and the
  last refusal.

**MiniHub** — ARCHITECTURE §5 (node types, the module contract), §6 *Commands
from a plugin* (the path this node reuses end to end), §7 (`Transport`,
`MidiExecutionPlan`: where a clock lives in the callback), §8 (threading), §10
(the faceplate), §11 (project state). Files: `core/commandBus.js`,
`core/commandRegistry.js`, `core/nodeCommands.js`, `core/nodeTypes.js`,
`core/nodeInstances.js`, `core/nodeEditors.js`, `core/engineSync.js`,
`core/engineClient.js`, `core/agentRequests.js`, `src/main/engineCommandPolicy.js`,
`native/audio-engine/src/engine.cpp` (`timerCallback`, `forwardControlEvents`),
`transport.h`, `midi_network.*`, `CMakeLists.txt`, `test/native_tests.cpp`.

**Decisions it comes near** — D-012 and D-037 (one faceplate, graphite), D-016
to D-018 (written for the Matrix), D-032 (a command is performance), D-042
(commands over CTRL OUT), D-043 (requests).

**Part two, the list it answers to** — the author's brief of 2026-09-17,
nothing on it dropped:

- The aim: evolving, ethereal synthetic soundscapes. The Sequencer is the first
  source and a store of notes; One Ring decides how they evolve and the
  structure. The loop: a short clip gives a few notes; One Ring captures them
  and keeps using them after the clip has ended; it varies pitch, rhythm,
  durations, velocities, density and silences; it plays an instrument; it
  writes a new generation into a clip; that generation can become its
  material. All of it inside MiniHub — no outside agent rewriting clips during
  playback. A long pre-written arrangement with parameter automation does not
  answer it.
- MIDI IN and MIDI OUT on the node, its commands kept. A polyphonic pattern
  captured with pitch, velocity, channel, position and duration. Commands to
  capture and end the capture, to replace or add to the memory, to keep the
  pattern after its source stops, to clear it. A defined handling of Note On
  and Note Off, of held notes, and of overlapping notes of the same pitch.
- From the material, at least: transposition and octave; a key and scale;
  notes reordered or selected; rhythmic placement and duration varied;
  velocity varied; repeats, silences and density; probabilities and mutations
  reproducible from a seed. Inside the scenes, channels, conditions, locks and
  Follow Actions — not a generator beside them. The material kept apart from
  the rules that transform it; pitch, velocity and duration limits explicit.
- Into the Sequencer: create a MIDI clip on a named track, write a generated
  pattern into it, replace or add to a named clip, at a musical boundary (the
  next bar, say). Real notes, not RECORD_ON with a keyboard. Through the
  Sequencer's own model, display, save and history — no second clip editor.
  Never a clip other than the configured one.
- Controlled feedback: a written generation can be the next one's material. An
  explicit switch; a musical delay between generations; replace or add; limits
  on memory size, density and the number of generations; an immediate stop of
  playing and writing. No repeated recapture of one event, no duplicates, no
  endless cascade. The Patch Bay's cycle refusal stays; the loop is delayed and
  bounded, through memory and clips.
- The page and the agent channel both, through the same logic. The agent reads
  and sets the material, the rules, the MIDI and clip targets, the state of
  capture, generation and feedback, the seed and the current generation, what
  is pending and what was refused — and the node's running status (playing,
  scene, channel activity, the error counts that matter), which nothing reads
  today: `set-node-content` only writes. The requests documented as built; the
  client or its manual updated if needed.
- Existing One Ring projects keep working. Generation, scenes and writes follow
  the transport; Stop, resume, return to start, scene change, seek and loop
  each have a defined behaviour. No stuck note on a stop, a node deleted or a
  project changed. Nothing blocking, no disk, no clip-model change in the
  audio callback. Material, rules and feedback settings saved and restored.
  The same seed and the same input give the same result. No hidden automatic
  attenuation — an earlier volume problem was weak settings adding up in a
  project.
- Proven by a small demonstration project — a short source clip and no
  pre-written arrangement, a One Ring, an instrument, a destination for the
  generations — showing that One Ring (1) captures the clip, (2) goes on
  varying it after the clip ends, (3) plays different notes when its scenes
  and conditions change, (4) writes a new clip, visible and saved, (5) takes
  that clip as the material of a new generation, (6) keeps the loop bounded
  and stops cleanly, (7) reloads with the project, (8) still sends its
  commands. And by focused tests: polyphonic capture, determinism, clip
  writes, feedback, stops without stuck notes.

**Part two, where it lands** — ARCHITECTURE §6 (*MIDI through a VST node*),
§7 (`Chain`, `MidiExecutionPlan`), §8, §9; DECISIONS D-005 (cycles), D-032
(where a take becomes authorship), D-039 (MIDI thru), D-042. Renderer:
`core/nodeTypes.js`, `core/midiThru.js` (`RECIPIENT_TYPES`),
`core/engineSync.js` (`describeMidiNetwork`, `arpeggiatorDestinations`),
`core/nodeInstances.js` (a controller's notes into an engine processor,
`engine.midiNode`), `core/sequencerController.js` (`syncNative`,
`_sendLiveMidi`, `_acceptMidiRecording`, `addMidiClip`,
`handleClipEditorRequest`), `core/sequencerModel.js`,
`modules/sequencer/sequencerModule.js` (a MIDI track's destinations),
`core/editHistory.js` (`HISTORY_DEPTH`), `core/oneRingNodes.js`,
`core/oneRingSequence.js`, `core/agentRequests.js`, `core/agentDescribe.js`,
`modules/oneRing/`, `src/main/engineCommandPolicy.js`. Native:
`midi_network.*` (`ArpeggiatorRuntime`, the precedent: held notes, a registry
of sounding notes, release on a seek and on a loop wrap), `sequencer.*` (a
track whose `outputKind` is `arpeggiator` pushes its block into the
processor's scheduled input; `thru`; each track's `activeNotes`, kept in the
plan), `engine.cpp` (`processEngine2Block`, `cmdMidiNode`, `cmdSyncSequencer`,
`panicAllMidi`, `releaseAllMidi`, `cmdRemoveOneRing`, `publishOneRingSet`,
`forwardOneRings`), `chain.h` (`pushMidi` with an epoch, `pullMidi` in the
tests), `one_ring/*`.

**Part two, found in the code on 2026-09-17** — what the design stands on:

- A Sequencer track already feeds an engine processor at sample accuracy: an
  `arpeggiator` destination makes the track push its block into that
  arpeggiator's scheduled input, and its series (D-039) ends there. One Ring
  can be a second such processor; the arpeggiator is the whole precedent, in
  about eight places across both processes.
- **Every Sequencer sync panics every chain.** `cmdSyncSequencer` ends in
  `panicAllMidi()`: All Sound Off on every chain, every arpeggiator reset. A
  new plan starts with empty `activeNotes` and could not give the old plan's
  notes their Note Off, hence the panic. Today a note edited in the Clip Editor
  during playback cuts every instrument; a clip written by One Ring while
  playing would cut the whole piece, its own notes included.
- In the block, One Ring runs after the arpeggiators. To feed one, it has to
  run before them — harmless for its commands, which are carried out on the
  control thread.
- One Ring's clock jumps with the arrangement: while both play, a seek or a
  loop wrap sets its beat to the transport's. A capture needs a count of its
  own.
- A recording take becomes a clip in `_acceptMidiRecording`, and D-032 draws
  the line between performance and authorship there. A written generation
  fits the same path.
- The offline export runs no One Ring, as it executes no command today. It
  plays what the clips hold.
- A node's content is copied into each of the 50 undo steps and into every
  settings save: what part two adds to it has fixed caps.

## Constraints

- A One Ring VST state (version 1) converts to the node's content and back
  without loss. The content keeps, per channel, a `blank` cell and only the
  cells that differ from it: the VST writes all 4 × 16 × 64 cells, about
  700 KB, which an undo step and a settings save must not carry.
- The random draws are part of that format. `mix` and `Random` are ported bit
  for bit, in C++ and in JS, and both are checked against the same fixed values.
- Invariant 2: the node commands only what its CTRL OUT is cabled to, through
  `CommandBus` — never around it.
- Invariant 3: the scheduler runs in the audio callback with no lock and no
  allocation. A new sequence is an immutable plan swapped at a block boundary,
  as the VST's `Processor` does.
- D-032: a command the node sends is performance (`hub.perform`); editing its
  sequence is authoring, one undo step.
- An offline export executes no command, as today.
- The plugin path stays whole: a plugin on a CTRL OUT cable still commands, and
  the One Ring VST still works in MiniHub.
- One faceplate (D-012): the page is built with `omni-pearl.css` and
  `ui/omniPearl.js`, extended — never a second sheet.
- Every new engine command joins `engineCommandPolicy.js`.

Part two adds:

- A content saved before part two opens unchanged and plays as before: every
  new field has a default that changes nothing, and new random streams come
  after the four existing ones, so a saved seed draws what it drew.
  `toVstState` leaves the new fields out; the VST no longer exists to read
  them.
- The save path is not touched. Material, rules and writer settings live in
  the node's content, which a project already saves; a write marks the project
  modified through the existing path, as a recording take does.
- Invariant 1: notes cross the IPC as control data (a capture, a generation),
  never as audio.
- Invariant 3: capture, voices and the take run in the callback on fixed
  capacities, with no lock and no allocation. A clip is written by the
  renderer, never in the callback.
- The Sequencer's model stays the only clip editor: a write goes through
  `SequencerController` and `SequencerModel` operations, the ones the Clip
  Editor and the agent use; what is missing is added there, once.
- A write reaches only the track or clip its writer names. A named target that
  is gone, elsewhere or of another type is a refusal, reported — never a
  fallback.
- D-032: a written generation is authored, as the clip a take produces is.
- The network's cycle refusal is unchanged; the feedback loop goes through
  time, memory and clips, never through a cable.
- No gain or velocity is lowered by anything the author did not set.

## Out of scope

- Changing or retiring the One Ring VST, or the CTRL OUT path for plugins.
- The Morpher: whether One Ring takes its place is not decided.
- Functions the VST does not have — commands of its own on a CTRL IN, more than
  16 channels, target commands executed at sample accuracy — except part two's
  notes and the scenes A1 to D8, which the author asked for on 2026-09-17.
- What the Matrix specification found missing: the post-chain gain stage, a
  `ctrl-in` on dynamic-input nodes, a dual live/export runtime.
- The site and the release notes.

Part two leaves out:

- What One Ring plays live, in an offline export. The export plays the clips,
  generations written into them included; making it run One Ring is the dual
  runtime above. The author's answer: an audio track records it (answer 2).
- An arpeggiator, or another One Ring, feeding a One Ring's MIDI IN: not
  routed, as an arpeggiator feeding an arpeggiator is not today. One Ring's
  MIDI OUT into the Sequencer's MIDI IN is not a recording path either; WRITE
  is.
- Anything but notes on MIDI IN and MIDI OUT: no controller change, pitch bend
  or aftertouch captured or played.
- Loading a clip as material from a step of the sequence. The page and the
  agent load a clip; a sequence captures what a track plays.
- A time-stretch of the material, and timing finer than the Sequencer's 960
  ticks to the quarter.
- Generation driven by a model, or any code in a request.
- One Ring creating a node itself, for the track a new generation is written
  to: set aside by the author on 2026-09-17 ("il faut que je repense le
  truc"). The author, or an agent, creates and cables it.
- Removing a scene: the list of scenes only grows (*Scenes A1 to D8*).

## Part two — design

Written 2026-09-17 from the code, before any of it is built. It moves into
ARCHITECTURE and DECISIONS at step 18; until then this is where it lives.

**The node** — MIDI IN and MIDI OUT beside CTRL OUT. MIDI IN takes a Sequencer
track that names the node as its Destination, and a controller cabled to it.
MIDI OUT reaches VSTs and their series (D-039), the hardware output and
arpeggiators. The MIDI network description carries a One Ring's destinations
as it carries an arpeggiator's; the engine hands them to the runtime, which
outlives a MIDI plan rebuilt for a cable. In the block the order becomes:
Sequencer, One Ring, arpeggiators, chains.

**The material** — kept by the runtime, copied into the node's content so a
project saves and reopens it. Two lists of notes: the *origin* (what was
captured or loaded) and the *current generation* (what feedback made of it;
the origin until then). A note is a pitch, a velocity, a channel, a start and a
duration in ticks (960 to the quarter, the Sequencer's resolution); the
material has a length, at most 64 bars, and each list at most 256 notes.

- *Capture* is armed by a command or from the page, and listens on MIDI IN for
  a window of 1 to 16 bars, or until its end command. Positions are counted in
  beats elapsed since it began, so a loop wrap does not fold notes onto each
  other. A Note On of velocity 0 is a Note Off. A second Note On on a sounding
  pitch and channel ends the first one there. A note still held when the
  capture ends ends with it; a note held before it began is not taken.
  *Replace* makes the capture the new origin; *Add* merges it into the origin
  and skips a note with the same channel, pitch and start. Past 256 notes, the
  rest is refused and counted.
- *Load*, from the page or the agent, takes a clip's notes as the origin, read
  from the Sequencer's model: exact, and no playback needed.
- *Freeze* keeps the material as it is, whatever arrives. *Revert* puts the
  current generation back to the origin. *Clear* empties both.
- The material travels on an engine command of its own, both ways. A capture,
  a load or an undo of either does not publish a new sequence: a new plan
  releases what Legato holds.

**Voices — the notes, inside the sequence** — four voices, each a new internal
target (`one-ring:voice:1` to `one-ring:voice:4`) beside the channel and scene
targets. A channel aimed at a voice plays notes with everything a channel
already has: length, rate, repeats, Trigger or Legato, offset, swing,
humanize, probability, conditions, locks, Follow Actions, scenes, MUTATE and
the seed.

- `PLAY` (integer, −1 to 63): the notes of the material that start in one of
  its slots — a slot being as long as the channel's step, counted round the
  material's length — each with its own offset and duration. −1 is the step's
  own slot, so a channel of sixteen sixteenths replays a one-bar material as it
  was; a fixed value, a range or a list reorders the material and picks from
  it.
- `NOTE` (integer, 0 to 255): the Nth note of the material in the voice's
  order — as played, rising, falling, or shuffled once per loop by the seed —
  lasting the step times the gate. In Legato, the same value on the next step
  holds the note; its release is `NOTE_OFF`.
- Rule commands, each playable by a channel of its own: `TRANSPOSE`, `OCTAVE`,
  `ROOT`, `SCALE`, `VELOCITY`, `GATE`, `DENSITY`. They set the live value; a
  scene recall and STOP put back the scene's.
- The rules, per scene and per voice (STORE SCENE copies them): the MIDI
  channel; root and scale (the arpeggiator's eleven scales, one table for
  both); transposition, ±48 semitones; an octave shift, ±3, and a random
  octave spread, 0 to 3, with its chance; a lowest and a highest pitch, a note
  outside folded in by octaves; velocity scale (0 to 200 %), random spread
  (0 to 127), lowest and highest velocity (1 to 127); gate scale (5 to 400 %),
  random spread, shortest and longest duration (a sixty-fourth to 64 beats);
  the order; density, the chance each note of the material plays; at most 32
  notes sounding per voice, the rest refused and counted.
- The same seed, material and sequence play the same notes, whatever the block
  size.
- A step's notes enter the destinations at the step's own sample. Each note is
  kept in the voice's registry of sounding notes until its Note Off is given,
  at its own sample.

**The writer — generations into the Sequencer** — a fifth internal target,
`one-ring:writer`.

- `WRITE`: what the voices played in the last 1 to 16 bars before the step
  (the writer's window; the take holds at most 1,024 notes) becomes a
  generation of at most 256 notes — what a material keeps, since feedback
  makes one of it. A step at the start of a bar is the musical boundary. What
  is written is what was heard: density thins notes before they play, not
  before they are written, and a note a panic cut is written cut. The voices
  render up to the WRITE's sample first, so the window ends there exactly; at
  the same step, a lower channel acts before a higher one, so a WRITE on CH1
  hands its feedback to a PLAY on CH2 in that same step.
- The engine sends the generation to the renderer (`oneRingWrite`: node,
  runtime generation, number, notes and length, and where the arrangement
  stood at the step), which writes it through
  `SequencerController`, where a take becomes a clip. *New* adds a MIDI track
  for each generation, named after the node and the generation number, with
  the generation as its one clip, where it was heard — the transport's
  position at the step, less the window, never before zero; with the transport
  at rest, at the playhead. The track has no Destination unless the writer
  names a node of the Patch Bay; a new track is where the author gives a
  generation an instrument of its own (answer 1). At the Sequencer's 64 tracks,
  *New* is refused and reported. *Replace* and *Add* change the notes of the
  named clip, *Add* skipping duplicates. `SequencerModel` gains the one
  operation it lacks — replace a clip's notes — used here and offered to the
  Clip Editor's protocol. Each write is one undo step and marks the project
  modified, as a take does (answer 3).
- A clip being played is rewritten one timer tick and one IPC round after its
  step, tens of milliseconds: a note of the new content that starts inside
  that gap is not heard in that pass.
- `FEEDBACK_ON` and `FEEDBACK_OFF` (and a setting): with feedback on, a
  generation replaces or joins the current generation (a setting) in the
  engine, at its `WRITE`, no sooner than the delay after the previous one (0 to
  64 bars), and no more times than the limit (1 to 999). The material takes the
  generation the engine sent, whether or not the renderer could write it; a
  refused write is reported. At the limit, feedback turns itself off and the
  status says so. The origin is never touched, and frozen material takes
  nothing.
- No instant loop: a generation reaches the voices at their next steps, never
  inside the tick that wrote it, and the scheduler's per-tick guards cover the
  new targets as they cover the old.
- A generation written onto a track whose Destination is this node comes back
  through MIDI IN only while a capture is armed. That is the second, audible
  way round, and the only one through the Sequencer.

**When things happen**

| What happens | Voices | Capture | Writer and feedback |
|---|---|---|---|
| RUN, the transport's Play, a resume | play with their channels | not armed by it | — |
| STOP — One Ring's, or a Stop a person gives | every sounding note ends at once: Note Off, no All Sound Off | ends, and keeps what it took | nothing more is written; a feedback waiting for its delay is dropped |
| The transport stops for a sequence's STOP | play on, as its commands do today | goes on | goes on |
| Seek, return to start, loop wrap | sounding notes end (a seek is not a panic); the sequence moves with the arrangement, as today | goes on, on its own count | the take goes on, on its own count |
| Scene recall | notes ring to their end; Legato ties end as a channel's holds do; the scene's rules apply from the recall's beat | — | — |
| MIDI OUT cables change | the old destinations get their Note Offs first | — | — |
| Node deleted, project closed, engine stopping | every sounding note ends before the runtime goes | dropped | dropped; a generation arriving for a project no longer open is refused |

**A sync that keeps the routing** — the change the writer needs first (step
10). Each track's sounding notes are kept across plans, per track, by the audio
thread. A sync that changes clips only gives Note Off to the notes of the
tracks whose clips changed — no All Sound Off — and chases them, as a seek
does. Arpeggiators and every other chain are left alone. A sync that changes a
track's routing panics as today.

**Status and requests** — the status gains: capture (off, armed, capturing,
notes taken); the material (origin and current counts, frozen, revision); the
generation number; feedback on or off and why it went off; a write in flight;
writes made and refused, and the last refusal; notes sounding and refused per
voice; each voice's live rule values. `describe` shows each One Ring's status.
Requests: step 9's vocabulary, then each step's own words, all calling the
functions the page calls (`oneRingEdits.js`, `hub.oneRing`), documented in
`../minihub-agent/AGENTS.md` as they are built.

**Chosen here; the author may overturn any** — four voices; rules per scene,
so a scene can change the harmony; the origin kept beside the current
generation; a generation is what was heard over the window; loading a clip is
done from the page or the agent, not from a step.

**The author's answers, 2026-09-17** — to the three questions asked that day:

1. *Where a New generation goes*: "Dans une nouvelle piste, ce qui permet
   ainsi même de créer de nouveaux Omniboxes avec de nouveau VST" — a track of
   its own, which can then be given a new VST node. Whether One Ring should
   create that node itself is not asked for, and not planned: the author, or
   an agent, cables it.
2. *The export, which holds the clips and not what One Ring plays live*: "on
   peut imaginer une piste audio qui enregistre tout depuis le début". That
   exists: an audio track armed on a node cabled into the Sequencer's AUDIO IN
   (a Mixer gathering the instruments One Ring plays) records from the start,
   and the export plays the take. A Sequencer sync keeps an audio take going
   (the track's writer is the same object across plans). Step 17 checks it.
   What follows from it: the take ends when the transport stops, a sequence's
   STOP included; a later playback sounds the take and One Ring together.
3. *One undo step per generation*: "Ne te soucie pas des étapes
   d'annulation" — as proposed, nothing special.

**The author's second round, 2026-09-17** — after reading what steps 9 to 13
built:

1. "Tu peux écrire la nouvelle page en restant dans le même style. Si il n'y a
   pas assez de place, tu peux aussi explorer la possibilité d'onglets." The
   page of part two is written in the faceplate's style with no still first;
   step 14 is waived.
2. "Pour le moment mets la création de node par le One Ring de côté, il faut
   que je repense le truc." Set aside (*Out of scope*).
3. "Il faut plus de scènes disponibles. Pour le moment il y a A B C et D, il
   faudrait donner la possibilité de faire A1, A2, A3 etc." Step 15.

**Scenes A1 to D8** — what the third answer becomes.

- The four letters the deck has now, A to D, each with eight numbered scenes:
  32 in all. A scene's id is its place, `A1` to `D8`; its name, `Scene A1`.
- A scene exists once it is chosen or stored into, and the content keeps only
  those: an empty scene is 8 KB of content, and the content is copied into
  every undo step. A new node has A1, B1, C1 and D1, the four scenes it had.
- The list of scenes only grows. A scene's index is what a RECALL value, a
  scene command and the status carry, and a list that only grows never moves
  one under a running sequence. A RECALL takes one scene or a list of them,
  never a range (the VST's rule for choices), so the list's order carries no
  meaning; the page and the requests show scenes by their place. Removing a
  scene would move the indices after it, and is not built.
- A sequence saved with the VST's four scenes, `A` to `D`, opens with them as
  A1, B1, C1 and D1, in the same order: its recalls are unchanged. A scene
  whose id is no place takes the first free one.
- The deck: a row of letter keys and a row of number keys for the letter
  shown. A number with no scene is dark; choosing it creates the scene, empty,
  and recalls it. STORE then a number copies the scene shown there, creating
  it if need be. The letter shown follows the scene that plays, until a letter
  key is pressed.
- The engine takes up to 32 scenes and refuses more; the renderer refuses more
  before it sends them.

## Steps

- [x] 0. The slot and the documents pointing at it: `bindings-bar-docked.md`
      moved to `plans/done/` on standby (step 8, its documents, is what it has
      left); this plan in `plans/active/`; TASKS.md and ROADMAP item 7 say the
      work has started.
      Check: `npm test` (1119) + `npm run check` (15 rules) — **green 2026-09-16**
- [x] 1. Native core: One Ring's `src/core/` into
      `native/audio-engine/src/one_ring/`, namespace `mlh::one_ring`, behaviour
      unchanged; `tests/core_tests.cpp` into `native_tests.cpp` as
      `[core] one-ring-*`, plus fixed `Random` values that step 3 checks again.
      Check: `npm run build:native` 0 errors 0 warnings +
      `mlh_native_tests.exe --core` (1463 checks) + `npm test` (1119) +
      `npm run sync:dist` — **green 2026-09-16**
- [x] 2. Native runtime: `OneRingRuntime` does the `Processor`'s work without a
      plugin — plan published and swapped at a block boundary; `advance` in the
      callback on the live `Transport` (Play starts it, a seek shifts its
      timeline, after Stop it keeps the last tempo until its own STOP); RUN,
      STOP, channel and scene commands in; events out through a lock-free queue
      that `timerCallback` drains as `controlEvents` carrying `nodeId` and
      `generation`; a status at the timer's pace. The content's JSON read with
      defaults for absent cells. Engine commands `syncOneRing`,
      `setOneRingTargets`, `oneRingCommand`, added to the policy. Native tests:
      a sequence on a test transport emits its events at their beats; a new plan
      keeps playback going; STOP releases a held Legato.
      Check: build 0/0 + native tests + `npm test`
      Done as `one_ring/runtime.*` and `one_ring/state_json.*`, plus
      `removeOneRing`, and `src/main/oneRingCommand.js` for the four commands'
      shape. Build 0 errors 0 warnings; `--core` (1517 checks), `--vst3-e2e`
      (99), `--cross-track-isolation` (27), `mlh_realtime_output_tests` (2535);
      `npm test` (1125); `npm run check`; `npm run sync:dist` —
      **green 2026-09-16**
- [x] 3. Renderer model, `core/oneRingRandom.js` and `core/oneRingSequence.js`
      (flat, like `arpeggiatorState.js`): defaults, the VST state to content and
      back (a sparse content, with each channel's `blank`), validation with
      `model.cpp`'s rules against the compiled targets plus One Ring's own
      channel and scene commands, `Random` in BigInt checked against step 1's
      values, MUTATE, NEW SEED, a command change and STORE SCENE as the VST's
      editor does them. MUTATE's results checked in C++ too, with the values the
      JS draws.
      Check: `npm test` + build + `--core`
      Done: `npm test` (1140, 15 new), `--core` (1523 checks, MUTATE's values
      among them), `npm run check`, `npm run sync:dist` — **green 2026-09-16**
- [x] 4. The node: type `one-ring` (MIDI category, CTRL OUT), its content the
      sequence; `engineSync` sends it on change and after an engine restart;
      `CommandBus` takes a native source beside plugin sources — targets
      published with `setOneRingTargets`, events dispatched, holds released as a
      plugin's are; a plain status panel with RUN, STOP and the four scenes.
      Tests on the control rig: a native `controlEvents` moves a cabled mixer's
      master; a pulled cable stops it.
      Check: `npm test` + `npm run check` + `npm run sync:dist` + seen in
      MiniHub: a sequence stepping a mixer's master
      Done: `npm test` (1151), `npm run check`, `npm run sync:dist` —
      **green 2026-09-17**. The engine was driven over its real stdio protocol
      (`dist`'s `mlh-audio-engine.exe`, a script speaking what the renderer
      speaks): sequence and targets taken, RUN giving a MASTER command every
      quarter beat with the cells' values, a channel STOP, STOP, a stale
      generation refused, the node removed. **Not yet seen: renderer and engine
      together in MiniHub** — it touches a project, so it moves to step 5, with
      the author.
- [x] 5. From the VST: a VST node holding One Ring offers to copy its sequence
      into a new One Ring node, and its CTRL OUT cables move to it.
      Check: `npm test` + seen in MiniHub with one of the author's sequences.
      **The author tries the native One Ring here.**
      Built 2026-09-17: `core/juceState.js` reads a plugin state as
      plugin_host.cpp writes it, `core/oneRingImport.js` copies (the live state
      when the plugin runs), a "Copy to One Ring node" button on a One Ring card
      of the VST node's page. `npm test` (1158), `--core` (1528, JUCE's base64
      and state layout among them), `npm run check`, `npm run sync:dist` — green.
      Tried by the author 2026-09-17, a node made from the OmniBox menu: it
      is there and its sequence runs — step 4's renderer and engine seen
      together. Two faults, fixed the same day (log): scenes that stopped
      answering, and a transport Stop that did not stop the node. The
      author's second try, the same day: "c'est bon". **Not seen in the
      application: the copy from a VST** — its reader is checked against the
      three real states on disk.
- [x] 6. The design, before the page: a still of the faceplate after the
      author's references — transport and scenes, the 16 channels, the 64-cell
      grid as lit pads, the channel's settings, the cell's settings — drawn with
      the faceplate's tokens and shown to the author.
      Check: his go. **The author decides here.**
      Drawn 2026-09-17 (log): the page at the size of the arpeggiator's on the
      author's screen, with `omni-pearl.css` and a proposed section of new
      tokens and parts. The author's go, the same day: "c'est bon, écris la
      vraie page". The still is `docs/design-references/one-ring-faceplate.png`.
- [x] 7. The page, playing half: channels, the grid with playheads and its four
      cell appearances, the channel's settings, RUN and STOP, RESTART CH and
      STOP CH, scenes.
      Check: `npm test` (domShim) + `npm run check` + `npm run sync:dist` + seen
      Built with step 8, 2026-09-17 (log). `npm test` (1176), `npm run check`,
      `npm run sync:dist` — green; tried in a browser on a fake engine.
      The author, 2026-09-17, after trying it: "Oui la nouvelle page de One
      Ring fonctionne bien". **Done.**
- [x] 8. The page, authoring half: the cell (active, probability, value modes,
      conditions, locks), Follow Actions, seed, NEW SEED, MUTATE, STORE SCENE,
      scene timing and position.
      Check: same as step 7
      Built with step 7; same checks, the same word from the author. **Done.**
- [x] 9. Requests: the node answers the VST's vocabulary (describe, status,
      targets, get, set, run, stop, channel, scene, copy-scene, mutate,
      new-seed) from its content, so what programmed the VST programs it; its
      `status` and `describe` read what the running node last reported
      (playing, scene, the recall waiting, beat, tempo, playheads, activity,
      refused and guarded, the last refusal). Written up in
      `../minihub-agent/AGENTS.md`.
      Check: `npm test` + `npm run check` + `npm run sync:dist` + a running
      node's status read through the channel
      Done 2026-09-17: `core/oneRingRequests.js`, kind `one-ring` in
      `agentRequests.js` (gated on the project, as `plugin`), `status` on a
      One Ring in `describe`, the last refusal kept by `oneRingNodes.js`. The
      page's edits moved to `core/oneRingEdits.js` so that both use them.
      `test/oneRingRequests.test.mjs` (7 tests); `npm test` (1183),
      `npm run check`, `npm run sync:dist` -- green. The client
      (`../minihub-agent/minihub.mjs`) stamps `one-ring` with the project id;
      the manual's One Ring section now describes the node. **Not done: the
      status read from a running MiniHub** -- the author's machine was not
      driven while the author was away; step 17 does it.

**Part two — notes.** Each step leaves the node working as before for a
sequence that plays no note, and brings its own requests and tests; the page
comes last (step 16; the author waived the still of step 14).

- [ ] 10. A Sequencer sync that keeps the routing stops panicking
      (*Part two — design*): sounding notes kept per track across plans, a Note
      Off and a chase for the tracks whose clips changed, the rest left
      sounding; a routing change panics as today.
      Check: build 0 errors 0 warnings + the four native binaries — new
      `[core]` checks: a changed clip gives its own track's notes a Note Off
      and nothing else, a note on another track and an arpeggiator's go on,
      no All Sound Off reaches a chain; a changed Destination still panics +
      `npm test` + heard by the author: a note edited while a pad plays leaves
      the pad sounding.
      Built 2026-09-17: each plan names the plan it was compiled against and
      what becomes of each of its tracks; the callback takes that over
      (`adoptLivePlan`) and `reclaimPlans` keeps the plan it played last until
      it has. A track added keeps the routing; a track removed or sent
      elsewhere panics. Two edits between two blocks release and chase every
      track. `sequencerSynced` carries `keptRouting`, and the startup log
      prints it. Build 0 errors 0 warnings; `--core` (1568 checks, the new
      `sync-keeps-routing` among them, which fails with the carry taken out),
      `--vst3-e2e` (99), `--cross-track-isolation` (27),
      `mlh_realtime_output_tests` (2535); `npm test` (1183), `npm run check`,
      `npm run sync:dist`. The real engine over stdio: a first arrangement,
      then a note changed while playing and a track added (kept), then a track
      sent elsewhere (not kept), no error. **Not heard yet by the author.**
- [x] 11. MIDI IN and the material: the node's MIDI IN and MIDI OUT ports; One
      Ring as a track's Destination, the end of a MIDI thru walk, an input for
      a cabled controller; its destinations described and handed to the
      runtime; capture, load, freeze, revert, clear; the material in the
      content with defaults, restored with the sequence, reported back by the
      engine; their commands in the policy; their requests.
      Check: build 0/0 + the four binaries — capture: a chord, overlapping
      notes, the same pitch twice, velocity 0, a note held at the end and one
      held before the start, Add's duplicates, the 256-note cap, a loop wrap
      during a capture, the same material for blocks of 32, 256 and 1,024
      samples + `npm test` — a VST-era content and a step-8 content open
      unchanged; material and settings survive a save and a reopen; a MIDI
      track offers One Ring as Destination; the MIDI description lists its
      destinations + `npm run check` + `npm run sync:dist` + the real engine
      over stdio: a track aimed at One Ring plays a clip and the status
      reports its notes captured.
      Done 2026-09-17. Native: `one_ring/material.*` (the lists, fixed
      capacity), `one_ring/capture.*` (the capture, fed a block at a time in
      sample order; the scheduler tells the runtime where each tick falls,
      `EventSink::reach`, so a step's capture and the notes around it keep
      their order), the runtime's material and live notes,
      `setOneRingMaterial`, `oneRingMaterial`, the status's capture fields;
      a track pushes into One Ring as into an arpeggiator
      (`MidiProcessorInput`), and One Ring now runs between the Sequencer
      and the arpeggiators. Renderer: the ports, the thru walk ending at One
      Ring, its MIDI destinations described (the engine takes them at step
      12), a track's Destination, a controller's notes, the material and the
      capture's settings in the content, sent apart from the sequence and
      taken back as an edit, the requests (`material`, `set-material`,
      `capture`, `capture-end`, `clear`, `freeze`, `unfreeze`, `revert`, and
      `capture` in `set`). Build 0 errors 0 warnings; `--core` (1611 checks:
      `one-ring-capture`, `sequencer-feeds-one-ring`), `--vst3-e2e` (99),
      `--cross-track-isolation` (27), `mlh_realtime_output_tests` (2535);
      `npm test` (1199, `oneRingMaterial.test.mjs` among them),
      `npm run check`, `npm run sync:dist`. The real engine over stdio: a
      sequence whose first step captures, a track aimed at the node playing
      C, E, G and D, the four notes reported at their ticks (0, 0, 0, 1920),
      a frozen material refusing CLEAR, the node removed -- 12 checks. Not
      seen in MiniHub: the page shows none of it until step 16.
- [x] 12. MIDI OUT and the voices: `PLAY`, `NOTE`, the rule commands and the
      per-scene rules, their draws, notes sent at their sample to the
      destinations, One Ring run before the arpeggiators, the registry of
      sounding notes and every row of the table; their requests.
      Check: build 0/0 + the four binaries — sixteen sixteenths of `PLAY −1`
      replay a one-bar material note for note; transposition, scale, octave,
      pitch limits, velocity, gate and density each change the notes as the
      design says; the same seed plays the same notes across runs and block
      sizes; a scene recall changes the rules at its beat; every Note On has
      its Note Off after STOP, a person's Stop, a seek, a loop wrap, a Legato
      release, a destination change and a node removed; the polyphony cap
      counts what it refuses + `npm test` + `npm run sync:dist` + the real
      engine over stdio: the notes reach a chain's MIDI.
      Done 2026-09-17. Native: `one_ring/voices.*` (the rules, the notes waiting
      and sounding, rendered block by block in time order, a note landing on
      the sample nearest its beat whatever the block size), `scales.h` (the
      Arpeggiator's table, now read by both), the voices' targets among One
      Ring's own, the rules per scene in the sequence, the runtime's outputs
      (chains, arpeggiators, hardware) handed over by `syncMidiNetwork` only
      when they change, and taken over with a Note Off on the old ones; a
      node removed plays on until the callback has ended its notes; a panic
      makes it forget them, a seek releases them. New random streams (Voice,
      Order) after the VST's four. Renderer: the voices in each scene, their
      targets (the engine's, range for range), `setVoice` and
      `setVoiceRule`, STORE SCENE copying them, the status's `sounding`,
      `notesRefused` and live rules, the requests `voices` and `set-voice`.
      Build 0 errors 0 warnings; `--core` (1647 checks, `one-ring-voices`
      among them), `--vst3-e2e` (99), `--cross-track-isolation` (27),
      `mlh_realtime_output_tests` (2535); `npm test` (1205,
      `oneRingVoices.test.mjs` among them), `npm run check`,
      `npm run sync:dist`. The real engine over stdio, with MiniHub's
      deterministic test instrument and the master turned down to -100 dB:
      silent before RUN, a pre-master peak of 0.95 once the voice plays,
      two notes counted sounding, nothing refused; STOP leaves nothing
      sounding and the instrument silent; a node removed while it plays
      leaves the instrument silent -- 12 checks. Found while testing: a
      note ending exactly on a block boundary was sent a sample early;
      a note now belongs to the block its rounded sample falls in.
- [x] 13. The writer and feedback: `WRITE`, the take, `oneRingWrite`, New,
      Replace and Add through `SequencerController`, the model's operation to
      replace a clip's notes, refusals, `FEEDBACK_ON` and `FEEDBACK_OFF` with
      their bounds, STOP dropping what is not written; their requests, with
      the author's answers (*Part two — design*).
      Check: build 0/0 + the four binaries — the take holds exactly what was
      played in its window; the caps hold; feedback respects its delay, stops
      at its limit and leaves the origin + `npm test` — a write changes only
      its named clip, every other clip identical; a clip gone or of another
      type is refused and reported; one undo step per write, and undo puts the
      clip and the material back; a reopened project keeps material, rules and
      writer + `npm run check` + `npm run sync:dist` + the real engine and the
      renderer together: a generation written while the transport plays, and
      no All Sound Off in the engine's log.
      Done 2026-09-17. Native: `one_ring/take.*` (the last 1,024 notes the
      voices played, on a clock of their own), the writer's target and
      commands, generations queued to the timer and sent as `oneRingWrite`,
      feedback in the engine with its mode, delay and limit, the writer's
      settings read from the sequence, the status's writer fields. Renderer:
      the writer's settings in the content (`mode`, `clipId`, `destination`,
      `bars`, feedback's four, `written`), of which the engine is sent only
      its own (`engineSequence`), so choosing where generations go publishes
      nothing; `one-ring:writer` among the node's targets;
      `SequencerModel.replaceMidiNotes` and `addMidiNotes`, also the Clip
      Editor's `replace-notes` and `add-notes`;
      `SequencerController.writeGeneration`; the node writing a generation
      and counting it in the same turn, refusals counted with their reason;
      the requests `writer`, `set-writer`, `write`, `feedback`, and the writer
      in `set` and `status`. Build 0 errors 0 warnings; `--core` (1689 checks:
      `one-ring-writer` among them, whose generations across blocks of 32 to
      1,024 samples differ once the take puts a note at its block's start),
      `--vst3-e2e` (99),
      `--cross-track-isolation` (27), `mlh_realtime_output_tests` (2535);
      `npm test` (1219, `oneRingWriter.test.mjs` among them),
      `npm run check`, `npm run sync:dist`. The real engine driven by the
      renderer's own modules in Node (the hub, the node, the Sequencer
      controller, main's validators on every command), 26 checks: a voice
      transposing by 2 and a WRITE on every bar, feedback limited to two --
      four generations written as four tracks at beats 0, 4, 8 and 12, note
      for note (62 66 69 74, 64 68 71 76, then 66 70 73 78 twice, feedback
      having stopped at its limit), the origin untouched; every Sequencer sync
      a write made kept the routing, so nothing was silenced, a new track's
      Destination cabled on the way included; the writer turned to Replace
      while playing, the next generation replaced the first clip's notes and
      nothing else, with no sequence republished; nothing written after Stop;
      undo gave the first clip its notes back. **Not heard by the author; the
      page shows none of it until step 16.**
- [x] 14. The design of part two, before its page: a still of what the page
      gains — MIDI IN and the capture, the material (origin and current
      generation), the four voices and their rules, the writer and feedback —
      in the faceplate, after the author's references, shown to the author.
      Check: the author's go. **Waived by the author on 2026-09-17**: the page
      is written in the faceplate's style directly, in tabs if it needs them
      (*The author's second round*).
- [x] 15. Scenes A1 to D8 (*Scenes A1 to D8*): the ids, the reading of a
      four-scene sequence, a scene created when chosen or stored into, the
      engine's limit, the deck's letter and number keys, and the requests
      naming and creating scenes.
      Check: build 0/0 + the four binaries — a 32-scene sequence is taken and
      a recall reaches its last scene, a 33rd scene is refused + `npm test` —
      a four-scene content opens as A1 to D1 with its recalls unchanged;
      choosing an empty number creates the scene and recalls it; STORE into
      an empty number creates it as a copy; the requests name scenes as
      `A1` (and `A` as `A1`) and create them + `npm run check` +
      `npm run sync:dist` + the real engine over stdio: a sequence of 32
      scenes, how long it takes to publish, a recall of the last.
      Done 2026-09-17. Renderer: the places and their order
      (`SCENE_PLACES`), `addScene`, `storeSceneAt`, `sceneIndex`, the VST's
      letters read as their first number and written back as letters,
      RECALL's choices listed in the deck's order; the deck's letter and
      number keys (`bank`, `place`) and one live legend; the requests
      `new-scene`, `copy-scene` into a free place, scenes named by place
      (`A` being `A1`) and listed by `describe` and `get`. Engine: at most 32
      scenes, refused before they are laid out. Build 0 errors 0 warnings;
      `--core` (1697 checks, `one-ring-scenes` among them: 32 taken, the
      32nd recalled at rest and played by its own rules, a 33rd refused
      both as a project and as a state), `--vst3-e2e` (99),
      `--cross-track-isolation` (27), `mlh_realtime_output_tests` (2535);
      `npm test` (1227, `oneRingScenes.test.mjs` among them), `npm run check`,
      `npm run sync:dist`. The real engine over stdio, 7 checks: 32 worked
      scenes (1 MB of content) taken, published in 72 ms each, a 33rd
      refused, the 32nd recalled while running. Two costs found and fixed
      (log): an edit of such a node took 300 ms in the renderer, now 29; the
      renderer sent sequences faster than the engine reads them, now one at a
      time. **Not seen yet in a browser or in MiniHub: the deck's keys** --
      with step 16's trial.
- [x] 16. The page of part two, in the faceplate's style and in tabs if it
      needs them: the capture and the material, the four voices and their
      rules, the writer and feedback; the controls call what the requests
      call.
      Check: `npm test` (domShim) + `npm run check` + `npm run sync:dist` +
      tried in a browser on a fake engine + the author's trial in MiniHub
      Built 2026-09-17: four tabs under the deck. SEQUENCE is the page as it
      was. MEMORY: the capture (CAPTURE, END, what it takes, its length, its
      state and count) and the material (the origin or the current
      generation drawn as a roll, FREEZE, REVERT, CLEAR, a Sequencer clip
      loaded as the origin). VOICES: the four voice keys with their LEDs,
      the rules of the scene shown in five groups -- pitch, range,
      velocity, length, playing -- what the running voice plays by now, and
      a reset. WRITER: WRITE and FEEDBACK, what was sent, written and
      refused, where generations go (a new track and what it plays, or a
      clip to replace or add to), the window, and feedback's setting, mode,
      delay and limit. `modules/oneRing/oneRingParts.js` holds the pieces
      and one table of knobs, `oneRingNotes.js` the three new tabs; the body
      is a region that changes with the tab. `npm test` (1232, the page's
      24 among them), `npm run check`, `npm run sync:dist`. In a browser,
      the renderer served locally with a fake engine that captures, sounds
      and writes: every tab at 1920 and 1280 px, nothing past the page's
      edge; a capture armed, then capturing, then over, its notes on the
      roll; a clip loaded; FREEZE; a knob dragged with the mouse and stepped
      with the keys; notes typed by name, a lowest taken down by its
      highest; the order chosen on the selector's print; a voice's live
      rules; the writer set to replace a clip, writing into it and nowhere
      else; feedback turned off from its key. Found and fixed: the tab keys
      were named by their hints; a generation's clip was listed with its
      track's name twice.
      **Tried by the author in MiniHub, 2026-09-17**: "tout fonctionne bien",
      with two faults, fixed the same day. Every menu opened white: nothing
      declared `color-scheme`, so Chromium painted its own popup lists light
      against the dark plate -- the shell says `color-scheme: dark` now, the
      fields it paints light keep the dark text that came with them, and the
      faceplate gives its lists its own surface -- and that was not enough:
      the author saw white menus still, because the list a select opens is a
      window Chromium draws itself, which on Windows follows the application's
      theme and not the page's. The main process says `nativeTheme.themeSource
      = 'dark'` now. **Not seen from here**: a native popup is outside the page,
      so no bench can show it; the author looks. And keys sat on their
      printed legends, with knobs adrift among the fields: a legend has air
      now, a knob stands apart from a list behind a separator, the writer's
      window sits with the keys it belongs to, and a voice's lists keep a
      width their words fit in. **Not seen by the author since the fix.**
- [ ] 17. The demonstration, with the author: a project made for it (a short
      source clip and no arrangement, a One Ring, an instrument, a track for
      the generations, an audio track recording from the start) and the
      brief's eight points, each seen or heard; the export holds the take.
      Check: the eight points written in the log, each with how it was seen,
      and what was not
- [ ] 18. Documents: a DECISIONS entry (where the clock runs, why the content
      is the VST's state made sparse and how its scenes grew past the VST's
      four, which Stop stops it), D-016 to D-018 and
      INTENT §8 bis naming One Ring, ARCHITECTURE §5, §6, §7, §10 and §12,
      AGENTS.md §6 and D-037 (the faceplate is no longer the arpeggiator's
      alone). For part two: DECISIONS entries (One Ring plays notes as a MIDI
      processor of the engine; a written generation is authored and reaches
      only the clip or track its writer names; a sync that keeps the routing
      releases instead of panicking), ARCHITECTURE §6, §7, §8 and §9, and
      INTENT §8 bis's wording, now that One Ring plays notes. ROADMAP item 7
      to Done, the TASKS entry removed, this plan to `done/`.
      Check: every command under *Done when*

## Fallback point

`e56f0fb` — before this workstream: everything green, `dist/` synchronised
(the sources have not changed since the 0.3.0 release). Steps 1 to 4 add a node
type and change nothing an existing project uses; step 5 is the first that
touches a project's cables, and only on the author's click.

Part two starts from the commit that planned it, after `4183c6d`. Step 10
changes what every project does on a Sequencer sync: it is committed alone, so
that it can be reverted alone.

## Done when

`npm test`, `npm run check`, `npm run sync:dist`, `npm run build:native` with 0
errors and 0 warnings, and the four native test binaries. Plus what no command
proves:

- a sequence copied from the VST, seen commanding the same targets at the same
  steps in the native node;
- the page, approved by the author;
- the author's three answers built as the design records them;
- the brief's eight points, seen or heard with the author in the demonstration
  project (step 17).

## Log

2026-09-16 — Plan written after reading One Ring 0.4 whole: the core, the
processor, the state, the editor's controls, the requests. The core was written
for an audio thread and a registry it does not own, which is what makes a port
cheap: MiniHub already compiles the registry (`CommandBus`) and already carries
the packets (`controlEvents`). What changes is who produces them. The VST state
is kept as the reference format and made sparse for the node, since a full state
is about 700 KB.

2026-09-16 — Step 1. The core compiles in the engine and in the native tests
with no warning at /W3; One Ring built it at /W4 /WX already. A normalised diff
against the four source files shows two differences, both deliberate:
`Engine` is `Scheduler` here, since this engine already has an `Engine`, and
`Project::sceneTiming` and `scenePosition` start as Immediate and Restart
instead of indeterminate (the VST always set them itself). The fixed `Random`
values were computed with a BigInt copy of the algorithm in Node and pass in
C++ unchanged, so step 3's port has its reference already. A scheduler carries
about 250 KB of fixed event storage: the tests allocate each one rather than
stack two.

2026-09-16 — Step 2. The runtime is the VST's `Processor` without the plugin:
the same lock-free plan swap with a readers count, the same clock rules, the
same queues, the engine's `Transport` where the VST had a host playhead. Three
things were settled while building it:

- The engine checks a sequence against One Ring's own targets only. A value a
  cabled target would refuse stays authored, and the scheduler counts it as
  refused when its cell plays: the VST refused a whole saved sequence over one
  such cell, which is what made CommandBus publish targets after the state.
- `syncOneRing` says whether it restores. A restore takes the saved scene; an
  edit keeps the scene that is playing, as the VST's `project()` did.
- Each channel of the content has a `blank`: the cell every unlisted index
  holds. Choosing a command gives all 64 cells its default value, so a content
  listing the cells that differ from an empty one would list them all again.

The tests found one defect: a sparse channel with nothing programmed arrives as
an empty list, which the reader took for a truncated whole one. Fixed: an empty
list is sparse. What the tests do not reach: the four engine commands and the
timer's `controlEvents` and `oneRingStatus` are exercised only through the
runtime they wrap, not through IPC. Step 4 drives them from the renderer.
Messages: `oneRingSynced` (created, generation), `oneRingTargetsStatus`,
`oneRingCommandResult`, `oneRingRemoved`; `controlEvents` with `nodeId` and
`generation`, which CommandBus ignores until step 4 since it has no `chainId`;
`oneRingStatus` on any change, and every 100 ms while playing, kept out of the
startup log.

2026-09-16 — Step 3. `oneRingSequence.js` reads a state the way the engine
does, down to what a missing field reads as (0), so the two sides refuse the
same states; its errors name the field. Every function returns a new content.
MUTATE was the part worth proving twice: the channel in `[core]
one-ring-mutation fixed values` was mutated in JS first, and C++ drew the same
active states, probabilities, integer and float ranges and choice rotation.
`withCells` picks the blank as the cell most cells share, the empty one on a
tie, so the same cells always give the same content — an undo step compares
equal to what it restores. A VST state with two programmed cells on a typed
channel comes out more than ten times smaller.

2026-09-17 — Step 4. `core/oneRingNodes.js` (on `hub.oneRing`) keeps the
engine's runtimes in step with the nodes; CommandBus takes a native source keyed
`native<sep>nodeId`, told its targets by `setOneRingTargets`, its refusals sent
to the node's page as `oneRing:refusal` instead of a plugin window; the node's
page is a plain panel in `modules/oneRing/oneRingPanel.js` (base.css), the one
steps 6 to 8 replace. Two things the tests found:

- A renderer opened while the engine already runs never sees it start —
  `engineClient.init` learns it from a query and emits nothing, and the
  project's nodes load before that. The sequences would never have been sent.
  The device state the client then asks for is the signal, as `engineSync`
  already uses it.
- A refused packet still uses its sequence number, so the next packet needs a
  higher one — the bus's rule, which a test had wrong, not the bus.

Settled while building: a scene the engine reports is written into the
content as performance and not sent back, because a new plan releases what
Legato holds. Real One Ring states read: the three test projects on disk that
hold the VST each decode (JSON at byte 0, JUCE's private data after it), and
Orbites comes out at 55 KB for an 850 KB state, round trip exact. That reader
is step 5's.

2026-09-17 — Step 5, built. A saved plugin state is JUCE's base64 of
`copyXmlToBinary` of a `VST3PluginState` element holding each stream in JUCE's
base64 again; the One Ring component stream is its JSON, then JUCE's private
data (8 zero bytes ... `JUCEPrivateData`). The reader takes the first JSON
object that reads as a One Ring state, so a VST2-compatible header in front
would not stop it. Checked against JUCE twice: the fixture encoder's strings
are JUCE's own (`[core] juce-state`), and the three real One Ring states on
disk decode. The copy moves the VST node's CTRL OUT cables to the new node and
leaves the VST in its chain; its commands are refused from then on, as not
cabled. Not decided, and not done: placing the new node next to the VST node
in the Patch Bay, and bypassing the VST.

2026-09-17 — Step 5, the author's first trial, in a new project with a node
made from the OmniBox menu. The node is there and its sequence runs. Two
faults:

- Scenes stopped answering. The scheduler's guards against a sequence that
  restarts or recalls itself in a loop count per tick, and a tick begins only
  when the clock moves. At rest it does not, so the second scene pressed was
  refused as a loop — and so would a second press on a channel, or RUN after
  one. The VST has the same fault. A command from outside the sequence now
  begins a tick of its own (`Scheduler::beginCommand`); what it sets off is
  still guarded. Two changes on the same ground: at rest, Next bar applies a
  recall at once (there is no bar to wait for, and a pending recall fired
  wherever RUN started), and STOP plays a recall still waiting for its bar
  instead of dropping it. The status carries the waiting scene
  (`pendingScene`), and the page blinks it.
- The transport's Stop did not stop the node. The node plays on after a host
  stop, as the VST did, so that a sequence can stop the arrangement and carry
  on; the header's Stop then greyed out while the node still played. The
  author: "il faudrait que les deux fonctionnent quand elles sont activées
  manuellement". `setTransport` now takes `stopOneRings` with a stop. Every
  Stop a person gives sets it — the header, the Sequencer page, the Clip
  Editor, an agent's request — and the STOP a sequence sends to the
  Sequencer's CTRL IN does not. The header's Stop stays pressable while a node
  plays.

Checked: the new `[core]` checks fail with the fix taken out and pass with it;
`--core` (1545), `--vst3-e2e`, `--cross-track-isolation`,
`mlh_realtime_output_tests`, `npm test` (1159), `npm run check`,
`npm run sync:dist` — green, build with no warning. The real engine, driven
over stdio: four scenes pressed at rest, all taken; a Stop without the flag
leaves the node playing, one with it stops it, whether the transport ran or the
node ran alone; a Next bar recall reported waiting, played on the bar, and
played by STOP; no command refused, nothing guarded.

2026-09-17 — Step 5 done on the author's second try ("c'est bon"). Step 6: the
still, rendered from HTML that loads `base.css` and `omni-pearl.css` as they
are, plus a proposed section 5 whose new colours are all tokens (D-037). What
it takes from the references:

- From the SQ-64, a glass deck across the top: RUN and STOP as large keys, a
  display (scene, bar, tempo, running, a waiting recall, refused and guarded,
  the last refusal, one dot per playing channel), the scene keys A–D with the
  playing one lit and a waiting one ringed, STORE then a scene, the recall's
  timing and position as two levers, the seed with NEW SEED, MUTATE for the
  channel or all.
- From the SQ-64 again, the 64 cells as four rows of sixteen pads in beats of
  four. A pad's bar is lit when the cell is on, over the share of its width
  its probability gives; the playing pad glows, the selected one is ringed,
  small marks say condition, random value and locked, and the pads past the
  channel's length sit recessed.
- From the Programm and the P-6, the channel list as backlit keys with an LED
  for a playing channel and a white key for the one edited, a scribble strip
  for its target, and its whole sequence as a row of LEDs.
- Rotary selectors with their positions printed round them for LENGTH, RATE
  and REPEAT; knobs for OFFSET, SWING and HUMANIZE; a lever for Trigger and
  Legato, Legato struck out when the target has no release.
- Below the pads, the selected cell (ACTIVE, PROBABILITY, the value as Fixed,
  Range or List with the target's range beside it, the conditions as chips,
  the locks) and the channel's Follow Actions in order, with an add row.

Every function of the list in *Context* has its place on it. Not drawn: the
page with no runtime, and a choice target's value.

2026-09-17 — Steps 6 to 8. The author approved the still and asked for the
page. It is the still made to work: `modules/oneRing/oneRingFaceplate.js`
draws it, `oneRingEdits.js` holds what each control does to the sequence (the
VST editor's rules, as pure functions), `oneRingPanel.js` binds it. The new
parts -- key caps, LEDs, LCD fields, scribble strips, rotary selectors, drag
knobs, pads -- are in `ui/omniPearl.js` and section 5 of `omni-pearl.css`,
whose new colours all sit in the token block; the provisional panel's rules left
`base.css`. The node's icon is a ring.

Settled while building:

- The page is five regions, each put in only when its markup changes, and the
  status never redraws: it lights the display, LEDs and playheads in place. A
  full page is about 110 KB of markup, most of it the sixteen sequence strips,
  whose cell boxes are drawn by the sheet so that only a column is written.
- A knob drags up and down (a native range input drags sideways), turns with
  the arrow keys, takes a typed value, and goes home on a double click. Turned,
  it writes every 50 ms so the change is heard; the history folds the burst
  into one step, and the region under the mouse is not redrawn until it lets
  go.
- A scene key recalls through the runtime; with no runtime it chooses the scene
  the file opens in, as performance. STORE arms the scene keys; Escape disarms
  them. At rest, and after STOP, a Next bar recall applies at once (step 5).
- Values are checked against the command as typed, a French decimal comma
  included; a value that does not fit marks its field and writes nothing. A
  range's other end follows the one moved past it. A list of numbers is typed
  with semicolons.
- A new target clears the command, as the VST's editor did; the target lists
  are what CTRL OUT reaches (`CommandBus.targetsFrom`, whether or not the node
  runs) and One Ring's own channels and scenes. A target no longer cabled stays
  authored and is shown struck out.
- The channel and cell being edited are kept per node for the session. Text
  being typed survives a redraw it did not cause, and a written field shows the
  value as the page holds it.
- Narrower windows stack the page: the channel list goes to two columns below
  1500 px, the cell and follow panels stack below 1250 px, and the deck's
  separators go once its groups wrap.

Checked: `test/oneRingPage.test.mjs` (18 tests: the edits, the markup, the page
bound to a recording container); `npm test` (1176), `npm run check`,
`npm run sync:dist`. In a browser (the renderer served locally, a fake engine
answering), with real clicks, drags and keys: RUN lights the display, LEDs and
playheads; a Next bar recall blinks and plays on the bar; a channel, a pad, a
double-click, a printed selector position, a selector's list, a knob dragged
and stepped, a seed refused then taken, STORE, a target and command, a list of
choices, a condition, a follow action, MUTATE, NEW SEED, the levers, the locks,
the channel switch and RESTART and STOP of a channel each did what it says;
focus stayed where it was across redraws. Rendered at 1920, 1500, 1280 and
1000 px wide. Not seen: the page in MiniHub, with the real engine.

2026-09-17 — Part two planned. The author tried the node with Codex ("tout
fonctionne bien") and asked for more, in a brief written with Codex: One Ring as
the generative engine of a piece, capturing notes, transforming them, playing
them, and writing generations back into the Sequencer. The author's instruction:
check that it can be done and prepare it, with no code. Read against the code:
it can be done, and nothing in it crosses an invariant. Three findings shaped the
design (*Context*, found in the code): the arpeggiator already is an engine MIDI
processor that a track feeds at sample accuracy, so One Ring follows it; every
Sequencer sync panics every chain, so a clip written while playing would cut
the whole piece, and step 10 comes first; One Ring's clock jumps with the
arrangement, so a capture keeps its own count. The old steps 9 and 10 became
9 and 17, so that requests serve Codex's tests from the start and the documents
are written once. Whether "tout fonctionne bien" covers the page (steps 7 and 8)
was not said; they stay unticked until it is.

2026-09-17 — Steps 9 to 13, built while the author was away, each committed
alone. What was settled on the way, beyond what each step records:

- A new plan releases what Legato holds, so everything a node's content holds
  that the engine does not run travels apart or not at all: the scene the
  engine reports, the material (its own command, both ways), and where the
  writer puts generations and how many it wrote.
- The engine's `WRITE` renders the voices up to its own sample before it takes
  the window, and a note belongs to the block its rounded sample falls in; the
  same material and sequence then write the same generation whatever the block
  size. A note ending exactly on a block boundary was sent one sample early
  before this (step 12).
- A generation is written and counted in the same turn, with whatever material
  feedback made of it, so undo takes both back. The same notes written again
  into a clip change nothing, so a loop that has settled publishes nothing.
- A new track for a generation takes neither the focus nor the selection: it
  arrives while the author works on something else.
- The bench that drove the engine from the renderer's modules first returned
  `stdin.write`'s back-pressure as the command's result, where main.js answers
  `ok` once written; the node then believed its sends lost and sent them again,
  the old material with them. Main was right; the bench was fixed. The same
  bench, before the Sequencer had ever been synced, saw the first write's sync
  change the routing: the panic cut the note sounding, and the generation kept
  it cut, as heard.

2026-09-17 — Step 15, scenes A1 to D8. A scene in the engine is laid out for
the audio thread: 135 KB (sixteen channels of sixty-four cells), so a plan of
32 scenes is 4.3 MB, and reading a sequence costs about 70 ms per megabyte of
content -- 72 ms for 32 worked scenes, 3 ms for a new node. Measured through
the renderer's own modules, two costs showed that four scenes had hidden:

- An edit of a 32-scene node took 300 ms in the renderer. `nodes.setContent`
  reads every content it is given (`readSequence`), and reading a sparse
  channel laid its 64 cells out with `structuredClone`: 32,768 clones. A
  channel listing fewer than half its cells, in order and none equal to its
  blank, is already in its own form and is now read as it stands, and a cell
  is copied field by field. 29 ms, most of it the JSON comparisons every
  content goes through; a test checks the short way gives the long way's
  result, and fails when either of its two conditions is taken out.
- A knob writes twenty times a second and the engine took 72 ms per sequence,
  so edits queued in the engine and the sound would have trailed the knob.
  `oneRingNodes.js` now keeps one sequence in flight per node and sends the
  newest when the engine answers; a turned knob's last value reached the
  engine 125 ms after the last edit, through 39 sequences for 40 edits.

2026-09-17 — Step 16, the page of part two, written without a still as the
author asked. What was settled:

- Tabs are mode keys under the deck, which stays above them: the transport,
  the display and the scenes are the same whatever is edited. The tab, the
  voice and the material shown are kept per node for the session.
- The rules come as the page's knobs already are: drag, arrow keys, a typed
  value, a double click home. A note is typed by its name (`C4`, `f#2`); a
  capture's length reads `to END` at zero, a feedback delay `none`.
- A lowest pushed past its highest takes the highest along, and the other way
  round, for pitch, velocity and duration: a rule refused would leave the
  knob showing what the voice does not hold.
- Durations are chosen among note values, a sixty-fourth to sixteen bars; a
  value set otherwise, by a request, is shown as it is.
- FEEDBACK's key is what the engine does now; the switch beside the delay is
  the setting. A change of the sequence puts the setting back, as the manual
  says.
- The material's roll is SVG geometry, the page having no style attribute:
  bar and beat rules, C rows lifted, each note with its name, velocity and
  channel in its tooltip.
