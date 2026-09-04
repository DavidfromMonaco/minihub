import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePortRole, isPerformancePort, bestPerformancePort
} from '../src/renderer/js/midi/portRoles.js';
import { validateControllerProfile } from '../src/renderer/js/midi/controllerProfile.js';
import { MidiManager } from '../src/renderer/js/midi/midiManager.js';
import miniLab from '../src/renderer/js/midi/profiles/minilab-3.json' with { type: 'json' };

/**
 * Contract: which port gets armed is decided by the profile that is loaded, not
 * by a device name compiled into the application.
 *
 * The regression this guards is one step removed from the one that
 * midiInputSelection.test.mjs guards. That test says the MiniLab's musical port
 * wins over its control surface; this one says the same machinery works for a
 * controller nobody here owns -- different port names, different priorities, and
 * not one token in common with "minilab". If a device name creeps back into the
 * ranking, the MiniLab tests keep passing and these stop.
 */

/**
 * A complete, legal profile for hardware that does not exist. Its ports are
 * named to share nothing with the MiniLab 3, and it declares a catch-all
 * alongside the specific ports, which is what a real author writes when a
 * driver's naming varies between machines.
 */
const OTHER_CONTROLLER = {
  formatVersion: 1,
  profileId: 'vega-49',
  revision: 1,
  name: 'Vega 49',
  author: '',
  createdAt: '2026-09-04',
  completeness: { declared: 1, observed: 1, inferred: 0, untested: 0 },
  device: {
    vendor: 'Nobody',
    model: 'Vega 49',
    layout: { width: 300, height: 100 },
    ports: [
      { role: 'ignore', priority: 0, match: { name: 'Vega 49' },
        note: 'anything not named below is not a port we know' },
      { role: 'performance', priority: 9, match: { name: 'Vega 49 Keys' } },
      { role: 'performance', priority: 4, match: { name: 'Vega 49 Aux' } },
      { role: 'control-surface', priority: 2, match: { name: 'Vega 49 Mackie' } }
    ]
  },
  layers: [{ id: 'default', label: 'Any mode' }],
  controls: [{
    id: 'wheel', label: 'Wheel', family: 'knob', layout: { x: 10, y: 10 },
    bindings: [{
      layer: 'default', when: { kind: 'cc', number: 1 },
      mode: 'absolute', range: [0, 127], confidence: 'observed'
    }]
  }]
};

const named = (...names) => names.map((name, index) => ({ id: `input-${index}`, name }));

test('the fixture controller is a legal profile, not a shape invented for the test', () => {
  const { ok, errors } = validateControllerProfile(OTHER_CONTROLLER);
  assert.equal(ok, true, JSON.stringify(errors));
});

// ---- resolution ---------------------------------------------------------------

test('each declared port resolves to the role and priority the profile gives it', () => {
  assert.deepEqual(
    ['Vega 49 Keys', 'Vega 49 Aux', 'Vega 49 Mackie']
      .map((name) => resolvePortRole(OTHER_CONTROLLER, name).role),
    ['performance', 'performance', 'control-surface']
  );
  assert.equal(resolvePortRole(OTHER_CONTROLLER, 'Vega 49 Keys').priority, 9);
});

test('a port no declaration matches belongs to no profile', () => {
  assert.equal(resolvePortRole(OTHER_CONTROLLER, 'Minilab3 MIDI'), null);
  assert.equal(resolvePortRole(miniLab, 'Vega 49 Keys'), null);
  assert.equal(resolvePortRole(miniLab, ''), null);
  assert.equal(resolvePortRole(undefined, 'Minilab3 MIDI'), null);
});

test('the specific declaration wins over the catch-all that also matches', () => {
  assert.equal(resolvePortRole(OTHER_CONTROLLER, 'Vega 49 Keys').role, 'performance');
  assert.equal(resolvePortRole(OTHER_CONTROLLER, 'Vega 49 Pedal').role, 'ignore',
    'a port the profile did not foresee falls to the catch-all, never to a guess');
});

test('the operating system may decorate a port name and it is still that port', () => {
  // Windows hands the same physical port back under both spellings.
  assert.equal(resolvePortRole(miniLab, 'MIDIIN2 (Minilab3 MIDI)').priority, 5);
  assert.equal(resolvePortRole(miniLab, 'MiniLab 3 MIDI').priority, 5,
    'the driver writes Minilab3, the manual writes MiniLab 3');
});

// ---- selection ----------------------------------------------------------------

test('another controller selects its own musical port, by profile alone', () => {
  const chosen = bestPerformancePort(
    OTHER_CONTROLLER, named('Vega 49 Mackie', 'Vega 49 Aux', 'Vega 49 Keys')
  );
  assert.equal(chosen.name, 'Vega 49 Keys');
});

test('the second performance port is used when the first is absent', () => {
  const chosen = bestPerformancePort(OTHER_CONTROLLER, named('Vega 49 Mackie', 'Vega 49 Aux'));
  assert.equal(chosen.name, 'Vega 49 Aux');
});

test('no port is armed when none of them can carry a note', () => {
  assert.equal(bestPerformancePort(OTHER_CONTROLLER, named('Vega 49 Mackie', 'Vega 49 Pedal')), null,
    'the highest-ranked port present is still one that delivers nothing');
  assert.equal(bestPerformancePort(miniLab, named('Minilab3 DIN THRU')), null);
  assert.equal(bestPerformancePort(miniLab, []), null);
  assert.equal(bestPerformancePort(miniLab, undefined), null);
});

test('ports of a controller that is not the loaded one are never armed', () => {
  assert.equal(bestPerformancePort(miniLab, named('Vega 49 Keys')), null);
  assert.equal(bestPerformancePort(OTHER_CONTROLLER, named('Minilab3 MIDI')), null);
});

test('equal priorities keep enumeration order rather than inventing a preference', () => {
  const tied = {
    device: { ports: [
      { role: 'performance', priority: 5, match: { name: 'Twin A' } },
      { role: 'performance', priority: 5, match: { name: 'Twin B' } }
    ] }
  };
  assert.equal(bestPerformancePort(tied, named('Twin B', 'Twin A')).name, 'Twin B');
  assert.equal(bestPerformancePort(tied, named('Twin A', 'Twin B')).name, 'Twin A');
});

test('the caller keeps its own port object, id and all', () => {
  const ports = named('Vega 49 Keys');
  assert.equal(bestPerformancePort(OTHER_CONTROLLER, ports), ports[0]);
  assert.equal(bestPerformancePort(OTHER_CONTROLLER, ports).id, 'input-0');
});

test('isPerformancePort answers for the profile it is given, not for a device', () => {
  assert.equal(isPerformancePort(OTHER_CONTROLLER, 'Vega 49 Keys'), true);
  assert.equal(isPerformancePort(OTHER_CONTROLLER, 'Vega 49 Mackie'), false);
  assert.equal(isPerformancePort(miniLab, 'Vega 49 Keys'), false);
});

// ---- the manager asks, and does not rank on its own ---------------------------

/**
 * MidiManager used to filter and sort port names itself. It now delegates, and
 * these two cases are the ones that delegation buys: a controller whose only
 * visible port cannot carry a note leaves nothing armed. Ranking alone would arm
 * it -- it is, after all, the best port present.
 */
function managerWith(...names) {
  const manager = new MidiManager({ emit() {} }, { get: () => null, set: async () => true });
  for (const port of named(...names)) manager.inputs.set(port.id, { ...port, manufacturer: 'Arturia' });
  return manager;
}

test('a lone control-surface port leaves nothing armed', () => {
  assert.equal(managerWith('Minilab3 MCU/HUI').findMiniLabInputId(), null);
  assert.equal(managerWith('Minilab3 DIN THRU').findMiniLabInputId(), null);
});

test('the musical port is still found when it is there', () => {
  const manager = managerWith('Minilab3 MCU/HUI', 'Minilab3 DIN THRU', 'Minilab3 MIDI');
  assert.equal(manager.getInput(manager.findMiniLabInputId()).name, 'Minilab3 MIDI');
});

// ---- the shipped profile still says what the hardware does --------------------

test('the MiniLab 3 profile declares the four ports the hardware exposes', () => {
  assert.deepEqual(
    miniLab.device.ports.map((port) => [port.match.name, port.role]),
    [
      ['Minilab3 MIDI', 'performance'],
      ['Minilab3 ALV', 'performance'],
      ['Minilab3 MCU/HUI', 'control-surface'],
      ['Minilab3 DIN THRU', 'ignore']
    ],
    'the ranking that used to be regular expressions in minilab.js, as data'
  );
});
