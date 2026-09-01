import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { bindTempoInput, normalizeTempo } from '../src/renderer/js/core/tempoControl.js';
import { fire, installDom, makeEl } from './domShim.mjs';

test('global transport contains only Play, Stop and the shared Tempo control', () => {
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const transport = /<div class="transport"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] || '';
  assert.match(transport, /id="transport-play"[^>]*>Play<\/button>/);
  assert.match(transport, /id="transport-stop"[^>]*>Stop<\/button>/);
  assert.match(transport, /Tempo[^<]*<input id="transport-bpm"[^>]*min="20"[^>]*max="300"/);
  assert.doesNotMatch(transport, /metronome|métronome|metro|volume|transport-record/i);
});

test('tempo keeps keyboard entry and adds bounded progressive right-button vertical drag', () => {
  installDom();
  const input = makeEl('input');
  input.ownerDocument = document;
  input.value = '120';
  const committed = [];
  const cleanup = bindTempoInput(input, (tempo) => committed.push(tempo), { pixelsPerBpm: 3 });

  input.value = '137';
  fire(input, 'change');
  assert.equal(committed.at(-1), 137, 'ordinary numeric keyboard commit remains active');

  const leftDown = fire(input, 'pointerdown', { button: 0, clientY: 100 });
  assert.equal(leftDown.defaultPrevented, false);
  assert.equal(input.dataset.tempoDragging, undefined, 'left click remains available for text editing');

  const rightDown = fire(input, 'pointerdown', { button: 2, clientY: 100, pointerId: 7 });
  assert.equal(rightDown.defaultPrevented, true);
  assert.equal(input.dataset.tempoDragging, 'true');
  fire(document, 'pointermove', { button: 2, clientY: 91, pointerId: 7 });
  assert.equal(input.value, '140', 'moving up by nine pixels adds three BPM progressively');
  fire(document, 'pointermove', { button: 2, clientY: 97, pointerId: 7 });
  assert.equal(input.value, '138', 'moving back down subtracts BPM during the same drag');
  fire(document, 'pointermove', { button: 2, clientY: -1000, pointerId: 7 });
  assert.equal(input.value, '300');
  fire(document, 'pointermove', { button: 2, clientY: 2000, pointerId: 7 });
  assert.equal(input.value, '20');
  const context = fire(input, 'contextmenu', { button: 2 });
  assert.equal(context.defaultPrevented, true, 'native context menu is suppressed on the tempo value');
  fire(document, 'pointerup', { button: 2, clientY: 2000, pointerId: 7 });
  assert.equal(input.dataset.tempoDragging, undefined);
  assert.equal(normalizeTempo(-1), 20);
  assert.equal(normalizeTempo(999), 300);
  cleanup();
});
