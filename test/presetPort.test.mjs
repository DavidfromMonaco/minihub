/**
 * The `preset` port type.
 *
 * A preset cable states "this Preset node targets that VST node". It carries no
 * signal, so what these tests lock is mostly a NEGATIVE: the edge must stay
 * invisible to the native engine.
 *
 * The failure mode is expensive and silent. Let a preset edge into
 * describeAudioGraph() and it joins audioTopologyKey(); from then on, merely
 * plugging or unplugging one recompiles the native audio plan and resets every
 * PDC delay line mid-stream — the defect DECISIONS.md D-004 exists to remove,
 * audible before it is ever visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import {
  audioTopologyKey,
  describeAudioGraph,
  describeMidiGraph
} from '../src/renderer/js/core/engineSync.js';
import { PORT_TYPES, canConnect, portTypeInfo } from '../src/renderer/js/modules/routing/routingCore.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';

/** A stand-in for the Preset node, which arrives with step 7 of the plan. */
function addPresetSource(hub, id = 'preset-probe') {
  hub.graph.addNode({
    id,
    name: 'Preset',
    type: 'preset',
    inputs: [],
    outputs: [{ id: 'preset-out', type: 'preset', label: 'PRESET' }]
  });
  return id;
}

function rig() {
  const hub = makeFullHub();
  hub.graph.addNode({
    id: 'audio-output', name: 'Audio Output', type: 'audio-output',
    inputs: [{ id: 'audio-in', type: 'audio' }], outputs: []
  });
  return hub;
}

// ---- The type is declared, and distinguishable without colour ---------------

test('preset is a first-class port type with its own glyph and label', () => {
  assert.ok(PORT_TYPES.includes('preset'));
  const info = portTypeInfo('preset');
  assert.equal(info.label, 'PRESET');
  assert.equal(info.className, 'preset');
  // Ports must not be told apart by colour alone, so the shape is distinct from
  // square (MIDI), circle (AUDIO) and triangle (CTRL).
  assert.equal(info.shape, 'diamond');
  for (const other of ['midi', 'audio', 'control']) {
    assert.notEqual(portTypeInfo(other).shape, info.shape);
  }
});

test('a VST node exposes PRESET as an input typed preset, not control', () => {
  const preset = getNodeType('vst').ports.inputs.find((p) => p.id === 'preset-in');
  assert.ok(preset, 'the VST node must offer a preset socket');
  assert.equal(preset.type, 'preset');
});

// ---- Typing is enforced -----------------------------------------------------

test('preset connects only to preset', () => {
  assert.equal(canConnect({ type: 'preset' }, { type: 'preset' }), true);
  for (const other of ['midi', 'audio', 'control']) {
    assert.equal(canConnect({ type: 'preset' }, { type: other }), false);
    assert.equal(canConnect({ type: other }, { type: 'preset' }), false);
  }
});

test('the graph refuses a preset cable into a signal socket', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  const source = addPresetSource(hub);
  assert.throws(() => hub.graph.connect(source, 'preset-out', vst.id, 'ctrl-in'), /Incompatible port types/);
  assert.throws(() => hub.graph.connect(source, 'preset-out', vst.id, 'midi-in'), /Incompatible port types/);
  hub.graph.connect(source, 'preset-out', vst.id, 'preset-in');
  assert.equal(hub.graph.connections().length, 1);
});

// ---- The point of the whole type: the engine never sees it ------------------

test('a preset cable changes neither native plan nor audio topology (D-004)', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  hub.graph.connect(vst.id, 'audio-out', 'audio-output', 'audio-in');

  const audioBefore = describeAudioGraph(hub);
  const midiBefore = describeMidiGraph(hub);
  const topologyBefore = audioTopologyKey(audioBefore);

  const source = addPresetSource(hub);
  hub.graph.connect(source, 'preset-out', vst.id, 'preset-in');

  const audioAfter = describeAudioGraph(hub);
  assert.deepEqual(audioAfter, audioBefore, 'the audio plan must be byte-identical');
  assert.deepEqual(describeMidiGraph(hub), midiBefore, 'the MIDI plan must be byte-identical');
  assert.equal(audioTopologyKey(audioAfter), topologyBefore, 'no recompile may be triggered');

  // And unplugging it is just as inert.
  hub.graph.disconnect(source, 'preset-out', vst.id, 'preset-in');
  assert.equal(audioTopologyKey(describeAudioGraph(hub)), topologyBefore);
});

test('a preset node is not a member of either native plan', () => {
  const hub = rig();
  const source = addPresetSource(hub);
  assert.equal(describeAudioGraph(hub).some((n) => n.id === source), false);
  assert.equal(describeMidiGraph(hub).some((n) => n.id === source), false);
});

test('the PRESET socket never appears among a VST node native inputs', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  hub.graph.connect(vst.id, 'audio-out', 'audio-output', 'audio-in');
  const source = addPresetSource(hub);
  hub.graph.connect(source, 'preset-out', vst.id, 'preset-in');

  const native = describeAudioGraph(hub).find((n) => n.id === vst.id);
  assert.equal(native.inputs.some((input) => input.portId === 'preset-in'), false);
});
