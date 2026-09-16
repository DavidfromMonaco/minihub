import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundlePathOf, oneEntryPerPlugin, pluginLookup } from '../src/renderer/js/core/pluginCatalog.js';

/**
 * Contract: a VST3 plugin shipped as a folder is one catalogue entry, named by
 * its folder, and still found by the path of the module inside it.
 *
 * The data mirrors the author's settings.json of 2026-09-16, where a scanner
 * that walked into plugin folders had listed three plugins twice (DECISIONS
 * D-044), and saved projects named either copy.
 */

const SPLICE = 'C:\\Program Files\\Common Files\\VST3\\Splice\\Splice INSTRUMENT.vst3';
const SPLICE_MODULE = `${SPLICE}\\Contents\\x86_64-win\\Splice INSTRUMENT.vst3`;
const RING = 'C:\\Users\\me\\AppData\\Local\\Programs\\Common\\VST3\\ONE RING.vst3';
const RING_MODULE = `${RING}\\Contents\\x86_64-win\\ONE RING.vst3`;
const PAUL = 'C:\\Program Files\\Common Files\\VST3\\PaulXStretch.vst3';
const PAUL_MODULE = `${PAUL}\\Contents\\x86_64-win\\PaulXStretch.vst3`;
const DEXED = 'C:\\Program Files\\Common Files\\VST3\\Dexed.vst3';

const entry = (pluginId, name, extra = {}) => ({ pluginId, path: pluginId, name, ...extra });

// As the author's catalogue held them: a folder described from its
// moduleinfo.json knows no bus, the module scanned inside it does. PaulXStretch
// has no moduleinfo.json, so JUCE itself names it by its module, once.
const doubled = () => [
  entry(DEXED, 'Dexed', { role: 'instrument', isInstrument: true, numInputChannels: 0, numOutputChannels: 2 }),
  entry(SPLICE, 'Splice INSTRUMENT', {
    role: 'instrument', isInstrument: true, category: 'Instrument|Synth', numInputChannels: 0, numOutputChannels: 0
  }),
  entry(SPLICE_MODULE, 'Splice INSTRUMENT', {
    role: 'instrument', isInstrument: true, category: 'Instrument|Synth', numInputChannels: 0, numOutputChannels: 2
  }),
  entry(RING, 'ONE RING', { role: 'unknown', category: 'Fx', numInputChannels: 0, numOutputChannels: 0 }),
  entry(RING_MODULE, 'ONE RING', { role: 'audio-effect', category: 'Fx', numInputChannels: 2, numOutputChannels: 2 }),
  entry(PAUL_MODULE, 'PaulXStretch', { role: 'audio-effect', category: 'Fx|Network', numInputChannels: 2, numOutputChannels: 2 })
];

test('the folder of a plugin is read from the folder, the module inside it, or a bare file', () => {
  assert.equal(bundlePathOf(SPLICE), SPLICE);
  assert.equal(bundlePathOf(SPLICE_MODULE), SPLICE);
  assert.equal(bundlePathOf(DEXED), DEXED);
  assert.equal(bundlePathOf('C:/VST3/ONE RING.vst3/Contents/x86_64-win/ONE RING.vst3'), 'C:/VST3/ONE RING.vst3');
  assert.equal(bundlePathOf('C:\\VST3\\Tools.vst3x\\Real.VST3'), 'C:\\VST3\\Tools.vst3x\\Real.VST3',
    'only a whole segment ending in .vst3 counts');
  assert.equal(bundlePathOf('p0'), '');
  assert.equal(bundlePathOf('minihub-test://landr-noisy-helper'), '');
  assert.equal(bundlePathOf(undefined), '');
});

test('a plugin listed by its folder and by its module is kept once, under its folder, in place', () => {
  const merged = oneEntryPerPlugin(doubled());
  assert.deepEqual(merged.map((plugin) => plugin.pluginId), [DEXED, SPLICE, RING, PAUL_MODULE]);
});

test('the folder entry takes what only the module scan measured, and nothing else', () => {
  const [, splice, ring] = oneEntryPerPlugin(doubled());
  // ONE RING's folder read "unknown": that is why projects named its module.
  assert.equal(ring.role, 'audio-effect');
  assert.equal(ring.numInputChannels, 2);
  assert.equal(ring.numOutputChannels, 2);
  assert.equal(ring.path, RING);
  assert.equal(splice.role, 'instrument');
  assert.equal(splice.numOutputChannels, 2);
  assert.equal(splice.category, 'Instrument|Synth');
});

test('what the folder entry already knows is not overwritten', () => {
  const [kept] = oneEntryPerPlugin([
    entry(RING, 'ONE RING', { role: 'audio-effect', numInputChannels: 2, numOutputChannels: 2, classId: 'A'.repeat(32) }),
    entry(RING_MODULE, 'ONE RING', { role: 'unknown', numInputChannels: 4, numOutputChannels: 4, classId: 'B'.repeat(32) })
  ]);
  assert.equal(kept.role, 'audio-effect');
  assert.equal(kept.numInputChannels, 2);
  assert.equal(kept.classId, 'A'.repeat(32));
});

test('a class UID only the module scan could read is kept', () => {
  const [kept] = oneEntryPerPlugin([
    entry(RING, 'ONE RING', { role: 'audio-effect', classId: '' }),
    entry(RING_MODULE, 'ONE RING', { role: 'audio-effect', classId: 'C'.repeat(32) })
  ]);
  assert.equal(kept.classId, 'C'.repeat(32));
});

test('the catalogue never loses a plugin: two names in one folder stay two plugins', () => {
  const suite = [
    entry('C:\\VST3\\Suite.vst3', 'Suite Reverb', { role: 'audio-effect' }),
    entry('C:\\VST3\\Suite.vst3\\Contents\\x86_64-win\\Suite.vst3', 'Suite Delay', { role: 'audio-effect' })
  ];
  assert.deepEqual(oneEntryPerPlugin(suite), suite);
});

test('the same folder spelled with other slashes or case is still one plugin, and the folder wins', () => {
  const merged = oneEntryPerPlugin([
    entry(RING_MODULE.replace(/\\/g, '/').toLowerCase(), 'one ring ', { role: 'audio-effect' }),
    entry(RING, 'ONE RING', { role: 'unknown' })
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].pluginId, RING, 'even when the module was listed first');
  assert.equal(merged[0].role, 'audio-effect');
});

test('merging copies: the entries given stay as they were, and a clean list comes back as it was', () => {
  const given = doubled();
  const before = structuredClone(given);
  const merged = oneEntryPerPlugin(given);
  assert.deepEqual(given, before);
  assert.equal(merged[0], given[0], 'an entry with nothing to merge is the same object');
  assert.deepEqual(oneEntryPerPlugin(merged), merged, 'merging twice changes nothing');
  assert.deepEqual(oneEntryPerPlugin(undefined), []);
});

test('entries whose id is not a plugin path pass through in place', () => {
  const list = [{ pluginId: 'p0', name: 'A' }, { pluginId: 'p0', name: 'A' }, null];
  assert.deepEqual(oneEntryPerPlugin(list), list);
});

test('either path into a folder finds its one entry, whatever the slashes or case', () => {
  const find = pluginLookup(oneEntryPerPlugin(doubled()));
  assert.equal(find(SPLICE).pluginId, SPLICE);
  assert.equal(find(SPLICE_MODULE).pluginId, SPLICE, 'a pick of the second Splice names its module');
  assert.equal(find(RING_MODULE).pluginId, RING, 'Orbites and Metamorphose name ONE RING by its module');
  assert.equal(find(RING_MODULE.replace(/\\/g, '/').toUpperCase()).pluginId, RING);
  assert.equal(find(PAUL).pluginId, PAUL_MODULE, 'a plugin listed by its module is found from its folder too');
  assert.equal(find(DEXED).pluginId, DEXED);
  assert.equal(find('C:\\Program Files\\Common Files\\VST3\\Nope.vst3'), null);
  assert.equal(find(''), null);
  assert.equal(find(undefined), null);
});

test('a folder holding plugins under several names answers only to their own ids', () => {
  const reverb = entry('C:\\VST3\\Suite.vst3', 'Suite Reverb');
  const delay = entry('C:\\VST3\\Suite.vst3\\Contents\\x86_64-win\\Suite.vst3', 'Suite Delay');
  const find = pluginLookup([reverb, delay]);
  assert.equal(find(reverb.pluginId), reverb);
  assert.equal(find(delay.pluginId), delay);
  assert.equal(find('C:\\VST3\\Suite.vst3\\Contents\\x86-win\\Suite.vst3'), null, 'which one was meant cannot be told');
});

test('an id that is not a path is found exactly, as before', () => {
  const find = pluginLookup([{ pluginId: 'p0', name: 'A' }]);
  assert.equal(find('p0').name, 'A');
  assert.equal(find('P0'), null);
});
