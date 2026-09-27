import './installNodeEditors.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { MINILAB_CONTROL_SOURCES } from '../src/renderer/js/midi/minilabControls.js';
import { handleAgentRequest } from '../src/renderer/js/core/agentRequests.js';

/*
 * The gaps an agent reported, closed on 2026-09-25: what the interface could do
 * and the channel could not. A binding set by request plugs its cable as Learn
 * does and takes a range as the bar's Low and High do; What Play plays and the
 * Sequencer's loop are set and read. INTENT 8 sexies: nothing here is an
 * operation the interface does not already perform.
 */

const source = (key) => MINILAB_CONTROL_SOURCES.find((item) => item.key === key);

function mockApi() {
  const listeners = { event: [], state: [] };
  return {
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async () => ({ ok: true }),
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

async function rig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.settings.load();
  hub.network.addNode({
    id: 'minilab-3', name: 'MiniLab 3', inputs: [],
    outputs: [{ id: 'midi-out', type: 'midi', label: 'MIDI Out' },
      ...MINILAB_CONTROL_SOURCES.map((item) => ({ id: item.portId, type: 'control', label: item.label }))]
  });
  await hub.engine.init();
  hub.project._loading = false;
  const node = hub.nodes.create('vst');
  const plugin = hub.nodes.getChain(node.id).append({ pluginId: 'C:/VST3/Vital.vst3', name: 'Vital', role: 'instrument' });
  const ask = (request) => handleAgentRequest(hub, { expectedProjectId: hub.project.projectId, ...request });
  const bindRequest = (extra = {}) => ({
    kind: 'set-binding', nodeId: node.id, sourceControlId: source('k2').id,
    pluginInstanceId: plugin.id, pluginId: plugin.pluginId, parameterId: '4242', parameterName: 'Cutoff', ...extra
  });
  return { api, hub, node, plugin, ask, bindRequest };
}

const cablesInto = (hub, nodeId) => hub.network.connectionsTo(nodeId, 'ctrl-in').map((cable) => cable.from.portId);

test('a binding set by request plugs its cable and redraws the bar, as a Learn capture does', async () => {
  const { hub, node, ask, bindRequest } = await rig();
  const redrawn = [];
  hub.events.on('control:bindingsChanged', (change) => redrawn.push(change.nodeId));
  assert.deepEqual(cablesInto(hub, node.id), []);

  const answer = await ask(bindRequest());
  assert.equal(answer.ok, true);
  assert.equal(answer.plugged, true, 'the cable was not there, so it was plugged');
  assert.deepEqual(cablesInto(hub, node.id), [source('k2').portId]);
  assert.equal(hub.control.bindingStatus(node.id, source('k2').id).state === 'disconnected', false,
    'a binding that does something, not one drawn dashed');
  assert.ok(redrawn.length > 0 && redrawn.every((id) => id === node.id), 'an open bindings bar hears of it');
  assert.equal(answer.binding.pluginName, 'Vital', 'named after the plugin when the request did not');

  // Set again: the cable is there already and is not plugged twice.
  assert.equal((await ask(bindRequest({ parameterId: '77' }))).plugged, false);
  assert.deepEqual(cablesInto(hub, node.id), [source('k2').portId]);

  // Clear takes both back, as the bar's Clear does.
  assert.deepEqual(await ask({ kind: 'clear-binding', nodeId: node.id, sourceControlId: source('k2').id }), { ok: true });
  assert.deepEqual(cablesInto(hub, node.id), []);
  assert.equal((await ask({ kind: 'clear-binding', nodeId: node.id, sourceControlId: source('k2').id })).reason, 'binding-not-found');
});

test('a binding takes the range its control sweeps, and refuses one that sweeps nothing', async () => {
  const { hub, node, ask, bindRequest } = await rig();
  const answer = await ask(bindRequest({ range: { min: 0.45, max: 0.55, minText: '-2.00', maxText: '+2.00' } }));
  assert.equal(answer.ok, true);
  assert.deepEqual(hub.control.bindingFor(node.id, source('k2').id).range,
    { min: 0.45, max: 0.55, minText: '-2.00', maxText: '+2.00' });

  const empty = await ask(bindRequest({ range: { min: 0.5, max: 0.5 } }));
  assert.equal(empty.reason, 'range-refused');
  assert.equal(empty.binding.range, undefined, 'what was bound instead is said: the whole parameter');

  assert.equal((await ask(bindRequest())).binding.range, undefined, 'no range is the whole parameter');
});

test('a binding to a plugin the node does not hold is refused and leaves no cable behind', async () => {
  const { hub, node, ask, bindRequest } = await rig();
  assert.equal((await ask(bindRequest({ pluginInstanceId: 'plugin-9' }))).reason, 'plugin-not-found');
  assert.equal((await ask(bindRequest({ pluginId: 'C:/VST3/Other.vst3' }))).reason, 'plugin-not-found');
  assert.equal((await ask(bindRequest({ nodeId: 'mixer-001' }))).reason, 'node-not-found');
  assert.deepEqual(cablesInto(hub, node.id), []);
});

test('what Play plays is set and read, and needs no project id', async () => {
  const { hub } = await rig();
  const stale = (request) => handleAgentRequest(hub, { expectedProjectId: 'another-project', ...request });
  assert.deepEqual(await stale({ kind: 'play-scope', scope: 'players' }), { ok: true, scope: 'players' });
  assert.equal(hub.sequencer.playScope, 'players');
  const described = await stale({ kind: 'describe' });
  assert.equal(described.setup.sequencer.playScope, 'players');
  const refused = await stale({ kind: 'play-scope', scope: 'nodes' });
  assert.equal(refused.reason, 'unknown-scope');
  assert.match(refused.message, /all, sequencer, players/);
  assert.equal(hub.sequencer.playScope, 'players', 'a refused scope changes nothing');
});

test("the Sequencer's loop is set as its fields set it, and read back", async () => {
  const { hub, ask } = await rig();
  const answer = await ask({ kind: 'loop', enabled: true, startPpq: 8, endPpq: 24 });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.loop, { enabled: true, startPpq: 8, endPpq: 24 });
  assert.deepEqual((await ask({ kind: 'describe' })).setup.sequencer.loop, { enabled: true, startPpq: 8, endPpq: 24 });

  // Only what is named changes.
  assert.deepEqual((await ask({ kind: 'loop', enabled: false })).loop, { enabled: false, startPpq: 8, endPpq: 24 });
  assert.equal((await ask({ kind: 'loop', startPpq: -1 })).reason, 'invalid-position');
  assert.equal((await ask({ kind: 'loop' })).reason, 'nothing-to-change');
  // An edit of the project, so a stale id is refused like any other.
  const stale = await handleAgentRequest(hub, { expectedProjectId: 'another-project', kind: 'loop', enabled: true });
  assert.equal(stale.ok, false);
});

test('a track is described and answered with its input, arming and monitoring', async () => {
  const { hub, ask } = await rig();
  hub.nodes.create('sequencer');
  const { track } = await ask({ kind: 'add-track', type: 'audio' });
  const answer = await ask({ kind: 'set-track', trackId: track.id, changes: { armed: true, monitored: true } });
  assert.equal(answer.track.armed, true);
  assert.equal(answer.track.monitored, true);
  assert.equal('inputId' in answer.track, true);
  const described = (await ask({ kind: 'describe' })).setup.sequencer.tracks.find((item) => item.id === track.id);
  assert.equal(described.monitored, true);
  assert.equal('inputId' in described, true);
});
