/**
 * Two keyboards on one desk, in one session.
 *
 * `plans/active/two-controllers-at-once.md`. Everything else in the suite runs
 * with the single profile that ships, because that is what `preload.js` hands
 * over when nothing is chosen — so nothing else can prove the property this file
 * exists for: that a second controller is a second set of identities and not a
 * second interpretation of the first one's.
 *
 * HOW THE INJECTION WORKS, AND WHY IT HAS TO BE DYNAMIC IMPORTS
 * ------------------------------------------------------------
 * `LOADED_PROFILES` is frozen when the module graph evaluates — that is the
 * whole design of `midi/loadedProfile.js`, and the reason changing profile
 * reloads the window. A static `import` is hoisted above every statement in this
 * file, so it would evaluate that graph BEFORE `globalThis.hubProfiles` was set
 * and this file would silently test one keyboard. The imports below are
 * therefore dynamic, after the injection, and `node --test` gives each test file
 * its own process so the injection cannot leak into another one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));

const shipped = read('../src/renderer/js/midi/profiles/minilab-3.json');
const vega = read('./conformance/vega-49.json');

globalThis.hubProfiles = [
  { source: 'file', fileName: 'minilab-3.json', profile: shipped, error: null },
  { source: 'file', fileName: 'vega-49.json', profile: vega, error: null }
];

const {
  MINILAB_CONTROL_SOURCES, controlSourcesOfNode, surfaceControlsOfNode, surfaceBoxOfNode,
  profileOfNode, controllerNodeOfSource, getMiniLabControlSource, getMiniLabControlSourceByPort,
  getMiniLabControlLayout, decodeMiniLabControl
} = await import('../src/renderer/js/midi/minilabControls.js');
const { LOADED_PROFILES, PROFILE_ORIGINS } = await import('../src/renderer/js/midi/loadedProfile.js');
const { CONTROLLER_NODE_IDS, isControllerNodeId } = await import('../src/renderer/js/core/systemNodes.js');
const { surfaceOfNode, MINILAB_SURFACE } = await import('../src/renderer/js/ui/miniLabControlSurface.js');

test('both keyboards load, and both are controller nodes', () => {
  assert.deepEqual(LOADED_PROFILES.map((entry) => entry.profileId), ['minilab-3', 'vega-49']);
  assert.deepEqual(PROFILE_ORIGINS.map((entry) => entry.origin), ['file', 'file']);
  assert.deepEqual([...CONTROLLER_NODE_IDS], ['minilab-3', 'vega-49']);
  assert.equal(isControllerNodeId('minilab-3'), true);
  assert.equal(isControllerNodeId('vega-49'), true);
  assert.equal(isControllerNodeId('vst-001'), false);
});

/*
 * The property the whole workstream turns on. `minilab-3:k1` and `vega-49:k1`
 * cannot collide because a source id carries its profile; what CAN collide is
 * `control-k1`, which is only unique inside its own node.
 */
test('one CC decodes to a different control on each keyboard', () => {
  // CC 74 is K1 on the MiniLab 3 and Dial One on the Vega. Same controller
  // number, arriving on each keyboard's own performance port.
  const cc74 = { type: 'cc', channel: 1, controller: 74, value: 64 };

  const onMiniLab = decodeMiniLabControl({ ...cc74, sourceName: 'Minilab3 MIDI' }, profileOfNode('minilab-3'));
  const onVega = decodeMiniLabControl({ ...cc74, sourceName: 'Vega49 Keys' }, profileOfNode('vega-49'));

  assert.equal(onMiniLab.sourceNodeId, 'minilab-3');
  assert.equal(onVega.sourceNodeId, 'vega-49', 'the second keyboard emits on its own node, not on the first');
  assert.equal(onMiniLab.sourceControlId, 'minilab-3:k1');
  assert.equal(onVega.sourceControlId, 'vega-49:dial-one');
  assert.notEqual(onMiniLab.sourcePortId, onVega.sourcePortId,
    'and they are different sockets, so a cable from one cannot be read as a cable from the other');
});

test('a keyboard does not answer for a port it does not own', () => {
  // The port gate is per profile, so a message from the Vega's cable is not a
  // message the MiniLab's profile has anything to say about — which is what
  // stops one knob turning because the other keyboard was touched.
  const cc74 = { type: 'cc', channel: 1, controller: 74, value: 64 };

  assert.equal(decodeMiniLabControl({ ...cc74, sourceName: 'Vega49 Keys' }, profileOfNode('minilab-3')), null);
  assert.equal(decodeMiniLabControl({ ...cc74, sourceName: 'Minilab3 MIDI' }, profileOfNode('vega-49')), null);
  assert.equal(decodeMiniLabControl({ ...cc74, sourceName: 'Minilab3 MCU/HUI' }, profileOfNode('minilab-3')), null,
    'and a port its own profile marks as never carrying what is played stays silent too');
});

test('a port id is resolved inside its own keyboard, never across the desk', () => {
  const minilabPort = getMiniLabControlSourceByPort('minilab-3', 'control-k1');
  assert.equal(minilabPort.id, 'minilab-3:k1');

  // The Vega has no `k1`: asking its node for that socket is a miss, not the
  // MiniLab's knob. This is the assertion that would have failed while the
  // lookup was a single flat map keyed on `control-<controlId>`.
  assert.equal(getMiniLabControlSourceByPort('vega-49', 'control-k1'), null);
  assert.equal(getMiniLabControlSourceByPort('vega-49', 'control-dial-one').id, 'vega-49:dial-one');
  assert.equal(getMiniLabControlSourceByPort('minilab-3', 'control-dial-one'), null);
  assert.equal(getMiniLabControlSourceByPort('vst-001', 'control-k1'), null,
    'a node that is not a keyboard has no controls to offer');
});

test('every source on the desk is listed once, under its own keyboard', () => {
  const minilab = controlSourcesOfNode('minilab-3');
  const vegaSources = controlSourcesOfNode('vega-49');

  assert.ok(minilab.length > 0 && vegaSources.length > 0);
  assert.equal(MINILAB_CONTROL_SOURCES.length, minilab.length + vegaSources.length,
    'the desk is the sum of its keyboards, in load order');
  assert.deepEqual(MINILAB_CONTROL_SOURCES.slice(0, minilab.length), [...minilab]);

  const ids = MINILAB_CONTROL_SOURCES.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is shared between two keyboards');
  assert.ok(minilab.every((source) => source.id.startsWith('minilab-3:')));
  assert.ok(vegaSources.every((source) => source.id.startsWith('vega-49:')));

  // And the same object, whichever way it is reached: `find` and `===` have to
  // agree three files away in `core/controlBindings.js`.
  assert.equal(getMiniLabControlSource('vega-49:dial-one'), vegaSources[0]);
  assert.equal(controllerNodeOfSource('vega-49:dial-one'), 'vega-49');
  assert.equal(controllerNodeOfSource('minilab-3:k1'), 'minilab-3');
  assert.equal(controllerNodeOfSource('nothing:at-all'), null);
});

test('each keyboard is drawn from its own box, at its own coordinates', () => {
  assert.deepEqual(surfaceBoxOfNode('minilab-3'), { width: 480, height: 180 });
  assert.deepEqual(surfaceBoxOfNode('vega-49'), { width: 620, height: 240 });
  assert.equal(surfaceBoxOfNode('vst-001'), null);

  const minilabSurface = surfaceOfNode('minilab-3');
  const vegaSurface = surfaceOfNode('vega-49');
  assert.equal(minilabSurface.width, 480);
  assert.equal(vegaSurface.width, 620);
  assert.deepEqual(MINILAB_SURFACE, minilabSurface,
    'the one-device export is the first keyboard, not a mixture of both');

  // A node's ports are its own: the Vega's surface holds no socket the MiniLab
  // owns, which is what stops a cable being drawn onto the wrong panel.
  assert.ok(vegaSurface.ports['control-dial-one']);
  assert.equal(vegaSurface.ports['control-k1'], undefined);
  assert.ok(minilabSurface.ports['control-k1']);
  assert.equal(minilabSurface.ports['control-dial-one'], undefined);

  assert.deepEqual(getMiniLabControlLayout('vega-49:dial-one'), { x: 60, y: 40 });
  assert.notDeepEqual(getMiniLabControlLayout('minilab-3:k1'), getMiniLabControlLayout('vega-49:dial-one'),
    'two knobs at two places; a layout table keyed on a bare control key could not tell them apart');
});

test('a keyboard draws what it has, and nothing the other one has', () => {
  const minilab = surfaceControlsOfNode('minilab-3');
  const vegaControls = surfaceControlsOfNode('vega-49');

  assert.equal(vegaControls.length, vega.controls.length, 'silent elements included: a panel draws them');
  assert.ok(minilab.some((control) => control.key === 'k1'));
  assert.ok(!vegaControls.some((control) => control.key === 'k1'));
  assert.ok(vegaControls.some((control) => control.key === 'dial-one'));
  assert.deepEqual(surfaceControlsOfNode('vst-001'), []);
});

// ---------------------------------------------------------------------------
// Steps 5, 6 and 3b: two nodes, two armed cables, and no message leaving by the
// wrong node. Everything above proves identities; this proves the wiring.
// ---------------------------------------------------------------------------

const { createMiniLabModule } = await import('../src/renderer/js/modules/minilab/minilabModule.js');
const { setupControlRouting } = await import('../src/renderer/js/core/controlRouting.js');
const { setupMidiRouting } = await import('../src/renderer/js/core/midiRouting.js');
const { MidiManager } = await import('../src/renderer/js/midi/midiManager.js');

function fakeHub() {
  const handlers = new Map();
  const emitted = [];
  const hub = {
    events: {
      on(name, fn) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
        return () => {};
      },
      emit(name, payload) {
        for (const fn of handlers.get(name) ?? []) fn(payload);
      }
    },
    network: { emitData: (nodeId, portId, data) => emitted.push({ nodeId, portId, data }) },
    midi: {},
    settings: { get: () => null },
    api: {}
  };
  return { hub, emitted };
}

test('two keyboards are two pages and two routing nodes', () => {
  const { hub } = fakeHub();
  const [minilab, vegaModule] = LOADED_PROFILES.map((profile) => createMiniLabModule(hub, profile));

  assert.equal(minilab.routingNode.id, 'minilab-3');
  assert.equal(vegaModule.routingNode.id, 'vega-49');
  assert.notEqual(minilab.id, vegaModule.id, 'two pages, or the second one silently replaces the first');
  assert.notEqual(minilab.id, minilab.routingNode.id,
    'and the page id is still not the node id — that is what made the Open button dead');

  const controlPorts = (module) => module.routingNode.outputs
    .filter((port) => port.type === 'control').map((port) => port.id);
  assert.ok(controlPorts(minilab).includes('control-k1'));
  assert.ok(!controlPorts(vegaModule).includes('control-k1'), 'a node offers its own sockets only');
  assert.ok(controlPorts(vegaModule).includes('control-dial-one'));
  assert.notEqual(minilab.routingNode.surface.width, vegaModule.routingNode.surface.width,
    'each card is drawn from its own box');
});

test('a control leaves by the node of the keyboard that sent it', () => {
  const { hub, emitted } = fakeHub();
  setupControlRouting(hub);

  hub.events.emit('midi:message', {
    type: 'cc', channel: 1, controller: 74, value: 64, sourceName: 'Vega49 Keys', profileId: 'vega-49'
  });
  hub.events.emit('midi:message', {
    type: 'cc', channel: 1, controller: 74, value: 64, sourceName: 'Minilab3 MIDI', profileId: 'minilab-3'
  });

  assert.deepEqual(emitted.map((entry) => [entry.nodeId, entry.portId]), [
    ['vega-49', 'control-dial-one'],
    ['minilab-3', 'control-k1']
  ], 'one CC number, two keyboards, two nodes — this is what emitData(MINILAB_NODE_ID, ...) could not do');
});

test('raw MIDI leaves by its own node, and a panic silences every keyboard', () => {
  const { hub, emitted } = fakeHub();
  setupMidiRouting(hub);

  hub.events.emit('midi:message', { type: 'noteon', profileId: 'vega-49', raw: [0x90, 60, 100] });
  assert.equal(emitted[0].nodeId, 'vega-49');

  // No profile claimed the selected port: the user picked a keyboard MiniHub has
  // no profile for, and this is what the single-controller version did with it.
  hub.events.emit('midi:message', { type: 'noteon', raw: [0x90, 60, 100] });
  assert.equal(emitted[1].nodeId, 'minilab-3');

  emitted.length = 0;
  hub.events.emit('midi:panic', { reason: 'input-disconnected' });
  const silenced = new Set(emitted.map((entry) => entry.nodeId));
  assert.deepEqual([...silenced].sort(), ['minilab-3', 'vega-49'],
    'a note held on the other keyboard is just as stuck; silencing one and leaving the other droning is half a fix');
});

test('each keyboard is armed on its own cable, and an unclaimed choice arms nothing', () => {
  const manager = new MidiManager({ emit() {}, on() { return () => {}; } }, { get: () => null, set() {} });
  manager.inputs = new Map([
    ['in-1', { id: 'in-1', name: 'Minilab3 MIDI' }],
    ['in-2', { id: 'in-2', name: 'Vega49 Keys' }],
    ['in-3', { id: 'in-3', name: 'Some Other Keyboard' }]
  ]);

  manager.selectedInputId = 'in-1';
  manager._rearmProfilePorts();
  assert.equal(manager.armedInputFor('minilab-3'), 'in-1', 'the selection belongs to the profile that claims it');
  assert.equal(manager.armedInputFor('vega-49'), 'in-2', 'and the other keyboard arms its own performance port');
  assert.equal(manager.profileIdForInput('in-2'), 'vega-49');
  assert.equal(manager.profileIdForInput('in-3'), null, 'a cable no profile claims stays unarmed');

  // The user selected a keyboard no loaded profile describes. Nothing else is
  // armed: "only the explicitly selected port may enter live routing" holds.
  manager.selectedInputId = 'in-3';
  manager._rearmProfilePorts();
  assert.equal(manager.armedByProfile.size, 0);

  manager.selectedInputId = null;
  manager._rearmProfilePorts();
  assert.equal(manager.armedByProfile.size, 0, 'with nothing selected, every physical port stays isolated');
});

// ---------------------------------------------------------------------------
// ONE VST, ONE CONTROLLER
//
// Reported by the author from the running application, 2026-09-05, with a
// screenshot: the MiniLab was cabled to VST 1 and the Learn panel was drawing
// the BeatStep's faceplate. Two keyboards on the desk is the point; two
// keyboards into one node is not, and he settled it — "est-ce qu'on peut
// brancher 2 midi controllers sur le meme VST : non."
//
// So there are two separate defects here, and they need two separate fixes: the
// network must refuse the second cable, and the panel must follow the first one
// instead of drawing whichever profile happened to load first.
// ---------------------------------------------------------------------------

const { Network } = await import('../src/renderer/js/core/network.js');
const { renderControlBindings } = await import('../src/renderer/js/core/nodeInstances.js');

function makeNetwork() {
  const network = new Network({ emit() {}, on() { return () => {}; } }, { get: () => null, set() {} });
  for (const nodeId of ['minilab-3', 'vega-49']) {
    network.addNode({
      id: nodeId,
      name: nodeId === 'minilab-3' ? 'MiniLab 3' : 'Vega 49',
      type: 'midi-output',
      outputs: [
        { id: 'midi-out', type: 'midi', label: 'MIDI Out' },
        ...controlSourcesOfNode(nodeId).map((source) => ({
          id: source.portId, type: 'control', label: source.label
        }))
      ],
      inputs: [{ id: 'midi-in', type: 'midi', label: 'Hardware MIDI In' }]
    });
  }
  network.addNode({
    id: 'vst-001', name: 'VST 1', type: 'vst',
    inputs: [{ id: 'ctrl-in', type: 'control', label: 'CTRL IN' }],
    outputs: []
  });
  return network;
}

test('a CONTROL input takes cables from as many keyboards as the user wants', () => {
  // One keyboard for the notes, another for the parameters, both into the same
  // plugin: a real desk, and the reason the guard that briefly lived in
  // `connect()` was wrong. What could only handle one was the PANEL.
  const network = makeNetwork();
  assert.equal(network.connect('minilab-3', 'control-k1', 'vst-001', 'ctrl-in'), true);
  assert.equal(network.connect('minilab-3', 'control-k2', 'vst-001', 'ctrl-in'), true);
  assert.equal(network.connect('vega-49', 'control-dial-one', 'vst-001', 'ctrl-in'), true);

  assert.equal(network.connectionsTo('vst-001', 'ctrl-in').length, 3);
});

test('the Learn panel draws one faceplate per cabled keyboard, each named', () => {
  const network = makeNetwork();
  const hub = { network, control: null, modules: { get: () => null } };
  const instance = { id: 'vst-001', type: 'vst', content: { plugins: [] } };

  network.connect('minilab-3', 'control-k1', 'vst-001', 'ctrl-in');
  network.connect('vega-49', 'control-dial-one', 'vst-001', 'ctrl-in');
  const html = renderControlBindings(instance, hub);

  assert.match(html, /minilab-3:k1/);
  assert.match(html, /vega-49:dial-one/, 'both keyboards are cabled, so both are on the panel');
  assert.equal(html.match(/data-minilab-surface="learn"/g)?.length, 2, 'one faceplate each');
  assert.match(html, /MiniLab 3/);
  assert.match(html, /Vega 49/, 'named, or the second drawing has to be identified by counting knobs');

  // One keyboard usually arrives on several cables, one per mapped knob. That
  // is one faceplate, not four.
  network.connect('minilab-3', 'control-k2', 'vst-001', 'ctrl-in');
  network.connect('minilab-3', 'control-k3', 'vst-001', 'ctrl-in');
  assert.equal(renderControlBindings(instance, hub).match(/data-minilab-surface="learn"/g)?.length, 2);
});

test('the Learn panel draws the keyboard that is cabled, not the one that loaded first', () => {
  const network = makeNetwork();
  const hub = { network, control: null, modules: { get: () => null } };
  const instance = { id: 'vst-001', type: 'vst', content: { plugins: [] } };

  // The exact screenshot: the second-loaded keyboard is cabled, and the panel
  // used to draw the first-loaded one.
  network.connect('vega-49', 'control-dial-one', 'vst-001', 'ctrl-in');
  const drawn = renderControlBindings(instance, hub);
  assert.match(drawn, /vega-49:dial-one/, 'the cabled keyboard is the one on screen');
  assert.doesNotMatch(drawn, /minilab-3:k1/, 'and a keyboard nothing cables to this node is not');
  assert.match(drawn, /Vega 49/, 'named after the node the cable comes from');

  network.disconnect('vega-49', 'control-dial-one', 'vst-001', 'ctrl-in');
  network.connect('minilab-3', 'control-k1', 'vst-001', 'ctrl-in');
  const swapped = renderControlBindings(instance, hub);
  assert.match(swapped, /minilab-3:k1/);
  assert.doesNotMatch(swapped, /vega-49:dial-one/, 'recabling swaps the faceplate, it does not add to it');
});

test('with two keyboards and no cable, the panel draws neither and says why', () => {
  const network = makeNetwork();
  const hub = { network, control: null, modules: { get: () => null } };
  const html = renderControlBindings({ id: 'vst-001', type: 'vst', content: { plugins: [] } }, hub);

  assert.doesNotMatch(html, /minilab-3:k1/);
  assert.doesNotMatch(html, /vega-49:dial-one/);
  assert.match(html, /No controller is cabled to this node/,
    'drawing either one is a guess, and a guess is what put the wrong faceplate here');
  assert.match(html, /CTRL IN/, 'and it says what to do about it');
});

/*
 * A page reports its own keyboard, and lights its own lamp.
 *
 * `midi:message` carries every armed cable and `midiManager` stamps the profile
 * it came from. Without the filter the MiniLab's page counted the BeatStep's
 * notes, printed its CCs in the monitor and lit for them — one page reporting
 * two instruments, with nothing on screen saying so.
 *
 * The lamp itself is not asserted here: the DOM shim does not parse innerHTML,
 * so a mounted page cannot be inspected. What IS asserted is the gate the lamp
 * and every counter sit behind.
 */
test('each controller page answers only for its own keyboard', () => {
  const { hub } = fakeHub();
  const [minilab, vegaPage] = LOADED_PROFILES.map((profile) => createMiniLabModule(hub, profile));

  const fromMiniLab = { type: 'cc', controller: 74, value: 64, profileId: 'minilab-3' };
  const fromVega = { type: 'cc', controller: 74, value: 64, profileId: 'vega-49' };

  assert.equal(minilab.handlesMessage(fromMiniLab), true);
  assert.equal(minilab.handlesMessage(fromVega), false, 'one page, one instrument');
  assert.equal(vegaPage.handlesMessage(fromVega), true);
  assert.equal(vegaPage.handlesMessage(fromMiniLab), false);

  // No stamp: the port belongs to no loaded profile, so the user selected a
  // keyboard MiniHub has no profile for. It goes to the first controller's
  // page, which is where `core/midiRouting.js` sends it too — one rule, not two.
  const unstamped = { type: 'cc', controller: 74, value: 64 };
  assert.equal(minilab.handlesMessage(unstamped), true);
  assert.equal(vegaPage.handlesMessage(unstamped), false);
});
