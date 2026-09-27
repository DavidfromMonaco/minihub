import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MANUAL_SECTIONS, installSequencerManual } from '../src/renderer/js/ui/sequencerManual.js';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

test('every section has its own id, and every link in the manual leads to one', () => {
  const ids = MANUAL_SECTIONS.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length);
  const links = MANUAL_SECTIONS.flatMap((section) => [...section.html.matchAll(/data-goto="([^"]+)"/g)].map((match) => match[1]));
  assert.ok(links.length > 0);
  for (const link of links) assert.ok(ids.includes(link), `a link to "${link}" has somewhere to go`);
  assert.equal(MANUAL_SECTIONS.filter((section) => /<svg /.test(section.html)).length >= 6, true, 'with its diagrams');
  assert.doesNotMatch(MANUAL_SECTIONS.map((section) => section.html).join(''), /style=/, 'no inline style: the CSP would drop it (invariant 10)');
});

test('what the manual says is what the code does', () => {
  // A manual that promises a key the code does not answer is worse than none.
  const module = read('../src/renderer/js/modules/sequencer/sequencerModule.js');
  const editor = read('../src/renderer/js/clipEditor.js');
  const menu = read('../src/main/appMenu.js');
  const text = MANUAL_SECTIONS.map((section) => section.html).join('');
  const claims = [
    [/Splits the selected clips at the playhead/, module, /!command && key === 's'/],
    [/Duplicates the selection/, module, /command && key === 'd'/],
    [/Selects every clip/, module, /command && key === 'a'/],
    [/Makes the selected track taller/, module, /event\.altKey && !\(event\.ctrlKey/],
    [/Pans the view/, module, /event\.button !== 1/],
    [/A new note, one Snap step long, velocity 100/, editor, /durationPpq: snapLength\(\)[\s\S]{0,120}velocity: 100/],
    [/change the rows' height/, editor, /event\.shiftKey \? \{ noteHeight/],
    [/This manual/, menu, /accelerator: 'F1'/]
  ];
  for (const [said, source, done] of claims) {
    assert.match(text, said);
    assert.match(source, done, `the code answers: ${said}`);
  }
});

/** Just enough of a DOM for the panel: a root, a content, a window. */
function fakeDom() {
  const listeners = new Map();
  const content = { focused: false, focus() { this.focused = true; }, scrollTop: 0, offsetTop: 0 };
  const root = {
    innerHTML: '',
    classList: { set: new Set(['hidden']), add(name) { this.set.add(name); }, remove(name) { this.set.delete(name); }, contains(name) { return this.set.has(name); } },
    querySelector: (selector) => (selector === '[data-manual-content]' ? content : null),
    addEventListener() {}
  };
  const win = {
    addEventListener: (type, fn, capture) => listeners.set(`${type}:${capture}`, fn),
    key: (key) => {
      const event = { key, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
      listeners.get('keydown:true')?.(event);
      return event;
    }
  };
  return { root, content, win, doc: { activeElement: null } };
}

test('the panel opens over the window, takes the keyboard, and Esc closes it', () => {
  const dom = fakeDom();
  const manual = installSequencerManual({ root: dom.root, doc: dom.doc, win: dom.win });
  assert.match(dom.root.innerHTML, /Sequencer Manual/);
  assert.equal(dom.win.key(' ').stopped, false, 'closed, it leaves every key alone');
  manual.open();
  assert.equal(manual.isOpen, true);
  assert.equal(dom.root.classList.contains('hidden'), false);
  assert.equal(dom.content.focused, true, 'the page is focused, so the arrows and Space scroll it');
  assert.equal(dom.win.key(' ').stopped, true, 'Space no longer reaches the transport');
  assert.equal(dom.win.key('Delete').stopped, true, 'nor Delete the selected clips');
  const escape = dom.win.key('Escape');
  assert.equal(escape.prevented, true);
  assert.equal(manual.isOpen, false);
  assert.equal(dom.root.classList.contains('hidden'), true);
});

test('Help is a menu of the header, and its entry opens the manual', async () => {
  const html = read('../src/renderer/index.html');
  assert.match(html, /data-app-menu="help"[^>]*>Help</);
  assert.match(html, /id="manual-root" class="manual-root hidden"/);
  const { MENU_COMMANDS, bindMenuCommands } = await import('../src/renderer/js/core/menuCommands.js');
  assert.ok(MENU_COMMANDS.includes('help:sequencer-manual'));
  let opened = 0;
  let listener = null;
  bindMenuCommands({ manual: { open: () => { opened += 1; } } }, { onMenuCommand: (callback) => { listener = callback; return () => {}; } });
  listener('help:sequencer-manual');
  assert.equal(opened, 1);
});
