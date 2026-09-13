'use strict';

const path = require('path');

/**
 * An agent's hands inside the web page a plugin shows in its own window.
 * DECISIONS D-041.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some plugins draw their whole interface as a web page: Splice INSTRUMENT's
 * library, where a sound is found, downloaded and loaded, is one. None of that
 * is a VST3 parameter, so the rest of the vocabulary cannot reach it, and the
 * only way left was a person clicking while an agent read screenshots.
 *
 * HOW A PAGE IS REACHED
 * ---------------------
 * Those pages run in WebView2, which is Chromium. While the agent channel is on,
 * Electron starts the engine with `--remote-debugging-port=0` appended to
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so every browser a plugin opens
 * listens on a loopback port of its own choosing. The engine walks the windows
 * of ONE plugin editor, finds the browser process drawing inside it and the
 * ports that process listens on (`getEditorBrowsers`); this file then speaks the
 * Chrome DevTools Protocol to that page and nothing else. A page that is not
 * inside a MiniHub window is never looked for, so it cannot be reached.
 *
 * WHAT IT REFUSES TO BE
 * ---------------------
 * - Not a script runner. An agent reads the page and acts on it the way a person
 *   does -- click, type, press a key, scroll, look -- and never sends code into
 *   it. The two expressions evaluated below are this file's own.
 * - Not invisible. A closed editor is refused (`editor-not-open`): the person
 *   watches what is done in their plugin's window, or it is not done.
 * - Not a navigator. There is no "go to this URL": the plugin decides where its
 *   page goes, and an address typed by an agent would be a browser inside
 *   MiniHub pointed at whatever it chose.
 */

const OPERATIONS = new Set(['read', 'click', 'hover', 'type', 'press', 'scroll', 'screenshot']);
const CHAIN_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const INSTANCE_ID = /^plugin-[1-9][0-9]{0,15}$/;
const DEBUGGING_ARGUMENT = '--remote-debugging-port=0';
const MAX_TEXT_CHARS = 4096;
const MAX_NAME_CHARS = 200;
const MAX_OUTLINE_CHARS = 60000;
const MAX_COORDINATE = 20000;
const MAX_SCROLL = 5000;

/** Keys a person presses in a web page that are not text. */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }
};

/**
 * Wrappers that carry no meaning of their own. Their children are kept and
 * lifted to their level, so a card reads as its text and buttons rather than as
 * the eleven `div`s a framework nests them in.
 */
const TRANSPARENT_ROLES = new Set(['generic', 'none', 'presentation', 'GenericContainer', 'LineBreak']);

const failed = (reason, message) => (message ? { ok: false, reason, message } : { ok: false, reason });

function browserError(reason, message) {
  const error = new Error(message || reason);
  error.reason = reason;
  return error;
}

/**
 * The engine's environment when the agent channel is on.
 *
 * Appended, never replaced: WebView2 adds this variable to the arguments a
 * plugin passes itself (Analog Lab V passes `--disable-auto-update`), and a
 * port someone already chose is kept because the engine discovers ports rather
 * than assuming one.
 */
function withWebViewDebugging(env = {}) {
  const current = String(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS || '').trim();
  if (/--remote-debugging-port=/.test(current)) return { ...env };
  return {
    ...env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: current ? `${current} ${DEBUGGING_ARGUMENT}` : DEBUGGING_ARGUMENT
  };
}

const oneLine = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const quoted = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function property(node, name) {
  const entry = (node.properties || []).find((candidate) => candidate.name === name);
  return entry ? entry.value?.value : undefined;
}

/**
 * The accessibility tree, as an indented outline an agent can read and point at.
 *
 * Every line that can be acted on ends in `[ref=N]`, the node's backend DOM id,
 * which `click`, `hover`, `type` and `scroll` accept back. A text line gets one
 * too: a card whose only handle is its title is clicked through that title,
 * because the click lands on the element the text sits in.
 */
function renderOutline(nodes, limit = MAX_OUTLINE_CHARS) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.nodeId, node]));
  const root = [...byId.values()].find((node) => !node.parentId) || null;
  const lines = [];
  let size = 0;
  let truncated = false;

  const emit = (line) => {
    if (size + line.length + 1 > limit) {
      truncated = true;
      return false;
    }
    lines.push(line);
    size += line.length + 1;
    return true;
  };

  // `said` is what the nearest line above already says -- its name and its
  // value -- so a button's own label, or a field's own text, is not repeated
  // as a line of text underneath it.
  const visit = (node, depth, said) => {
    if (!node || truncated) return;
    const role = String(node.role?.value || '');
    if (role === 'InlineTextBox') return;
    const children = () => {
      for (const childId of node.childIds || []) visit(byId.get(childId), depth, said);
    };
    const name = oneLine(node.name?.value, MAX_NAME_CHARS);
    if (node === root || node.ignored || (TRANSPARENT_ROLES.has(role) && !name)) {
      children();
      return;
    }
    const ref = Number.isSafeInteger(node.backendDOMNodeId) ? ` [ref=${node.backendDOMNodeId}]` : '';
    const indent = '  '.repeat(depth);
    if (role === 'StaticText') {
      if (name && !said.includes(name)) emit(`${indent}- text ${quoted(name)}${ref}`);
      return;
    }
    const states = [];
    for (const flag of ['disabled', 'focused', 'selected', 'expanded', 'checked', 'pressed']) {
      const value = property(node, flag);
      if (value === true || value === 'true') states.push(flag);
      else if (value === 'mixed') states.push(`${flag}=mixed`);
      else if (flag === 'expanded' && (value === false || value === 'false')) states.push('collapsed');
    }
    const value = oneLine(node.value?.value, MAX_NAME_CHARS);
    const valueText = value ? ` value=${quoted(value)}` : '';
    const stateText = states.length ? ` (${states.join(', ')})` : '';
    if (!emit(`${indent}- ${role}${name ? ` ${quoted(name)}` : ''}${valueText}${stateText}${ref}`)) return;
    const saying = [name, value].filter(Boolean);
    for (const childId of node.childIds || []) visit(byId.get(childId), depth + 1, saying.length ? saying : said);
  };

  if (root) visit(root, 0, []);
  return { outline: lines.join('\n'), truncated };
}

/** The first quad's bounding box, cut to the viewport; null when nothing of it shows. */
function visiblePoint(quads, viewport) {
  const quad = Array.isArray(quads) ? quads.find((entry) => Array.isArray(entry) && entry.length >= 8) : null;
  if (!quad) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  // A viewport that reported no size is not a reason to refuse every click.
  const width = viewport?.width > 0 ? viewport.width : Infinity;
  const height = viewport?.height > 0 ? viewport.height : Infinity;
  const left = Math.max(Math.min(...xs), 0);
  const top = Math.max(Math.min(...ys), 0);
  const right = Math.min(Math.max(...xs), width);
  const bottom = Math.min(Math.max(...ys), height);
  if (!(right > left && bottom > top)) return null;
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

/** Whether a page drawn at `geometry` (CSS pixels) is the window at `rect` (screen pixels). */
function sameWindow(rect, geometry) {
  if (!rect || !Array.isArray(geometry) || geometry.length < 5 || !geometry.every(finite)) return false;
  const [x, y, width, height, ratio] = geometry;
  const close = (a, b) => Math.abs(a - b) <= 4;
  // Screen pixels are CSS pixels times the device ratio in a DPI-aware engine
  // and equal to them in one that is not; either reading is the same window.
  return [ratio, 1].some((scale) => close(rect.x, x * scale) && close(rect.y, y * scale)
    && close(rect.width, width * scale) && close(rect.height, height * scale));
}

function classifyProtocolError(message) {
  if (/no node|not found|could not find|detached|does not belong/i.test(message)) return 'stale-ref';
  if (/not focusable/i.test(message)) return 'not-focusable';
  return 'browser-refused';
}

/** One connection to one page, spoken in the DevTools protocol. */
class DevToolsSession {
  constructor(socket, timeoutMs) {
    Object.assign(this, { socket, timeoutMs, seq: 0, pending: new Map() });
  }

  static open(WebSocketImpl, url, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = new WebSocketImpl(url);
      } catch (error) {
        reject(browserError('web-page-unreachable', String(error?.message || error)));
        return;
      }
      const session = new DevToolsSession(socket, timeoutMs);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        session.close();
        reject(browserError('browser-timeout', 'the page did not accept a connection in time'));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(session);
      });
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(browserError('web-page-unreachable', 'the page refused the connection'));
          return;
        }
        session._rejectAll(browserError('web-page-closed', 'the connection to the page failed'));
      });
      socket.addEventListener('close', () => session._rejectAll(browserError('web-page-closed', 'the page went away')));
      socket.addEventListener('message', (event) => session._onMessage(event.data));
    });
  }

  call(method, params = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(browserError('browser-timeout', `the page did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(browserError('web-page-closed', String(error?.message || error)));
      }
    });
  }

  _onMessage(data) {
    let message = null;
    try { message = JSON.parse(String(data)); } catch { return; }
    const pending = message && typeof message.id === 'number' ? this.pending.get(message.id) : null;
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const text = String(message.error.message || 'refused');
      pending.reject(browserError(classifyProtocolError(text), text));
    } else {
      pending.resolve(message.result || {});
    }
  }

  _rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
    this._rejectAll(browserError('web-page-closed', 'the connection was closed'));
  }
}

/**
 * Check a request's own fields before anything is asked of the engine.
 *
 * Returns the arguments in the form the operations use, or a refusal. Main
 * checks these again after the renderer did because this is the process that
 * writes files and opens sockets, and it takes nothing on trust from IPC.
 */
function readArguments(operation, request, fs) {
  const args = {};
  const ref = request.ref;
  const hasRef = ref !== undefined && ref !== null;
  if (hasRef && !(Number.isSafeInteger(ref) && ref > 0)) return failed('invalid-request', 'ref is a number read from the outline');
  if (hasRef) args.ref = ref;
  const hasPoint = request.x !== undefined || request.y !== undefined;
  if (hasPoint) {
    if (![request.x, request.y].every((value) => finite(value) && value >= 0 && value <= MAX_COORDINATE)) {
      return failed('invalid-request', 'x and y are page coordinates in CSS pixels, as in a screenshot');
    }
    args.point = { x: request.x, y: request.y };
  }

  if (operation === 'click' || operation === 'hover') {
    if (!hasRef && !hasPoint) return failed('invalid-request', `${operation} needs a ref or x and y`);
    if (operation === 'click') {
      if (request.count !== undefined && request.count !== 1 && request.count !== 2) {
        return failed('invalid-request', 'count is 1 or 2');
      }
      args.count = request.count === 2 ? 2 : 1;
    }
  }
  if (operation === 'type') {
    if (typeof request.text !== 'string' || request.text.length > MAX_TEXT_CHARS) {
      return failed('invalid-request', `type needs text, at most ${MAX_TEXT_CHARS} characters`);
    }
    args.text = request.text;
    args.replace = request.replace === true;
  }
  if (operation === 'press') {
    if (!Object.prototype.hasOwnProperty.call(KEYS, request.key)) {
      return failed('invalid-request', `key is one of ${Object.keys(KEYS).join(', ')}`);
    }
    args.key = KEYS[request.key];
  }
  if (operation === 'scroll') {
    const deltaX = request.deltaX === undefined ? 0 : request.deltaX;
    const deltaY = request.deltaY === undefined ? 0 : request.deltaY;
    if (!finite(deltaX) || !finite(deltaY) || (deltaX === 0 && deltaY === 0)) {
      return failed('invalid-request', 'scroll needs deltaY or deltaX, in pixels');
    }
    args.deltaX = Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, deltaX));
    args.deltaY = Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, deltaY));
  }
  if (operation === 'screenshot') {
    const filePath = typeof request.filePath === 'string' ? request.filePath : '';
    if (!filePath || filePath.length > 1024 || !path.isAbsolute(filePath) || !/\.png$/i.test(filePath)) {
      return failed('invalid-request', 'screenshot needs an absolute filePath ending in .png');
    }
    try {
      if (!fs.statSync(path.dirname(filePath)).isDirectory()) throw new Error('not a folder');
    } catch {
      return failed('no-folder', `the folder ${path.dirname(filePath)} does not exist`);
    }
    args.filePath = filePath;
  }
  return { ok: true, args };
}

class PluginBrowser {
  /**
   * @param {object} deps
   * @param {(msg: object, replyType: string) => Promise<object|null>} deps.queryEngine
   * @param {typeof fetch} deps.fetch
   * @param {typeof WebSocket} deps.WebSocket
   * @param {object} deps.fs
   */
  constructor({ queryEngine, fetch, WebSocket, fs, timeoutMs = 8000, discoveryTimeoutMs = 2000, log = () => {} }) {
    Object.assign(this, { queryEngine, fetch, WebSocket, fs, timeoutMs, discoveryTimeoutMs, log });
  }

  async handle(request = {}) {
    const operation = typeof request.operation === 'string' ? request.operation : '';
    if (!OPERATIONS.has(operation)) {
      return failed('unsupported-operation', `operation is one of ${[...OPERATIONS].join(', ')}`);
    }
    const chainId = String(request.nodeId || '');
    const instanceId = String(request.pluginInstanceId || '');
    if (!CHAIN_ID.test(chainId) || !INSTANCE_ID.test(instanceId)) return failed('invalid-request', 'nodeId and pluginInstanceId name a plugin');
    const checked = readArguments(operation, request, this.fs);
    if (!checked.ok) return checked;

    const located = await this._locate(chainId, instanceId);
    if (!located.ok) return located;
    let session = null;
    try {
      session = await DevToolsSession.open(this.WebSocket, located.target.webSocketDebuggerUrl, this.timeoutMs);
      const answer = await this[`_${operation}`](session, checked.args);
      return { ok: true, operation, ...answer };
    } catch (error) {
      if (!error?.reason) this.log(`${operation} failed: ${error?.stack || error}`);
      return failed(error?.reason || 'browser-refused', String(error?.message || error));
    } finally {
      session?.close();
    }
  }

  /** The one page shown in this editor, or the reason there is none. */
  async _locate(chainId, instanceId) {
    const answer = await this.queryEngine({ type: 'getEditorBrowsers', chainId, instanceId }, 'editorBrowsers');
    if (!answer) return failed('engine-unavailable', 'the audio engine did not answer');
    if (answer.found !== true) return failed('plugin-not-found');
    if (answer.open !== true) {
      return failed('editor-not-open', 'open the plugin window first with open-editor: the person watches what you do in it');
    }
    const windows = (Array.isArray(answer.browsers) ? answer.browsers : []).filter((entry) => entry && typeof entry === 'object');
    if (windows.length === 0) {
      return failed('no-web-page', 'this plugin draws its own interface: there is no web page in its window');
    }
    const ports = [...new Set(windows.flatMap((entry) => (Array.isArray(entry.ports) ? entry.ports : [])))]
      .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
    if (ports.length === 0) {
      return failed('web-page-unreachable', 'the page in this window was opened before agents could reach it: restart MiniHub with the agent channel on');
    }

    const candidates = [];
    for (const port of ports) {
      const targets = await this._getJson(`http://127.0.0.1:${port}/json/list`);
      for (const target of Array.isArray(targets) ? targets : []) {
        if (target?.type !== 'page' || typeof target.webSocketDebuggerUrl !== 'string') continue;
        // The list is only believed about pages on the port it came from.
        let socketUrl = null;
        try { socketUrl = new URL(target.webSocketDebuggerUrl); } catch { continue; }
        if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== '127.0.0.1' || Number(socketUrl.port) !== port) continue;
        candidates.push(target);
      }
    }
    if (candidates.length === 0) return failed('no-web-page', 'the browser in this window shows no page yet');
    if (candidates.length === 1) return { ok: true, target: candidates[0] };

    // One browser process can serve the pages of several editors. Only the
    // page drawn where THIS editor's browser window is belongs to it.
    const matches = [];
    for (const target of candidates) {
      const geometry = await this._geometry(target);
      if (windows.some((entry) => sameWindow(entry, geometry))) matches.push(target);
    }
    if (matches.length === 1) return { ok: true, target: matches[0] };
    return failed('ambiguous-page', 'several pages share this window and none can be told apart: move the plugin window and try again');
  }

  async _getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.discoveryTimeoutMs);
    try {
      const response = await this.fetch(url, { signal: controller.signal });
      return response?.ok ? await response.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async _geometry(target) {
    let session = null;
    try {
      session = await DevToolsSession.open(this.WebSocket, target.webSocketDebuggerUrl, this.discoveryTimeoutMs);
      const result = await session.call('Runtime.evaluate', {
        expression: 'JSON.stringify([screenX, screenY, innerWidth, innerHeight, devicePixelRatio])',
        returnByValue: true
      }, this.discoveryTimeoutMs);
      return JSON.parse(String(result?.result?.value || 'null'));
    } catch {
      return null;
    } finally {
      session?.close();
    }
  }

  async _viewport(session) {
    const metrics = await session.call('Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport || metrics.visualViewport || metrics.cssLayoutViewport || metrics.layoutViewport || {};
    return {
      width: Math.round(viewport.clientWidth || 0),
      height: Math.round(viewport.clientHeight || 0),
      pageX: viewport.pageX || 0,
      pageY: viewport.pageY || 0
    };
  }

  async _pointFor(session, args) {
    if (!args.ref) return args.point;
    try {
      await session.call('DOM.scrollIntoViewIfNeeded', { backendNodeId: args.ref });
    } catch (error) {
      if (error.reason === 'stale-ref') throw browserError('stale-ref', 'that ref is no longer on the page: read it again');
      // A node that cannot scroll may still be on screen; its quads say.
    }
    let quads = null;
    try {
      ({ quads } = await session.call('DOM.getContentQuads', { backendNodeId: args.ref }));
    } catch (error) {
      if (error.reason === 'stale-ref') throw browserError('stale-ref', 'that ref is no longer on the page: read it again');
      throw error;
    }
    const point = visiblePoint(quads, await this._viewport(session));
    if (!point) throw browserError('not-visible', 'that element takes no space on screen: it may be hidden or closed');
    return point;
  }

  async _mouse(session, type, point, extra = {}) {
    await session.call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, pointerType: 'mouse', ...extra });
  }

  async _read(session) {
    const [{ nodes }, viewport] = await Promise.all([
      session.call('Accessibility.getFullAXTree'),
      this._viewport(session)
    ]);
    const { outline, truncated } = renderOutline(nodes);
    const history = await session.call('Page.getNavigationHistory').catch(() => null);
    const entry = history?.entries?.[history.currentIndex] || null;
    return {
      url: entry?.url || '',
      title: entry?.title || '',
      viewport: { width: viewport.width, height: viewport.height },
      outline,
      truncated
    };
  }

  async _hover(session, args) {
    const point = await this._pointFor(session, args);
    await this._mouse(session, 'mouseMoved', point, { button: 'none' });
    return { x: point.x, y: point.y };
  }

  async _click(session, args) {
    const point = await this._pointFor(session, args);
    await this._mouse(session, 'mouseMoved', point, { button: 'none' });
    for (let clickCount = 1; clickCount <= args.count; clickCount += 1) {
      await this._mouse(session, 'mousePressed', point, { button: 'left', buttons: 1, clickCount });
      await this._mouse(session, 'mouseReleased', point, { button: 'left', buttons: 0, clickCount });
    }
    return { x: point.x, y: point.y };
  }

  async _type(session, args) {
    if (args.ref) {
      try {
        await session.call('DOM.focus', { backendNodeId: args.ref });
      } catch (error) {
        if (error.reason === 'stale-ref') throw browserError('stale-ref', 'that ref is no longer on the page: read it again');
        // Not focusable as a node: a click on it is what a person would do.
        await this._click(session, { ref: args.ref, count: 1 });
      }
    }
    if (args.replace) {
      const selectAll = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 };
      await session.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll, commands: ['selectAll'] });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll });
    }
    if (args.text) await session.call('Input.insertText', { text: args.text });
    // Replacing with nothing is clearing: the selection has to be deleted, since
    // inserting an empty string leaves it standing.
    else if (args.replace) await this._press(session, { key: KEYS.Backspace });
    return { typed: args.text.length };
  }

  async _press(session, args) {
    const { text, ...key } = args.key;
    await session.call('Input.dispatchKeyEvent', text ? { type: 'keyDown', ...key, text } : { type: 'rawKeyDown', ...key });
    await session.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    return { key: args.key.code };
  }

  async _scroll(session, args) {
    let point = args.ref || args.point ? await this._pointFor(session, args) : null;
    if (!point) {
      const viewport = await this._viewport(session);
      point = { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
    }
    await this._mouse(session, 'mouseWheel', point, { deltaX: args.deltaX, deltaY: args.deltaY });
    return { x: point.x, y: point.y };
  }

  /**
   * The page as a PNG, in CSS pixels, so a point read off the image is a point
   * `click` accepts unchanged whatever the screen's scaling.
   */
  async _screenshot(session, args) {
    const viewport = await this._viewport(session);
    if (!viewport.width || !viewport.height) throw browserError('not-visible', 'the page has no size: is the plugin window minimised?');
    const { data } = await session.call('Page.captureScreenshot', {
      format: 'png',
      clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.width, height: viewport.height, scale: 1 }
    });
    if (typeof data !== 'string' || !data) throw browserError('browser-refused', 'the page returned no image');
    this.fs.writeFileSync(args.filePath, Buffer.from(data, 'base64'));
    return { filePath: args.filePath, width: viewport.width, height: viewport.height };
  }
}

module.exports = {
  PluginBrowser, DevToolsSession, OPERATIONS, KEYS,
  withWebViewDebugging, renderOutline, visiblePoint, sameWindow, readArguments
};
