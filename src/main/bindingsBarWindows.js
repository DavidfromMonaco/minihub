'use strict';

/**
 * The bindings bar: one frameless window docked under each open plugin editor.
 * DECISIONS D-021, plans/active/bindings-bar-docked.md.
 *
 * WHY MAIN OWNS THE PLACING, AND THE RENDERER OWNS NOTHING BUT THE DRAWING
 * -----------------------------------------------------------------------
 * The plugin editor is a Win32 frame in the engine process, so nothing in
 * Chromium can draw inside it; the bar is a second window that has to move with
 * the first as one piece. Every engine event already passes through this
 * process on its way to the renderer, so the bar is placed here, from the event
 * itself, without a round trip through a renderer that may be busy drawing the
 * Patch Bay.
 *
 * What the bar SHOWS is the Learn panel `renderControlBindings()` already draws,
 * and the state that panel reads -- the bindings, the armed Learn, the cables --
 * lives in the main window's renderer and nowhere else. So that renderer renders
 * the markup and this process carries it to the bar, and a click in the bar comes
 * back as a typed action. The bar page holds no binding rule at all: a second
 * copy of those rules is what D-018's refactor would have to find and pay twice.
 */

const CHAIN_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const INSTANCE_ID = /^plugin-[1-9][0-9]*$/;
// `<profileId>:<controlId>`, each a profile identifier (midi/controllerProfile.js).
const CONTROL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS = new Set(['select', 'learn', 'cancel', 'clear', 'open-controller', 'turn']);
const MAX_HTML_LENGTH = 512 * 1024;
// A keyboard has dozens of controls, not hundreds; the bound ones are fewer.
const MAX_VALUES = 256;

/**
 * The bar's height in DIPs, and the reason it is not taller.
 *
 * Measured on the author's screen, 1920 x 1080 at 100 %: Splice INSTRUMENT's
 * frame is about 893 px tall, which leaves 187 px under it when the window sits
 * at the top of the screen. The faceplate drawn at its designed width, scaled by
 * .82 in `base.css`, is 160 px tall; 182 is that plus the bar's padding. Taller,
 * and the bar covers the bottom of the plugin even with the plugin at the top.
 */
const BAR_HEIGHT = 182;

const validId = (value, pattern, maxLength) => typeof value === 'string'
  && value.length > 0 && value.length <= maxLength && pattern.test(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const keyOf = (chainId, instanceId) => `${chainId}/${instanceId}`;

/**
 * Where the bar goes, in DIPs.
 *
 * Under the frame, as wide as the frame. When the screen ends first, the bar
 * stops at the bottom of the work area and rides over the bottom of the plugin
 * rather than leaving the screen: a bar you cannot see is a Learn you cannot
 * arm. It never climbs over the caption, though -- that is what the person
 * drags the pair back up by.
 *
 * Only the height is held on screen. Dragged half off the left edge, the plugin
 * takes its bar with it, the way one window would.
 */
function placeBar(frame, clientTop, workArea, height = BAR_HEIGHT) {
  const under = frame.y + frame.height;
  const lowest = workArea.y + workArea.height - height;
  const y = Math.max(Math.min(under, lowest), clientTop);
  return {
    x: Math.round(frame.x),
    y: Math.round(y),
    width: Math.max(1, Math.round(frame.width)),
    height
  };
}

const normalized = (value) => finite(value) && value >= 0 && value <= 1;

function validAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  if (!ACTIONS.has(action.kind)) return false;
  const keys = Object.keys(action);
  if (action.kind === 'open-controller') return keys.length === 1;
  // A control dragged with the mouse: where it now stands, as the keyboard
  // would send it.
  if (action.kind === 'turn') {
    return keys.length === 3 && validId(action.controlId, CONTROL_ID, 129) && normalized(action.normalizedValue);
  }
  return keys.length === 2 && validId(action.controlId, CONTROL_ID, 129);
}

/** `{ controlId: normalized value }`, bounded: what a bar's controls read. */
function validValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  const entries = Object.entries(values);
  return entries.length <= MAX_VALUES
    && entries.every(([controlId, value]) => validId(controlId, CONTROL_ID, 129) && normalized(value));
}

class BindingsBarWindows {
  constructor({ BrowserWindow, ipcMain, screen, mainWindow, preloadPath, htmlPath, log = () => {} }) {
    Object.assign(this, { BrowserWindow, ipcMain, screen, mainWindow, preloadPath, htmlPath, log });
    this.bars = new Map();
    // The last frame report per editor, bar or no bar: the engine says where a
    // frame is while it opens, before the `editorStatus` that creates the bar.
    this.frames = new Map();
    this.bound = false;
    this.warnedStacking = false;
  }

  setMainWindow(window) { this.mainWindow = window; }

  /** The editors that have a bar right now, as `{ chainId, instanceId }`. */
  openBars() {
    return [...this.bars.values()]
      .filter((bar) => this._isLive(bar))
      .map(({ chainId, instanceId }) => ({ chainId, instanceId }));
  }

  _isLive(bar) {
    return !!bar && !bar.window.isDestroyed()
      && (typeof bar.contents.isDestroyed !== 'function' || !bar.contents.isDestroyed());
  }

  _mainContents() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;
    const contents = this.mainWindow.webContents;
    return contents && (typeof contents.isDestroyed !== 'function' || !contents.isDestroyed()) ? contents : null;
  }

  _isMainSender(event) {
    const contents = this._mainContents();
    return !!contents && event?.sender?.id === contents.id;
  }

  _barForSender(event) {
    for (const bar of this.bars.values()) {
      if (this._isLive(bar) && bar.contents.id === event?.sender?.id) return bar;
    }
    return null;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    // The bar page is loaded and listening: ask the main renderer to draw it.
    this.ipcMain.handle('bindings-bar:ready', (event) => {
      const bar = this._barForSender(event);
      if (!bar) return false;
      bar.ready = true;
      this._want(bar);
      return true;
    });
    this.ipcMain.handle('bindings-bar:action', (event, action) => {
      const bar = this._barForSender(event);
      const contents = this._mainContents();
      if (!bar || !contents || !validAction(action)) return false;
      contents.send('bindings-bar:action', { chainId: bar.chainId, instanceId: bar.instanceId, ...action });
      return true;
    });
    this.ipcMain.handle('bindings-bar:render', (event, message) => {
      if (!this._isMainSender(event) || !message || typeof message !== 'object') return false;
      const { chainId, instanceId, html } = message;
      if (!validId(chainId, CHAIN_ID, 128) || !validId(instanceId, INSTANCE_ID, 64)
          || typeof html !== 'string' || html.length > MAX_HTML_LENGTH) return false;
      const bar = this.bars.get(keyOf(chainId, instanceId));
      if (!this._isLive(bar) || !bar.ready) return false;
      bar.contents.send('bindings-bar:render', html);
      bar.rendered = true;
      this._reveal(bar);
      return true;
    });
    // Where the bound parameters stand. Its own channel, apart from the markup:
    // it runs at the rate a knob turns, and a redraw at that rate would replace
    // the control under a dragging mouse.
    this.ipcMain.handle('bindings-bar:values', (event, message) => {
      if (!this._isMainSender(event) || !message || typeof message !== 'object') return false;
      const { chainId, instanceId, values, replace } = message;
      if (!validId(chainId, CHAIN_ID, 128) || !validId(instanceId, INSTANCE_ID, 64) || !validValues(values)) return false;
      const bar = this.bars.get(keyOf(chainId, instanceId));
      if (!this._isLive(bar) || !bar.ready) return false;
      bar.contents.send('bindings-bar:values', { values, replace: replace === true });
      return true;
    });
    // A renderer that reloaded, or started after an editor opened, asks which
    // bars exist instead of waiting for an `editorStatus` it will never see.
    this.ipcMain.handle('bindings-bar:list', (event) => (this._isMainSender(event) ? this.openBars() : []));
  }

  _want(bar) {
    this._mainContents()?.send('bindings-bar:wanted', { chainId: bar.chainId, instanceId: bar.instanceId });
  }

  /** Every engine event, before the renderer sees it. */
  onEngineEvent(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'editorStatus') {
      if (!validId(msg.chainId, CHAIN_ID, 128) || !validId(msg.instanceId, INSTANCE_ID, 64)) return;
      if (msg.open === true) this._open(msg.chainId, msg.instanceId, msg.generation);
      else this._close(keyOf(msg.chainId, msg.instanceId), 'editor-closed');
      return;
    }
    if (msg.type === 'editorBounds') {
      if (!validId(msg.chainId, CHAIN_ID, 128) || !validId(msg.instanceId, INSTANCE_ID, 64)) return;
      if (![msg.x, msg.y, msg.width, msg.height].every(finite)) return;
      const key = keyOf(msg.chainId, msg.instanceId);
      const frame = {
        x: msg.x, y: msg.y, width: msg.width, height: msg.height,
        clientY: finite(msg.clientY) ? msg.clientY : msg.y,
        minimized: msg.minimized === true,
        windowHandle: Number.isSafeInteger(msg.windowHandle) && msg.windowHandle > 0 ? msg.windowHandle : 0
      };
      this.frames.set(key, frame);
      const bar = this.bars.get(key);
      if (!bar) return;
      if (msg.raised === true) bar.raise = true;
      this._place(bar);
      return;
    }
    // A plugin replaced or rebuilt under an open editor destroys that editor
    // without a WM_CLOSE, so no `editorStatus` says it is gone. The generation
    // does.
    if (msg.type === 'instanceStatus') {
      const bar = this.bars.get(keyOf(msg.chainId, msg.instanceId));
      if (bar && (msg.status !== 'ready' || msg.generation !== bar.generation)) this._close(bar.key, 'instance-replaced');
      return;
    }
    if (msg.type === 'chainChanged') {
      const instances = Array.isArray(msg.instances) ? msg.instances : [];
      for (const bar of [...this.bars.values()]) {
        if (bar.chainId !== msg.chainId) continue;
        const live = instances.find((instance) => instance?.instanceId === bar.instanceId);
        if (!live || live.generation !== bar.generation) this._close(bar.key, 'instance-replaced');
      }
    }
  }

  /** The engine stopped or failed: every editor it drew is gone with it. */
  onEngineState(state) {
    if (state !== 'running') this.closeAll(`engine-${state}`);
  }

  _open(chainId, instanceId, generation) {
    const key = keyOf(chainId, instanceId);
    const existing = this.bars.get(key);
    if (this._isLive(existing) && existing.generation === generation) {
      existing.raise = true;
      this._place(existing);
      return;
    }
    if (existing) this._close(key, 'instance-replaced');
    const window = new this.BrowserWindow({
      width: 640,
      height: BAR_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // A click in the bar never takes the keyboard from the plugin window: the
      // person arms Learn here and turns a knob there, and a frame that flicked
      // to inactive between the two would read as two windows, not one.
      focusable: false,
      hasShadow: false,
      backgroundColor: '#1f2226',
      title: 'MiniHub Bindings',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    const bar = {
      key, chainId, instanceId, generation, window, contents: window.webContents,
      ready: false, rendered: false, shown: false, raise: true
    };
    this.bars.set(key, bar);
    window.on('closed', () => {
      if (this.bars.get(key) === bar) this.bars.delete(key);
    });
    bar.contents.on?.('render-process-gone', (_event, details) => {
      this.log(`renderer-gone bar=${key} reason=${details?.reason || 'unknown'}`);
      this._close(key, 'bar-renderer-gone');
    });
    bar.contents.on?.('console-message', (details) => {
      this.log(`console bar=${key} level=${details?.level ?? 'info'} message=${String(details?.message ?? '').slice(0, 4096)}`);
    });
    Promise.resolve(window.loadFile(this.htmlPath)).catch((error) => {
      this.log(`load-rejected bar=${key} error=${error?.message || error}`);
      this._close(key, 'bar-load-failed');
    });
    // Placed now, from the report the frame sent while it was being shown, so
    // that the first time the bar appears it appears where it belongs.
    this._place(bar);
  }

  _close(key, reason) {
    const bar = this.bars.get(key);
    if (!bar) return false;
    this.bars.delete(key);
    if (reason === 'editor-closed') this.frames.delete(key);
    if (!bar.window.isDestroyed()) bar.window.close();
    return true;
  }

  closeAll(reason = 'closed') {
    for (const key of [...this.bars.keys()]) this._close(key, reason);
    this.frames.clear();
  }

  _place(bar) {
    if (!this._isLive(bar)) return;
    const frame = this.frames.get(bar.key);
    if (!frame) return;
    if (frame.minimized || frame.width <= 0 || frame.height <= 0) {
      if (bar.shown) {
        bar.window.hide();
        bar.shown = false;
      }
      return;
    }
    const screen = this.screen;
    const physical = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    // The engine reports physical pixels (see `PhysicalCoordinates` in
    // plugin_host.cpp); a window is placed in DIPs. At 100 % they are the same
    // numbers, which is exactly why a missed conversion would pass every test
    // on the author's screen and misplace the bar on a laptop at 150 %.
    const dip = typeof screen?.screenToDipRect === 'function' ? screen.screenToDipRect(null, physical) : physical;
    const clientTop = typeof screen?.screenToDipPoint === 'function'
      ? screen.screenToDipPoint({ x: frame.x, y: frame.clientY }).y
      : frame.clientY;
    const workArea = screen?.getDisplayMatching?.(dip)?.workArea
      ?? { x: dip.x, y: dip.y, width: dip.width, height: Number.MAX_SAFE_INTEGER };
    bar.window.setBounds(placeBar(dip, clientTop, workArea));
    this._reveal(bar);
  }

  _reveal(bar) {
    if (!this._isLive(bar) || !bar.rendered) return;
    const frame = this.frames.get(bar.key);
    if (!frame || frame.minimized || frame.width <= 0) return;
    if (!bar.shown) {
      bar.window.showInactive();
      bar.shown = true;
      bar.raise = true;
    }
    if (!bar.raise || !frame.windowHandle) return;
    bar.raise = false;
    // Directly above the plugin frame, not above everything: a window the
    // person put over the plugin stays over its bar too (D-040).
    try {
      bar.window.moveAbove(`window:${frame.windowHandle}:0`);
    } catch (error) {
      if (!this.warnedStacking) this.log(`stacking-refused bar=${bar.key} error=${error?.message || error}`);
      this.warnedStacking = true;
    }
  }
}

module.exports = { BindingsBarWindows, placeBar, validAction, validValues, BAR_HEIGHT };
