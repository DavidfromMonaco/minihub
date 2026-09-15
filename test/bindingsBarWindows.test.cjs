'use strict';

/*
 * The bindings bar docked under each plugin editor: DECISIONS D-021,
 * plans/active/bindings-bar-docked.md. What is tested here is everything that
 * does not need a screen -- which bar exists, where it is put, what may cross into
 * it and out of it. Whether it LOOKS docked is checked on the running application.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BindingsBarWindows, placeBar, validAction, validValues, BAR_HEIGHT, COLUMN_WIDTH, COLUMN_MIN_HEIGHT
} = require('../src/main/bindingsBarWindows');

let nextWebContentsId = 100;
class FakeWebContents {
  constructor() { this.id = nextWebContentsId++; this.sent = []; this.destroyed = false; this.listeners = new Map(); }
  isDestroyed() { return this.destroyed; }
  on(type, callback) { this.listeners.set(type, callback); }
  send(channel, payload) {
    if (this.destroyed) throw new Error('Object has been destroyed');
    this.sent.push({ channel, payload });
  }
}

class FakeWindow {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.listeners = new Map();
    this.destroyed = false;
    this.visible = false;
    this.bounds = null;
    this.stackedAbove = [];
    FakeWindow.instances.push(this);
  }
  on(type, callback) { this.listeners.set(type, callback); }
  loadFile(file) { this.loaded = file; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  setBounds(bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  moveAbove(sourceId) { this.stackedAbove.push(sourceId); }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.listeners.get('closed')?.();
  }
}

/** A single screen at `scale`, its work area ending 40 DIPs above the bottom. */
function fakeScreen(scale = 1, size = { width: 1920, height: 1080 }) {
  return {
    screenToDipRect: (_window, rect) => ({
      x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale
    }),
    screenToDipPoint: (point) => ({ x: point.x / scale, y: point.y / scale }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: size.width / scale, height: size.height / scale - 40 } })
  };
}

function rig({ scale = 1 } = {}) {
  FakeWindow.instances = [];
  const handlers = new Map();
  const ipcMain = { handle: (channel, callback) => handlers.set(channel, callback) };
  const mainWindow = { webContents: new FakeWebContents(), isDestroyed: () => false };
  const bars = new BindingsBarWindows({
    BrowserWindow: FakeWindow, ipcMain, screen: fakeScreen(scale), mainWindow,
    preloadPath: 'bindingsBarPreload.js', htmlPath: 'bindings-bar.html'
  });
  bars.bind();
  const mainEvent = { sender: mainWindow.webContents };
  return { bars, handlers, mainWindow, mainEvent };
}

const opened = (overrides = {}) => ({
  type: 'editorStatus', chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'x', generation: 7, open: true, ...overrides
});
const frame = (overrides = {}) => ({
  type: 'editorBounds', chainId: 'vst-001', instanceId: 'plugin-1', generation: 7,
  x: 200, y: 100, width: 1424, height: 600, clientY: 131, minimized: false, raised: false, windowHandle: 526302,
  ...overrides
});

/** An editor that opened, whose bar page loaded and was drawn once. */
async function drawnBar(context, overrides = {}) {
  const { bars, handlers, mainEvent } = context;
  bars.onEngineEvent(opened());
  bars.onEngineEvent(frame(overrides));
  const window = FakeWindow.instances.at(-1);
  await handlers.get('bindings-bar:ready')({ sender: window.webContents });
  await handlers.get('bindings-bar:render')(mainEvent, { chainId: 'vst-001', instanceId: 'plugin-1', html: '<p>panel</p>' });
  return window;
}

test('an editor that opens gets one bar, which stays hidden until it has been drawn', async () => {
  const context = rig();
  const { bars, handlers, mainWindow } = context;
  bars.onEngineEvent(opened());
  bars.onEngineEvent(opened());
  assert.equal(FakeWindow.instances.length, 1, 'reopening an open editor does not stack a second bar');
  const window = FakeWindow.instances[0];
  assert.equal(window.options.frame, false);
  assert.equal(window.options.focusable, false, 'a click in the bar must not take the keyboard from the plugin');
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);

  bars.onEngineEvent(frame());
  assert.equal(window.visible, false, 'an empty bar is not shown');

  assert.equal(await handlers.get('bindings-bar:ready')({ sender: window.webContents }), true);
  assert.deepEqual(mainWindow.webContents.sent.at(-1),
    { channel: 'bindings-bar:wanted', payload: { chainId: 'vst-001', instanceId: 'plugin-1' } });
  await handlers.get('bindings-bar:render')(context.mainEvent, { chainId: 'vst-001', instanceId: 'plugin-1', html: '<p>panel</p>' });
  assert.deepEqual(window.webContents.sent.at(-1), { channel: 'bindings-bar:render', payload: '<p>panel</p>' });
  assert.equal(window.visible, true);
  assert.deepEqual(window.stackedAbove, ['window:526302:0'], 'stacked directly on its plugin frame, not over everything');
});

test('the bar sits under the frame, as wide as the frame, in DIPs', async () => {
  const window = await drawnBar(rig());
  assert.deepEqual(window.bounds, { x: 200, y: 700, width: 1424, height: BAR_HEIGHT });
});

test('physical pixels from the engine are converted before the bar is placed', async () => {
  // The engine reports physical pixels. At 150 %, a frame at (300, 150) sized
  // 2136 x 540 is (200, 100) sized 1424 x 360 in DIPs, so its bar goes at y 460.
  // Unconverted, it would be 1.5 times too far right and too low -- and at 100 %,
  // the author's screen, the two are the same numbers and nothing would show it.
  const window = await drawnBar(rig({ scale: 1.5 }), { x: 300, y: 150, width: 2136, height: 540, clientY: 196 });
  assert.deepEqual(window.bounds, { x: 200, y: 460, width: 1424, height: BAR_HEIGHT });
});

test('with no room under the frame, the bar stands beside it as a column as tall as the frame', () => {
  // Analog Lab V on the author's screen, 1920 x 1080 with the taskbar hidden: its
  // frame is 918 px tall, so there is no position with 182 px under it. Docked
  // under anyway, the bar covered the plugin's bottom and took its clicks.
  const work = { x: 0, y: 0, width: 1920, height: 1080 };
  const analogLab = { x: 107, y: 40, width: 1282, height: 918 };
  assert.deepEqual(placeBar(analogLab, 71, work), { x: 1389, y: 40, width: COLUMN_WIDTH, height: 918 });
  // Near the right edge, the left side is where the room is.
  assert.deepEqual(placeBar({ ...analogLab, x: 600 }, 71, work),
    { x: 600 - COLUMN_WIDTH, y: 40, width: COLUMN_WIDTH, height: 918 });
});

test('with less room than a column on either side, the column narrows rather than covering the plugin', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1080 };
  // Centred, Analog Lab leaves 319 px on each side: 319 on the right.
  assert.deepEqual(placeBar({ x: 319, y: 40, width: 1282, height: 918 }, 71, work),
    { x: 1601, y: 40, width: 319, height: 918 });
  // 340 on the left and 298 on the right: the left.
  assert.deepEqual(placeBar({ x: 340, y: 40, width: 1282, height: 918 }, 71, work),
    { x: 0, y: 40, width: 340, height: 918 });
});

test('a column beside a short plugin low on the screen is stretched to hold the panel, on screen', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1080 };
  // Dexed dragged down to y 800: 280 of its 706 px are on screen.
  const column = placeBar({ x: 100, y: 800, width: 868, height: 706 }, 831, work);
  assert.deepEqual(column, { x: 968, y: 600, width: COLUMN_WIDTH, height: COLUMN_MIN_HEIGHT });
  assert.ok(column.height > column.width, 'taller than wide: the page reads its layout from that');
});

test('with room neither under nor beside, the bar rides over the bottom of the plugin, never over the caption', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  // Room under: directly below.
  assert.equal(placeBar({ x: 0, y: 0, width: 1400, height: 850 }, 31, work).y, 850);
  // Too wide for a column beside it: the bar rides over the bottom of the plugin
  // instead of leaving the screen.
  assert.deepEqual(placeBar({ x: 0, y: 100, width: 1700, height: 893 }, 131, work),
    { x: 0, y: 1040 - BAR_HEIGHT, width: 1700, height: BAR_HEIGHT });
  // A frame dragged almost off the bottom: the bar stays below the caption, off
  // screen with its plugin, rather than covering the title bar it is dragged back by.
  assert.equal(placeBar({ x: 0, y: 1000, width: 1700, height: 893 }, 1031, work).y, 1031);
  // Horizontally it follows the frame wherever it goes.
  assert.equal(placeBar({ x: -600, y: 0, width: 1400, height: 400 }, 31, work).x, -600);
});

test('a column is placed in DIPs too', async () => {
  // At 150 % the fake work area is 1280 x 680 DIPs. A frame of 1050 x 900
  // physical pixels at (90, 60) is 700 x 600 DIPs at (60, 40): 182 under it
  // would end at 822, and there are 520 DIPs on its right.
  const window = await drawnBar(rig({ scale: 1.5 }), { x: 90, y: 60, width: 1050, height: 900, clientY: 107 });
  assert.deepEqual(window.bounds, { x: 760, y: 40, width: COLUMN_WIDTH, height: 600 });
});

test('a frame that moves takes its bar along, and a click on it restacks the bar', async () => {
  const context = rig();
  const window = await drawnBar(context);
  context.bars.onEngineEvent(frame({ x: 320, y: 140 }));
  assert.deepEqual(window.bounds, { x: 320, y: 740, width: 1424, height: BAR_HEIGHT });
  assert.equal(window.stackedAbove.length, 1, 'a move is not a restack');
  context.bars.onEngineEvent(frame({ x: 320, y: 140, raised: true }));
  assert.equal(window.stackedAbove.length, 2);
});

test('minimising the plugin hides its bar, restoring it brings the bar back on top', async () => {
  const context = rig();
  const window = await drawnBar(context);
  context.bars.onEngineEvent(frame({ x: -32000, y: -32000, width: 160, height: 28, minimized: true }));
  assert.equal(window.visible, false);
  context.bars.onEngineEvent(frame());
  assert.equal(window.visible, true);
  assert.equal(window.stackedAbove.length, 2, 'shown again means stacked again');
  assert.deepEqual(window.bounds, { x: 200, y: 700, width: 1424, height: BAR_HEIGHT });
});

test('the bar closes with its editor, with its plugin, and with the engine', async () => {
  let context = rig();
  let window = await drawnBar(context);
  context.bars.onEngineEvent(opened({ open: false }));
  assert.equal(window.destroyed, true, 'closing the editor');
  assert.deepEqual(context.bars.openBars(), []);

  context = rig();
  window = await drawnBar(context);
  // A plugin rebuilt under an open editor destroys the editor without a close
  // message: only the generation says so.
  context.bars.onEngineEvent({ type: 'chainChanged', chainId: 'vst-001', instances: [{ instanceId: 'plugin-1', generation: 8, status: 'ready' }] });
  assert.equal(window.destroyed, true, 'a rebuilt plugin');

  context = rig();
  window = await drawnBar(context);
  context.bars.onEngineEvent({ type: 'instanceStatus', chainId: 'vst-001', instanceId: 'plugin-1', generation: 9, status: 'loading' });
  assert.equal(window.destroyed, true, 'a replaced plugin');

  context = rig();
  window = await drawnBar(context);
  context.bars.onEngineState('error');
  assert.equal(window.destroyed, true, 'the engine went away');
});

test('only the main renderer draws a bar, and only a live bar is drawn', async () => {
  const context = rig();
  const { bars, handlers, mainEvent } = context;
  bars.onEngineEvent(opened());
  const window = FakeWindow.instances[0];
  const render = handlers.get('bindings-bar:render');
  assert.equal(await render(mainEvent, { chainId: 'vst-001', instanceId: 'plugin-1', html: '<p>x</p>' }), false,
    'a page that has not said it is listening would drop the markup');
  await handlers.get('bindings-bar:ready')({ sender: window.webContents });
  assert.equal(await render({ sender: window.webContents }, { chainId: 'vst-001', instanceId: 'plugin-1', html: '<p>x</p>' }), false,
    'a bar cannot draw itself');
  assert.equal(await render(mainEvent, { chainId: 'vst-001', instanceId: 'plugin-2', html: '<p>x</p>' }), false,
    'no bar, nothing drawn');
  assert.equal(await render(mainEvent, { chainId: 'vst-001', instanceId: 'plugin-1', html: 'x'.repeat(600000) }), false);
  assert.equal(await render(mainEvent, { chainId: 'vst-001', instanceId: 'plugin-1', html: '<p>x</p>' }), true);
});

test('a bar reports clicks as bounded actions, addressed by the bar that sent them', async () => {
  const context = rig();
  const window = await drawnBar(context);
  const act = context.handlers.get('bindings-bar:action');
  assert.equal(await act({ sender: window.webContents }, { kind: 'learn', controlId: 'minilab-3:k1' }), true);
  assert.deepEqual(context.mainWindow.webContents.sent.at(-1), {
    channel: 'bindings-bar:action',
    payload: { chainId: 'vst-001', instanceId: 'plugin-1', kind: 'learn', controlId: 'minilab-3:k1' }
  });
  assert.equal(await act(context.mainEvent, { kind: 'learn', controlId: 'minilab-3:k1' }), false, 'not from a bar');
  assert.equal(await act({ sender: window.webContents }, { kind: 'learn', controlId: 'minilab-3:k1', chainId: 'vst-999' }), false,
    'a bar cannot name another node');

  assert.equal(validAction({ kind: 'open-controller' }), true);
  assert.equal(validAction({ kind: 'select', controlId: 'minilab-3:k1' }), true);
  assert.equal(validAction({ kind: 'select' }), false);
  assert.equal(validAction({ kind: 'set-binding', controlId: 'minilab-3:k1' }), false, 'the bar asks what the panel can ask, nothing more');
  assert.equal(validAction({ kind: 'clear', controlId: '../k1' }), false);
  assert.equal(validAction({ kind: 'clear', controlId: 'minilab-3:k1'.repeat(20) }), false);
});

test('a drag in the bar crosses as a bounded position, and nothing else', () => {
  assert.equal(validAction({ kind: 'turn', controlId: 'minilab-3:k1', normalizedValue: 0.5 }), true);
  assert.equal(validAction({ kind: 'turn', controlId: 'minilab-3:k1', normalizedValue: 0 }), true);
  assert.equal(validAction({ kind: 'turn', controlId: 'minilab-3:k1', normalizedValue: 1 }), true);
  assert.equal(validAction({ kind: 'turn', controlId: 'minilab-3:k1', normalizedValue: 1.2 }), false, 'past the end of the knob');
  assert.equal(validAction({ kind: 'turn', controlId: 'minilab-3:k1', normalizedValue: '0.5' }), false);
  assert.equal(validAction({ kind: 'turn', controlId: 'minilab-3:k1' }), false, 'a turn with no position');
  assert.equal(validAction({ kind: 'turn', controlId: 'minilab-3:k1', normalizedValue: 0.5, parameterId: '42' }), false,
    'a bar names a control, never the parameter behind it');
});

test('only the main renderer sends positions, bounded, to a live bar', async () => {
  const context = rig();
  const window = await drawnBar(context);
  const send = context.handlers.get('bindings-bar:values');
  const message = (values, replace = false) => ({ chainId: 'vst-001', instanceId: 'plugin-1', values, replace });

  assert.equal(await send(context.mainEvent, message({ 'minilab-3:k1': 0.25 }, true)), true);
  assert.deepEqual(window.webContents.sent.at(-1),
    { channel: 'bindings-bar:values', payload: { values: { 'minilab-3:k1': 0.25 }, replace: true } });

  assert.equal(await send({ sender: window.webContents }, message({ 'minilab-3:k1': 0.3 })), false, 'a bar cannot send itself positions');
  assert.equal(await send(context.mainEvent, { ...message({ 'minilab-3:k1': 0.3 }), instanceId: 'plugin-2' }), false, 'no such bar');
  assert.equal(validValues({ 'minilab-3:k1': Number.NaN }), false);
  assert.equal(validValues({ 'minilab-3:k1': -0.1 }), false);
  assert.equal(validValues({ '../k1': 0.5 }), false);
  assert.equal(validValues(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`minilab-3:k${i}`, 0.5]))), false);
  assert.equal(validValues({}), true, 'no bound control is a valid answer');
});

test('a renderer that reloads can ask which bars exist', async () => {
  const context = rig();
  await drawnBar(context);
  assert.deepEqual(await context.handlers.get('bindings-bar:list')(context.mainEvent), [{ chainId: 'vst-001', instanceId: 'plugin-1' }]);
  assert.deepEqual(await context.handlers.get('bindings-bar:list')({ sender: { id: -1 } }), []);
});

test('a frame reported before its editor is announced is used when the bar opens', async () => {
  // The engine shows the frame -- and reports where -- before it sends the
  // `editorStatus` that creates the bar.
  const context = rig();
  context.bars.onEngineEvent(frame({ x: 50 }));
  context.bars.onEngineEvent(opened());
  const window = FakeWindow.instances[0];
  assert.equal(window.bounds.x, 50, 'placed as it is created, not at the next move');
  await context.handlers.get('bindings-bar:ready')({ sender: window.webContents });
  await context.handlers.get('bindings-bar:render')(context.mainEvent, { chainId: 'vst-001', instanceId: 'plugin-1', html: '<p>x</p>' });
  assert.equal(window.visible, true);
  assert.equal(window.bounds.x, 50);
});
