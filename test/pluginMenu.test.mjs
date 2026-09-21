import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fire, installDom } from './domShim.mjs';

installDom();
const { foldPluginsByBrand, pluginPickerSections } = await import('../src/renderer/js/core/vstChain.js');
const { bindPluginMenu, closePluginMenu, openPluginMenu } = await import('../src/renderer/js/ui/pluginMenu.js');

const fx = (name, manufacturer) => ({ pluginId: `C:\\VST3\\${name}.vst3`, name, manufacturer, role: 'audio-effect' });
const synth = (name, manufacturer) => ({ ...fx(name, manufacturer), role: 'instrument' });

const shown = (entries) => entries.map((entry) => entry.brand ? `${entry.brand} (${entry.plugins.length})` : entry.plugin.name);

test('a brand with several plugins in a family folds into one entry, a lone plugin stays a line', () => {
  const entries = foldPluginsByBrand([
    fx('kHs Reverb', 'Kilohearts'), fx('Atmospheres', 'ZAK Sound'), fx('kHs Gain', 'Kilohearts'),
    fx('ValhallaDelay', 'Valhalla DSP, LLC'), fx('PaulXStretch', 'Sonosaurus'), fx('ValhallaSupermassive', 'Valhalla DSP, LLC')
  ]);
  assert.deepEqual(shown(entries), ['Atmospheres', 'Kilohearts (2)', 'PaulXStretch', 'Valhalla DSP, LLC (2)'],
    'a brand sits where its own name falls among the plugins');
  assert.deepEqual(entries[1].plugins.map((p) => p.name), ['kHs Gain', 'kHs Reverb']);
});

test('the fold never crosses families, ignores case, and never folds plugins that name no brand', () => {
  const sections = pluginPickerSections([
    synth('Azure Lake', 'ZAK Sound'), synth('Ibiskus', 'zak sound '), fx('Atmospheres', 'ZAK Sound'),
    fx('Mystery A', ''), fx('Mystery B', undefined)
  ]);
  assert.deepEqual(sections.map((s) => [s.label, shown(s.entries)]), [
    ['INSTRUMENTS', ['ZAK Sound (2)']],
    ['AUDIO EFFECTS', ['Atmospheres', 'Mystery A', 'Mystery B']]
  ]);
  const every = sections.flatMap((s) => s.entries.flatMap((e) => e.plugins || [e.plugin])).map((p) => p.pluginId);
  assert.equal(new Set(every).size, 5, 'every plugin appears once, its id untouched');
});

test('the list is built from text, opens a brand beside it, and a pick closes everything', () => {
  const docListeners = () => Object.values(globalThis.document._listeners).reduce((n, set) => n + set.size, 0);
  const before = docListeners();
  const anchor = globalThis.document.createElement('select');
  const picks = [];
  openPluginMenu({
    anchor,
    sections: pluginPickerSections([fx('kHs Gain', 'Kilohearts'), fx('kHs Reverb', 'Kilohearts'), fx('<img src=x>', 'Evil')]),
    pickedId: '',
    onPick: (plugin) => picks.push(plugin.name)
  });
  const body = globalThis.document.body;
  const main = body.children.at(-1);
  assert.equal(main._classSet.has('plugin-menu'), true);
  const rows = main.children.filter((child) => child.tagName === 'BUTTON');
  assert.equal(rows[0].children[0].textContent, '<img src=x> · Evil', 'a name stays text');
  assert.equal(rows[1].children[0].textContent, 'Kilohearts');

  fire(rows[1], 'pointerenter');
  const brand = body.children.at(-1);
  assert.notEqual(brand, main, 'the brand opens its own panel beside the list');
  const inner = brand.children.filter((child) => child.tagName === 'BUTTON');
  assert.deepEqual(inner.map((row) => row.children[0].textContent), ['kHs Gain', 'kHs Reverb']);

  for (const listener of globalThis.document._listeners.wheel) listener({ target: inner[1] });
  assert.equal(brand.parentNode, body, 'a wheel inside the list scrolls it and closes nothing');

  fire(inner[1], 'click');
  assert.deepEqual(picks, ['kHs Reverb']);
  assert.equal(main.parentNode, null);
  assert.equal(brand.parentNode, null);
  assert.equal(docListeners(), before, 'no document listener is left behind');
});

test('the select opens the list instead of its own and takes the plugin picked', () => {
  const root = globalThis.document.createElement('div');
  const select = globalThis.document.createElement('select');
  select.setAttribute('class', 'select select-sm plugin-pick');
  root.appendChild(select);
  const changes = [];
  select.dispatchEvent = (event) => changes.push(event.type);
  const dispose = bindPluginMenu(root, { plugins: () => [synth('Vital', 'Vital Audio'), synth('Dexed', 'Digital Suburban')] });

  const press = fire(root, 'pointerdown', { target: select });
  assert.equal(press.defaultPrevented, true, 'the browser never opens its white list');
  const main = globalThis.document.body.children.at(-1);
  const rows = main.children.filter((child) => child.tagName === 'BUTTON');
  fire(rows[1], 'click');
  assert.equal(select.value, 'C:\\VST3\\Vital.vst3');
  assert.deepEqual(changes, ['input', 'change']);

  fire(root, 'keydown', { target: select, key: 'Enter' });
  assert.equal(globalThis.document.body.children.at(-1)._classSet.has('plugin-menu'), true, 'Enter opens it too');
  dispose();
  assert.equal(globalThis.document.body.children.filter((child) => child._classSet.has('plugin-menu')).length, 0,
    'and leaving the page closes it');
  closePluginMenu();
});
