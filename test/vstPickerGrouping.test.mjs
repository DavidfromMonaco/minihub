import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPluginsByFamily } from '../src/renderer/js/core/vstChain.js';

/**
 * VST picker grouping contract (TASK 1).
 *
 * The picker groups scanned plugins into deterministic families driven by the
 * scanner-provided `role` metadata, alphabetizes within each family, hides
 * empty families, and never changes a plugin's id.
 */

// ---- deterministic order ----------------------------------------------------

test('VST picker categories appear in deterministic order', () => {
  const plugins = [
    { pluginId: 'b', name: 'Reverb Y', role: 'audio-effect' },
    { pluginId: 'a', name: 'Vital', role: 'instrument' },
    { pluginId: 'c', name: 'Utility X', role: 'utility' },
    { pluginId: 'd', name: 'Mystery', role: 'unknown' }
  ];
  const groups = groupPluginsByFamily(plugins);
  assert.deepEqual(
    groups.map((g) => g.label),
    ['INSTRUMENTS', 'AUDIO EFFECTS', 'UTILITIES / ANALYZERS', 'OTHER / UNKNOWN']
  );
});

test('MIDI effects are grouped when present', () => {
  const plugins = [{ pluginId: 'm', name: 'Arp', role: 'midi-effect' }];
  const groups = groupPluginsByFamily(plugins);
  assert.deepEqual(groups.map((g) => g.label), ['MIDI EFFECTS']);
});

test('analyzer role is treated as a utility/analyzer', () => {
  const plugins = [{ pluginId: 'a', name: 'Spectrum', role: 'analyzer' }];
  const groups = groupPluginsByFamily(plugins);
  assert.deepEqual(groups.map((g) => g.label), ['UTILITIES / ANALYZERS']);
});

// ---- alphabetical within family ---------------------------------------------

test('plugins are alphabetically sorted within their family', () => {
  const plugins = [
    { pluginId: '1', name: 'Zebra', role: 'instrument' },
    { pluginId: '2', name: 'Analog Lab V', role: 'instrument' },
    { pluginId: '3', name: 'Dexed', role: 'instrument' }
  ];
  const groups = groupPluginsByFamily(plugins);
  assert.deepEqual(groups[0].plugins.map((p) => p.name), ['Analog Lab V', 'Dexed', 'Zebra']);
});

// ---- empty families hidden --------------------------------------------------

test('empty VST categories are not shown', () => {
  const plugins = [{ pluginId: '1', name: 'Vital', role: 'instrument' }];
  const groups = groupPluginsByFamily(plugins);
  assert.deepEqual(groups.map((g) => g.label), ['INSTRUMENTS']);
});

// ---- unknown fallback --------------------------------------------------------

test('unknown plugins fall into OTHER / UNKNOWN', () => {
  const plugins = [
    { pluginId: '1', name: 'Thing', role: 'unknown' },
    { pluginId: '2', name: 'Weird', role: 'some-other-role' }
  ];
  const groups = groupPluginsByFamily(plugins);
  assert.deepEqual(groups.map((g) => g.label), ['OTHER / UNKNOWN']);
  assert.deepEqual(groups[0].plugins.map((p) => p.name), ['Thing', 'Weird']);
});

// ---- plugin ids preserved ---------------------------------------------------

test('plugin IDs are unchanged by grouping', () => {
  const plugins = [
    { pluginId: 'id-instrument', name: 'Vital', role: 'instrument' },
    { pluginId: 'id-fx', name: 'Reverb', role: 'audio-effect' },
    { pluginId: 'id-unknown', name: 'Mystery', role: 'unknown' }
  ];
  const groups = groupPluginsByFamily(plugins);
  const all = groups.flatMap((g) => g.plugins);
  assert.deepEqual(all.map((p) => p.pluginId), ['id-instrument', 'id-fx', 'id-unknown']);
});
