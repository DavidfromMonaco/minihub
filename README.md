# MiniLab Hub

A modular desktop music HUB for the **Arturia MiniLab 3** MIDI controller. It
combines a Patch Bay, native JUCE/VST3 audio engine, Mixer, Morpher,
Arpeggiator, and an integrated MIDI + audio arrangement Sequencer.

## Run

```bash
npm install
npm start
```

Requires Node.js and Electron (installed automatically via `npm install`).

## Test

```bash
npm test
```

Runs the Node built-in test runner (`node:test`) against the renderer's core
modules and the Routing editor logic. The renderer is treated as ES modules
for testing via `src/renderer/package.json` (`"type": "module"`); the main
process stays CommonJS and is unaffected.

## Stack

- **Electron** for the desktop shell.
- **Web MIDI API** (Chromium) for physical controller input and configuration.
- **JUCE 9 / C++** for sample-clocked sequencing, audio I/O, recording, VST3
  hosting and master WAV rendering.
- Plain ES modules, no framework, no build step.

## Architecture

```
src/
  main/            Electron main process
    main.js        window + IPC wiring
    settings.js    settings persistence (userData/settings.json)
    preload.js     contextBridge -> window.hubAPI
  renderer/
    index.html     UI shell (header / sidebar / content / modal)
    styles/base.css
    js/
      app.js               bootstrap
      core/
        hub.js             central Hub (events, settings, midi, modules)
        eventBus.js        typed pub/sub bus
        settingsStore.js   renderer settings via IPC
        moduleSystem.js     module registry
      midi/
        midiManager.js      Web MIDI device layer
        parseMidi.js        byte -> normalized message
        minilab.js          MiniLab identification
      ui/
        sidebar.js          auto-populated from registered modules
        header.js           device status
        settingsModal.js
        icons.js
      modules/
        home/              Home overview
        minilab/           MiniLab 3 panel
        routing/           Routing / Patch Bay editor
```

### The Hub

Every module interacts with the app only through the `Hub`:

- `hub.events` — pub/sub bus. MIDI is exposed as normalized events
  (`midi:inputMessage` for per-port recording; selected-input `midi:message`,
  `midi:noteon`, `midi:noteoff`, `midi:cc`, `midi:pitchbend`, `midi:ports`,
  `midi:state`).
- `hub.midi` — device layer (enumerate, select, connect/disconnect, send, timing offset).
- `hub.settings` — persisted preferences.
- `hub.modules` — module registry.

### Adding a module

```js
hub.modules.register({
  id: 'sequencer',
  name: 'Sequencer',
  navEntry: { label: 'Sequencer', icon: '...' },
  mount(container) { /* render UI */ },
  unmount() { /* cleanup + unsubscribe */ }
});
```

The sidebar picks up `navEntry` automatically. Modules subscribe to MIDI via
`hub.events.on('midi:...', ...)` and never touch the raw Web MIDI layer.

## Status

Implemented: device detection, MiniLab identification, input/output selection,
clean connect/disconnect, live MIDI monitoring (note on/off, velocity, CC,
pitch bend, channel), keyboard activity visualization, device
disconnect/reconnection handling, persisted port settings, and a MIDI timing
compensation foundation.

### Timing model

Every parsed MIDI message carries four timing fields (see `midiManager.js`):

- `webMidiTimestamp` — original Web MIDI timestamp (`event.timeStamp`, ms)
- `hubTimestamp` — `performance.now()` at reception (ms, for diagnostics)
- `offsetMs` — configured per-input offset (default `0`)
- `compensatedTimestamp` — `webMidiTimestamp + offsetMs` (the canonical value
  for future timing-sensitive modules; negative = earlier, positive = later)
- `processingDelayMs` — `hubTimestamp - webMidiTimestamp` (diagnostics only)

Compensation is a pure annotation — live processing is never delayed. The
per-input offset is persisted under `inputOffsets` in settings and exposed via
`hub.midi.getInputOffset(id)` / `hub.midi.setInputOffset(id, ms)`.

### Routing graph foundation

The Hub owns a routing graph (`hub.graph`) that is independent of UI focus.

- Node: `{ id, name, inputs: Port[], outputs: Port[], onInput? }`
- Port: `{ id, type: 'midi' | 'audio' | 'control', label }`
- Connection: `{ from: {nodeId, portId}, to: {nodeId, portId} }`

Connections only link a source output to a compatible target input (same
port type); incompatible types and duplicates are rejected. Data flows from a
source node into the graph via `hub.graph.emitData(nodeId, portId, data)`, which
forwards to each connected target's `onInput` — modules never call each other
directly.

A module opts into routing by declaring a `routingNode` descriptor; purely UI
modules omit it. The MiniLab node (`minilab-3`) exposes musical `midi-out` plus
stable `control-k1`…`control-k8` outputs. Factory Arturia/User encoder CCs are
promoted to normalized CONTROL data and therefore do not also enter the
musical MIDI route.
Connections are serialized to settings (`graphConnections`) and restored on
startup.

### Routing / Patch Bay editor

The `routing` module is a visual Reason-style rear-panel cable editor. It is
rendered with native SVG (no framework) and is never the source of truth for
routing:

- Nodes and cables are always derived from `hub.graph`.
- Connections are created/deleted only through the graph API (`connect` /
  `disconnect`), so graph rules (output→input, matching types, no duplicates,
  fan-out) stay authoritative.
- Node positions are view state, persisted separately under the
  `graphLayout` settings key via `core/graphLayout.js`; they never touch
  `hub.graph`.
- The editor subscribes to `graph:change` and re-derives its visual model, so
  changes made anywhere in the app propagate automatically (no polling).
- Ports are distinguished by shape + label + color (MIDI square, AUDIO circle,
  CONTROL triangle). Invalid connections fail cleanly with subtle feedback.

Interactions: drag a node body to move it; drag from an output jack to a
compatible input jack to connect; click a cable then press Delete to remove it.
Cables can also be disconnected two other ways: **Ctrl + click** a cable to
immediately disconnect it, or grab a connected **input endpoint** and drag it
away to unplug it (releasing on empty canvas disconnects; releasing back on the
input keeps it).

Canvas navigation (view state only, never routing):

- Mouse wheel zooms (25%–250%), centered on the cursor.
- Right-drag pans the canvas; the context menu is suppressed while panning.
- The viewport transform is a single `world = pan + screen/zoom` mapping
  applied via the SVG `viewBox`, so node dragging, cable creation and cable
  endpoints stay coordinate-accurate with no drift.
- Viewport state (pan + zoom) persists under the `graphViewport` settings key
  via `core/graphViewport.js`; node positions stay in `graphLayout`.
- A **Reset View** control in the toolbar fits all nodes into the visible area
  (centered, with padding, respecting zoom limits) instead of a fixed origin,
  so the Patch Bay is never empty. Only viewport pan/zoom change.
- On first open with no persisted viewport, the editor auto-fits the existing
  nodes; a valid persisted viewport is restored as-is and never overwritten.

Grid & snapping:

- An effectively infinite world-space grid (minor every 20 units, faint major
  every 100) is rendered as `userSpaceOnUse` SVG patterns tiled across the
  whole plane; the background rects simply follow the viewBox, so the grid
  never drifts relative to nodes and has no finite boundary.
- `GRID_SIZE` (`core/grid.js`) is the single shared constant for both the
  visual grid and node snapping.
- Snap is silent and off by default: left-drag moves nodes freely; holding
  **Ctrl** while dragging snaps to the nearest grid point in world coordinates.
  Ctrl is checked live during the drag, so it can be pressed/released without
  restarting. Snap only affects node positioning — zoom, pan, cable creation,
  selection and deletion are unaffected. No snap UI or setting is added.

### Node types & instances

Users can create multiple independent typed nodes (VST, Mixer, Morpher,
Arpeggiator, Video and Image) via the Patch Bay's **+ New Node** control. The
arrangement Sequencer is a fixed system module and fixed Patch Bay source, not
a disposable dynamic node.

- **Node Type** (`core/nodeTypes.js`) defines identity/capabilities (label,
  accent, icon, ports) and is immutable per instance.
- **Node Instance** (`core/nodeInstances.js`) is the user-created object
  `{ id, type, name, content }`; `content` is reserved for future loading and
  is `null` for now.
- Instances persist under the `nodeInstances` settings key with a per-type
  monotonic counter, so IDs are unique and never reused after deletion.
- Each instance registers a Hub module and a routing node in `hub.graph`. VST
  declares MIDI IN / AUDIO IN / CTRL IN / AUDIO OUT; Mixer and Morpher expose
  dynamic audio inputs; Arpeggiator exposes MIDI IN / OUT.
- Deleting a node removes its instance, routing node (and connections),
  layout entry, and sidebar entry. Native/system nodes (MiniLab) are never
  deletable through this mechanism.
- Responsibilities stay separate: `nodeInstances` owns instances,
  `graphLayout` owns positions, `graphConnections` owns routing.

### VST internal chain

A VST node is a container for an ordered plugin chain (`content: { plugins: [] }`,
see `core/vstChain.js`). The chain lives inside the owning node and is never a
Hub module or Patch Bay node.

- Model operations: `append`, `insert`, `remove`, `reorder`, `setBypass`. They
  affect only the internal chain and never touch `hub.graph`.
- Plugin instances have stable, unique IDs (`plugin-1`, …) that persist across
  reloads.
- `VST_ROLES` (`core/vstChain.js`) is the centralized role registry for the
  internal role color code: instrument `#F5C451`, audio-effect `#EF6A5B`,
  midi-effect `#A78BFA`, utility `#48B8CC`, unknown `#94A3B8`. Roles are visual
  metadata only — real plugin capability discovery will remain authoritative.
- The Patch Bay keeps the VST node compact (name, orange family accent,
  external ports, and a small plugin count); the detailed chain editor opens in
  the foreground.
- The chain is mirrored into the native audio engine, which loads the real VST3
  plugins and performs the audio processing (see the native engine section below).

### CONTROL parameter bindings

MiniLab CONTROL sources map observable physical controls to real hosted VST3
parameters without consuming their native MIDI messages. K1–K8 retain their
original stable identities; F1–F4, the main encoder and click, Pitch Bend,
Modulation, Shift, and P1–P8 have additional stable CONTROL identities.
The graph cable only authorizes a physical source to reach a VST node's single
`CTRL IN`; the node content persists the exact destination:

```text
{ version, sourceControlId, pluginInstanceId, pluginId, parameterId,
  pluginName, parameterName }
```

Only `sourceControlId`, the owning VST node id, stable `pluginInstanceId`, exact
`pluginId`, and VST3 ParamID are identity. Names are display metadata. Native
LEARN captures the next real plugin gesture; a binding then works with the
editor closed. Missing/replaced plugins remain visibly stale and are never
retargeted by name. Updates carry the current native instance generation and
are rejected if that runtime has been replaced.

### Integrated Sequencer

The fixed **Sequencer** sidebar page is MiniHub's only composition-recording
workflow. It owns the project arrangement model while the native JUCE engine
owns musical timing and audio-critical work.

- MIDI and audio tracks share one PPQ timeline, global playhead/BPM/loop and
  the existing Patch Bay. Track destinations create real graph cables.
- MIDI clips retain pitch, PPQ start/duration, velocity and channel. The Piano
  Roll supports create/delete, snap, zoom/scroll, resize and multi-note moves.
- Armed MIDI input is recorded against the native transport with the existing
  per-input compensation and becomes an editable clip on Stop.
- Audio files are decoded/cached by JUCE, displayed with native-derived peaks,
  and support placement, trim, gain, track volume/mute and synchronized loop/
  seek playback. Armed physical or graph sources write real 32-bit WAV takes.
- Master export taps one final PCM stream after VST/Mixer/Morpher, per-node
  protection and Master Gain. A private, non-looping export transport consumes
  a frozen arrangement/routing snapshot; it never seeks, starts, stops or
  restores the live transport. The encoder stage writes WAV (24-bit default),
  MP3 CBR 128/192/256/320 kbps, or JUCE OGG Vorbis quality options. MP3 uses
  the packaged LGPL LAME 3.100.1 executable beside the engine, never an
  installed FFmpeg/LAME. Full/loop ranges, deterministic tails, cancellation
  and successive exports share the same PCM render path.
- Sequencer state is part of the existing `.minihub` project snapshot. Project
  save remains manual; project keys are excluded from application autosaving.

The retired Recorder UI/protocol/node no longer exists. Its reusable threaded
WAV primitive was reduced to `AudioTakeWriter` and is owned by armed Sequencer
audio tracks. Current documented limitations are in
`SEQUENCER_IMPLEMENTATION_REPORT.md`.

Still outside the current scope: sends, sidechains, automation, preset
management, minimap, undo/redo, automatic graph layout and node groups.

## Native audio engine (VST3 + WASAPI)

A separate **native audio engine process** (`native/audio-engine/`, C++ / JUCE 9 /
CMake) hosts VST3 plugins and owns the physical audio output. Audio processing
never runs inside the Electron renderer, and audio samples never cross the IPC
boundary — Electron is the UI / Patch Bay / configuration layer only.

- **Windows x64, JUCE 9, VST3 only, WASAPI Shared Low Latency.** No ASIO, no
  VST2. The engine is launched and supervised by the Electron main process
  (`src/main/engine.js`); if it crashes, Electron stays alive and surfaces an
  engine error state. The engine exits on stdin EOF so it never orphans.
- **VST3 discovery** scans the standard Windows VST3 locations **out of process**
  (a child per `.vst3` file) so a crashing plugin never takes down the engine and
  plugin stdout noise never corrupts the IPC channel. Metadata is read from the
  plugin API (`PluginDescription`, incl. `uniqueId`), not filename heuristics,
  and mapped to the existing role model (`instrument` / `audio-effect` /
  `unknown`).
- **Serial chains**: each VST node's internal ordered plugin chain is mirrored in
  the engine. Add / remove / reorder / bypass are synchronized between the
  persisted node content model and the native runtime chain, and the chain is
  replayed into the engine after any engine start (launch, crash + relaunch,
  renderer reload). The Patch Bay still sees the whole chain as ONE VST node.
- **MIDI panic**: losing a MIDI route while notes are held (controller
  unplugged, input changed, cable pulled, node deleted) emits All Notes Off +
  All Sound Off rather than leaving the instrument sounding.
- **Real-time audio callback** never blocks and never allocates. It reads an
  append-only chain array published with release/acquire ordering, takes each
  chain's SpinLock with `tryEnter` (skipping the block instead of spinning if
  the message thread is mid-edit) and holds it for the whole traversal, so a
  plugin cannot be destroyed while it is being processed. MIDI arrives through
  an `AbstractFifo` ring buffer and every `MidiBuffer` is preallocated.
- **Audio Output** is a native/system Patch Bay node (non-deletable,
  non-copyable) with a single `AUDIO IN`. Its editor exposes the real WASAPI
  device list, sample rate, buffer size and engine state. Audio only reaches the
  physical output for VST chains connected `VST AUDIO OUT -> Audio Output AUDIO
  IN`; MIDI only reaches a chain connected `MiniLab MIDI OUT -> VST MIDI IN`.
- **Native plugin editors** open in a separate native window owned by the engine
  (`Open Plugin`), sized to the plugin's own editor and raised above the Electron
  window. Closing the window does not unload the plugin; removing the plugin
  destroys its editor. `editorStatus` reports what is actually on screen
  (`open`, `width`, `height`, and a `message` when it could not be opened).

### Build the native engine

Requires Visual Studio (MSVC), Windows SDK, CMake, and JUCE 9 (extracted to
`native/third_party/JUCE`).

```bash
cmake -S native/audio-engine -B native/audio-engine/build -G "Visual Studio 18 2026" -A x64
cmake --build native/audio-engine/build --config Release --target mlh_audio_engine
```

The executable is `native/audio-engine/build/Release/mlh-audio-engine.exe`. The
Electron main process locates and launches it automatically.

### Node identity vs display numbering

A node has two numbers and they are deliberately unrelated:

| | example | reused? | used for |
|---|---|---|---|
| stable id | `vst-011` | never | routing, layout, module registry, engine chains, persistence |
| display ordinal | `2` -> "VST 2" | yes | the name shown in the sidebar and Patch Bay |

A new node takes the lowest positive ordinal free within its own type family,
so deleting VST 2..10 makes the next VST "VST 2" again while its id keeps
moving forward. Existing nodes are never renumbered. The name is derived from
type + ordinal and is not persisted separately.

### Engine IPC protocol (versioned, newline-delimited JSON over stdin/stdout)

Every message carries `"v": 1`. Commands (Electron -> engine): `hello`,
`listDevices`, `selectDevice`, `getDeviceState`, `scanVst3`, `listPlugins`,
`createInstance`, `removeInstance`, `reorderChain`, `setBypass`, `midi`,
`setChainMidiEnabled`, `setChainOutputEnabled`, `openEditor`, `closeEditor`,
`getState`, `setState`, `getVstParameters`, `setVstParameter`, `setTransport`,
`syncAudioGraph`, `syncMidiGraph`, `syncSequencer`, `sequencerMidiInput`,
`sequencerRecord`, `sequencerExport`, `sequencerCancelExport`, `sequencerPanic`, `setMetronome`, `shutdown`
(`shutdown` is issued by the Electron main
process only — the renderer IPC surface allowlists every other command and
rejects unknown ones). Events (engine -> Electron): `hello`,
`devices`, `deviceState`, `plugins`, `chainChanged`, `instanceStatus`,
`editorStatus`, `vstParameters`, `vstParameterTouched`, `transport`,
`sequencerMidiRecorded`, `sequencerAudioRecorded`, `sequencerAudioInfo`,
`sequencerExport`, `status`, `error`, `shutdownAck`. Only state, CONTROL and MIDI messages
cross this boundary.

The renderer's `EngineClient` owns the engine-derived state (devices, device
state, plugin registry) and warms it up once per engine run; modules read that
cache instead of issuing their own requests when they are opened. Chain
enable flags are published only on a real transition, and the cache is dropped
when the engine goes away so a restarted engine gets the full topology again.

### Manual acceptance test (first real sound)

1. Launch MiniLab Hub — the native engine starts and handshakes.
2. Connect the MiniLab 3; Hub detects it.
3. Create `VST 1`; connect `MiniLab MIDI OUT -> VST 1 MIDI IN`.
4. Open VST 1 → `Scan for VST3` (or wait for the auto-scan) → `+ Add VST` → pick a
   real installed VST3 instrument.
5. Connect `VST 1 AUDIO OUT -> Audio Output AUDIO IN`.
6. In Audio Output, select a real output device and Apply.
7. Play the MiniLab — you should hear the instrument.
8. Disconnect the MIDI cable → new notes stop; reconnect. Disconnect the audio
   cable → the instrument is no longer heard; reconnect.
9. `Open Plugin` on the plugin → the real native editor opens; change something
   and hear the result.

### MiniLab 3 hardware surface and expression strips

Patch Bay and VST CONTROL Learn render the same `MiniLabControlSurface` layout
from `src/renderer/js/ui/miniLabControlSurface.js`. Every CONTROL socket and
Learn target uses the same stable physical identity. CONTROL is additive: a
message is still sent through `MIDI OUT` when that cable is connected, whether
or not the corresponding CONTROL socket is also connected.

The CONTROL projection follows Arturia's documented factory messages:

- K1–K8 and F1–F4 are continuous CC sources. Their Arturia/User and DAW-mode
  factory CC assignments are recognized.
- The main encoder is a continuous CC source and its click is a
  momentary-or-toggle event, matching the MIDI Control Center mode choice.
- Pitch Bend remains standard 14-bit MIDI Pitch Bend and additionally provides
  a bipolar CONTROL source; Modulation remains MIDI CC 1 and additionally
  provides a continuous CONTROL source.
- Pads remain channel-10 note/velocity/poly-pressure sources and additionally
  provide velocity/momentary/pressure CONTROL events for factory Bank A/B notes.
  Documented pad control-mode CC 102–109 messages map to the same physical IDs.
- Shift is exposed as a momentary event for its documented factory CC. Hold,
  Octave-/Octave+, and locally selected pad functions are not exposed because
  MiniHub has no documented, unique incoming message for those physical actions.

Custom MIDI Control Center assignments always remain on the native MIDI path.
MiniHub only adds CONTROL for documented messages it can identify safely; it
does not guess that an arbitrary custom CC belongs to a particular control.
