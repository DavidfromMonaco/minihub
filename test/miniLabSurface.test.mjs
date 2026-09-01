import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeEl, findClass } from './domShim.mjs';
import { MINILAB_CONTROL_SOURCES } from '../src/renderer/js/midi/minilabControls.js';
import {
  MINILAB_SURFACE_LAYOUT,
  miniLabControlSurfaceHtml,
  appendMiniLabControlSurfaceSvg
} from '../src/renderer/js/ui/miniLabControlSurface.js';

test('one MiniLab layout is shared by Learn HTML and Patch Bay SVG', () => {
  assert.deepEqual(MINILAB_SURFACE_LAYOUT.knobs.map((item) => item.id),
    MINILAB_CONTROL_SOURCES.filter((item) => item.family === 'knob').map((item) => item.id));
  const html = miniLabControlSurfaceHtml();
  assert.equal((html.match(/class="ml-surface-knob/g) || []).length, 8);
  assert.match(html, /data-minilab-surface="learn"/);
  assert.match(html, />PITCH</);
  assert.match(html, />MOD</);
  assert.equal((html.match(/class="ml-surface-fader /g) || []).length, 4);
  assert.equal((html.match(/class="ml-surface-pad /g) || []).length, 8);

  installDom();
  const parent = makeEl('g');
  const ports = [];
  appendMiniLabControlSurfaceSvg(parent, {
    connectedPortIds: new Set(['control-k1']),
    buildPort(control) {
      ports.push(control.portId);
      const el = makeEl('g');
      el.dataset.portId = control.portId;
      return el;
    }
  });
  assert.deepEqual([...ports].sort(), MINILAB_CONTROL_SOURCES.map((item) => item.portId).sort());
  const surface = findClass(parent, 'minilab-control-surface-svg');
  assert.equal(surface.attributes['data-minilab-surface'], 'patch-bay');
  assert.equal(ports.filter((id) => id === 'control-k1').length, 1);
});

test('caller-provided Learn states do not create another control model', () => {
  const html = miniLabControlSurfaceHtml({
    selectedId: 'minilab-3:k1',
    states: { 'minilab-3:k1': 'learn-armed', 'minilab-3:k2': 'mapped' }
  });
  assert.match(html, /state-learn-armed selected/);
  assert.match(html, /state-mapped/);
  for (const source of MINILAB_CONTROL_SOURCES) assert.match(html, new RegExp(source.id));
  assert.match(html, /minilab-3:f1/);
  assert.match(html, /minilab-3:p1/);
});
