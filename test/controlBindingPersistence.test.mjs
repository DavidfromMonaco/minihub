/**
 * A learned binding is never thrown away by a load.
 *
 * MINIHUB_CONTROLLER_PLATFORM_SPEC.md section 6.1 names this the gravest defect
 * of the whole workstream, and it is not hypothetical: bindings live inside the
 * `.minihub` file, and `normalizeControlBinding` used to drop every one whose
 * control it could not find in the MiniLab table. Profile missing for any reason
 * -> bindings dropped in silence on load -> the next save writes the file without
 * them. Hours of Learn, gone, with nothing to undo.
 *
 * The rule these tests hold: **shape is validated on load, belonging is resolved
 * at use.** A binding that resolves to nothing is kept, reported
 * `missing-target`, and not routed. Kept is not the same as obeyed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import {
  CONTROL_BINDING_VERSION,
  ControlBindingManager,
  normalizeControlBinding,
  normalizeControlBindings
} from '../src/renderer/js/core/controlBindings.js';

const binding = (sourceControlId, parameterId = '4242') => ({
  version: CONTROL_BINDING_VERSION,
  sourceControlId,
  pluginInstanceId: 'plugin-1',
  pluginId: 'C:/VST3/Vital.vst3',
  parameterId,
  pluginName: 'Vital',
  parameterName: 'Cutoff'
});

/** A controller nobody here owns, learned on a machine that did. */
const FROM_ANOTHER_KEYBOARD = 'launchkey-49:knob-3';

const projectWith = (...bindings) => ({
  nodeInstances: {
    instances: [{
      id: 'vst-001',
      type: 'vst',
      ordinal: 1,
      content: { plugins: [], controlBindings: bindings }
    }],
    idSeq: { vst: 1 }
  }
});

test('a binding whose control cannot be resolved survives load, save and load again', async () => {
  const hub = makeFullHub(projectWith(binding('minilab-3:k1'), binding(FROM_ANOTHER_KEYBOARD, '77')));
  await hub.nodes.load();

  const afterLoad = hub.nodes.getControlBindings('vst-001').map((item) => item.sourceControlId);
  assert.deepEqual(afterLoad, ['minilab-3:k1', FROM_ANOTHER_KEYBOARD],
    'the unresolved binding was dropped on load — this is the defect');

  // Any later write is what used to make the loss permanent, so the test writes.
  assert.equal(hub.nodes.setControlBinding('vst-001', binding('minilab-3:k2', '99')), true);

  const written = hub.settings.get('nodeInstances').instances[0].content.controlBindings;
  assert.deepEqual(written.map((item) => item.sourceControlId).sort(),
    [FROM_ANOTHER_KEYBOARD, 'minilab-3:k1', 'minilab-3:k2'].sort(),
    'the saved file lost a binding it was only holding for someone else');

  const reopened = makeFullHub({ nodeInstances: hub.settings.get('nodeInstances') });
  await reopened.nodes.load();
  const orphan = reopened.nodes.getControlBindings('vst-001')
    .find((item) => item.sourceControlId === FROM_ANOTHER_KEYBOARD);
  assert.ok(orphan, 'the binding did not survive the round trip');
  assert.equal(orphan.parameterId, '77', 'it survived, but not intact');
  assert.equal(orphan.parameterName, 'Cutoff');
});

test('what is validated on load is the shape of the key, not the existence of the control', () => {
  assert.ok(normalizeControlBinding(binding(FROM_ANOTHER_KEYBOARD)),
    'a well-formed key for an absent profile is a binding this build cannot use, not a corrupt record');

  for (const key of [
    'minilab-3',                    // no control
    ':k1',                          // no profile
    'minilab-3:',                   // no control, with the colon
    'minilab-3:k1:extra',           // an identifier may not contain a colon
    'MiniLab-3:k1',                 // identifiers are lowercase
    'minilab_3:k1',                 // and hyphenated, not underscored
    'minilab-3:k 1',
    `${'x'.repeat(65)}:k1`,         // bounded, or persistence widens without limit
    42,
    null
  ]) {
    assert.equal(normalizeControlBinding(binding(key)), null, `accepted the key ${JSON.stringify(key)}`);
  }
});

test('two bindings for one source still collapse to one, whether resolved or not', () => {
  const kept = normalizeControlBindings([
    binding(FROM_ANOTHER_KEYBOARD, '1'),
    binding(FROM_ANOTHER_KEYBOARD, '2'),
    binding('minilab-3:k1', '3')
  ]);
  assert.deepEqual(kept.map((item) => [item.sourceControlId, item.parameterId]),
    [[FROM_ANOTHER_KEYBOARD, '1'], ['minilab-3:k1', '3']],
    'the first record for a source wins, as it always has');
});

test('an unresolved binding reports missing-target, and is never routed', async () => {
  const hub = makeFullHub(projectWith(binding(FROM_ANOTHER_KEYBOARD)));
  await hub.nodes.load();
  hub.engine = {
    state: 'running',
    getInstanceStatus: () => 'ready',
    getInstanceGeneration: () => 1,
    getOpenEditors: () => [],
    setVstParameter: () => { throw new Error('an unresolved binding reached the engine'); }
  };
  const control = new ControlBindingManager(hub);

  const status = control.bindingStatus('vst-001', FROM_ANOTHER_KEYBOARD);
  assert.equal(status.state, 'missing-target');
  assert.equal(status.binding.parameterId, '4242', 'the record is still there to be repaired');

  const routed = control.route('vst-001', {
    type: 'control', sourceControlId: FROM_ANOTHER_KEYBOARD, normalizedValue: 0.5
  });
  assert.equal(routed.ok, false);
  assert.equal(routed.reason, 'unknown-source', 'kept is not the same as obeyed');

  control.dispose();
});
