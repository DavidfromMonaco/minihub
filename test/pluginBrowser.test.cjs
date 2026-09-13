'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PluginBrowser, withWebViewDebugging, renderOutline, visiblePoint, sameWindow, readArguments
} = require('../src/main/pluginBrowser');

/**
 * Contract: an agent acts in the web page a plugin shows in its own window, and
 * in no other page. DECISIONS D-041.
 *
 * Most of what is held here is refusal and aim. Refusal, because a page reached
 * when its window is closed is work the person cannot watch, and a page reached
 * through a port nobody vouched for is a page outside MiniHub. Aim, because a
 * click that lands a few pixels off, or on the wrong one of two identical
 * windows, does something -- just not what was asked -- and nothing reports it.
 */

// ---- a fake engine, a fake DevTools endpoint, a fake socket ---------------------

const PAGE = (port, id = 'page-1', extra = {}) => ({
  id, type: 'page', title: 'INSTRUMENT', url: 'https://instrument.local.splice.com/discover',
  webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`, ...extra
});

function rig({
  engineAnswer = { found: true, open: true, browsers: [{ processId: 42, x: 65, y: 88, width: 1320, height: 880, ports: [9333] }] },
  lists = { 9333: [PAGE(9333)] },
  protocol = {}
} = {}) {
  const calls = [];
  const opened = [];
  const fetched = [];
  const written = [];
  const queries = [];
  const replies = {
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { clientWidth: 1320, clientHeight: 880, pageX: 0, pageY: 0 } }),
    'Page.getNavigationHistory': () => ({ currentIndex: 0, entries: [{ url: 'https://instrument.local.splice.com/discover', title: 'INSTRUMENT' }] }),
    'DOM.scrollIntoViewIfNeeded': () => ({}),
    'DOM.getContentQuads': () => ({ quads: [[100, 200, 180, 200, 180, 240, 100, 240]] }),
    'Input.dispatchMouseEvent': () => ({}),
    'Input.dispatchKeyEvent': () => ({}),
    'Input.insertText': () => ({}),
    'DOM.focus': () => ({}),
    'Page.captureScreenshot': () => ({ data: Buffer.from('png-bytes').toString('base64') }),
    'Accessibility.getFullAXTree': () => ({ nodes: [] }),
    ...protocol
  };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      opened.push(url);
      setImmediate(() => this._emit('open', {}));
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    _emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
    send(text) {
      const { id, method, params } = JSON.parse(text);
      calls.push({ url: this.url, method, params });
      const reply = replies[method];
      setImmediate(() => {
        let payload;
        try {
          payload = reply ? { id, result: reply(params, this.url) } : { id, error: { message: `unknown ${method}` } };
        } catch (error) {
          payload = { id, error: { message: error.message } };
        }
        this._emit('message', { data: JSON.stringify(payload) });
      });
    }
    close() {}
  }

  const browser = new PluginBrowser({
    queryEngine: async (msg, replyType) => { queries.push({ msg, replyType }); return engineAnswer; },
    fetch: async (url) => {
      fetched.push(url);
      const port = Number(new URL(url).port);
      return { ok: true, json: async () => lists[port] || [] };
    },
    WebSocket: FakeSocket,
    fs: {
      statSync: (folder) => ({ isDirectory: () => folder === 'C:\\shots' }),
      writeFileSync: (filePath, data) => written.push({ filePath, data: Buffer.from(data).toString() })
    },
    timeoutMs: 500,
    discoveryTimeoutMs: 200
  });
  return { browser, calls, opened, fetched, written, queries };
}

const PLUGIN = { nodeId: 'vst-004', pluginInstanceId: 'plugin-2' };

// ---- the environment the engine starts with -------------------------------------

test('the debugging port is appended to what a plugin asks for, never put in its place', () => {
  assert.equal(withWebViewDebugging({}).WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, '--remote-debugging-port=0');
  const env = withWebViewDebugging({ PATH: 'x', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--lang=fr' });
  assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, '--lang=fr --remote-debugging-port=0');
  assert.equal(env.PATH, 'x', 'the rest of the environment is carried unchanged');
  const chosen = withWebViewDebugging({ WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' });
  assert.equal(chosen.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, '--remote-debugging-port=9222',
    'a port someone already chose is kept: the engine discovers ports, it does not assume one');
});

// ---- refusal ----------------------------------------------------------------------

test('a closed plugin window is refused before any page is looked for', async () => {
  const context = rig({ engineAnswer: { found: true, open: false, browsers: [] } });
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'read' });
  assert.equal(answer.reason, 'editor-not-open');
  assert.deepEqual(context.fetched, [], 'no port was knocked on for a window the person cannot see');
  assert.deepEqual(context.queries[0].msg, { type: 'getEditorBrowsers', chainId: 'vst-004', instanceId: 'plugin-2' });
  assert.equal(context.queries[0].replyType, 'editorBrowsers');
});

test('a plugin that draws its own interface says so rather than failing vaguely', async () => {
  const context = rig({ engineAnswer: { found: true, open: true, browsers: [] } });
  assert.equal((await context.browser.handle({ ...PLUGIN, operation: 'read' })).reason, 'no-web-page');
});

test('a page opened before agents could reach it is named as such', async () => {
  const context = rig({ engineAnswer: { found: true, open: true, browsers: [{ processId: 42, ports: [] }] } });
  assert.equal((await context.browser.handle({ ...PLUGIN, operation: 'read' })).reason, 'web-page-unreachable');
});

test('a silent engine and an unknown plugin are two different answers', async () => {
  assert.equal((await rig({ engineAnswer: null }).browser.handle({ ...PLUGIN, operation: 'read' })).reason,
    'engine-unavailable');
  assert.equal((await rig({ engineAnswer: { found: false, open: false } }).browser.handle({ ...PLUGIN, operation: 'read' })).reason,
    'plugin-not-found');
});

test('a page listed on another host or port is never connected to', async () => {
  const context = rig({
    lists: { 9333: [PAGE(9333, 'far', { webSocketDebuggerUrl: 'ws://203.0.113.9:9333/devtools/page/far' }),
      PAGE(9333, 'side', { webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/side' })] }
  });
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'read' });
  assert.equal(answer.reason, 'no-web-page');
  assert.deepEqual(context.opened, [], 'the list is believed only about pages on the port it came from');
});

test('an operation outside the vocabulary, or a malformed plugin, is refused up front', async () => {
  const context = rig();
  assert.equal((await context.browser.handle({ ...PLUGIN, operation: 'evaluate' })).reason, 'unsupported-operation');
  assert.equal((await context.browser.handle({ nodeId: 'vst-004', pluginInstanceId: '../x', operation: 'read' })).reason,
    'invalid-request');
  assert.deepEqual(context.queries, []);
});

test('arguments are checked before the engine is asked anything', () => {
  const fs = { statSync: (folder) => ({ isDirectory: () => folder === 'C:\\shots' }) };
  assert.equal(readArguments('click', {}, fs).reason, 'invalid-request', 'a click needs somewhere to land');
  assert.equal(readArguments('click', { ref: -3 }, fs).reason, 'invalid-request');
  assert.equal(readArguments('click', { x: 10 }, fs).reason, 'invalid-request', 'a point needs both coordinates');
  assert.equal(readArguments('type', { ref: 5 }, fs).reason, 'invalid-request', 'typing needs text');
  assert.equal(readArguments('press', { key: 'F13' }, fs).reason, 'invalid-request');
  assert.equal(readArguments('scroll', {}, fs).reason, 'invalid-request');
  assert.equal(readArguments('screenshot', { filePath: 'shot.png' }, fs).reason, 'invalid-request', 'relative paths are refused');
  assert.equal(readArguments('screenshot', { filePath: 'C:\\shots\\shot.jpg' }, fs).reason, 'invalid-request', 'only a PNG is written');
  assert.equal(readArguments('screenshot', { filePath: 'C:\\missing\\shot.png' }, fs).reason, 'no-folder');
  assert.equal(readArguments('scroll', { deltaY: 1e9 }, fs).args.deltaY, 5000, 'a scroll is bounded');
});

// ---- reading ---------------------------------------------------------------------

test('the outline lifts wrappers away, keeps what can be pointed at, and does not repeat a label', () => {
  const nodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'INSTRUMENT' }, childIds: ['2'], backendDOMNodeId: 1 },
    { nodeId: '2', parentId: '1', role: { value: 'generic' }, childIds: ['3', '6', '8', '10'], backendDOMNodeId: 2 },
    { nodeId: '3', parentId: '2', role: { value: 'button' }, name: { value: 'Log in' }, childIds: ['4'], backendDOMNodeId: 76,
      properties: [{ name: 'focused', value: { value: true } }] },
    { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: 'Log in' }, childIds: ['5'], backendDOMNodeId: 77 },
    { nodeId: '5', parentId: '4', role: { value: 'InlineTextBox' }, name: { value: 'Log in' }, backendDOMNodeId: 77 },
    { nodeId: '6', parentId: '2', ignored: true, role: { value: 'none' }, childIds: ['7'], backendDOMNodeId: 80 },
    { nodeId: '7', parentId: '6', role: { value: 'StaticText' }, name: { value: '  Choir \n pack ' }, backendDOMNodeId: 81 },
    { nodeId: '8', parentId: '2', role: { value: 'textbox' }, name: { value: 'Search' }, value: { value: 'ahh' },
      childIds: ['9'], backendDOMNodeId: 90 },
    { nodeId: '9', parentId: '8', role: { value: 'StaticText' }, name: { value: 'ahh' }, backendDOMNodeId: 91 },
    { nodeId: '10', parentId: '2', role: { value: 'checkbox' }, name: { value: 'Free "only"' }, backendDOMNodeId: 95,
      properties: [{ name: 'checked', value: { value: 'mixed' } }, { name: 'disabled', value: { value: true } }] }
  ];
  const { outline, truncated } = renderOutline(nodes);
  assert.equal(truncated, false);
  assert.equal(outline, [
    '- button "Log in" (focused) [ref=76]',
    '- text "Choir pack" [ref=81]',
    '- textbox "Search" value="ahh" [ref=90]',
    '- checkbox "Free \\"only\\"" (disabled, checked=mixed) [ref=95]'
  ].join('\n'));
});

test('a long page is cut and says so, rather than being sent whole', () => {
  const nodes = [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: [] }];
  for (let index = 0; index < 400; index += 1) {
    nodes[0].childIds.push(String(index + 2));
    nodes.push({ nodeId: String(index + 2), parentId: '1', role: { value: 'link' }, name: { value: `Pack number ${index}` }, backendDOMNodeId: index + 10 });
  }
  const { outline, truncated } = renderOutline(nodes, 1000);
  assert.equal(truncated, true);
  assert.ok(outline.length <= 1000);
});

test('read answers the page as an outline, with where it is and how big it is', async () => {
  const context = rig({
    protocol: {
      'Accessibility.getFullAXTree': () => ({ nodes: [
        { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
        { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Download' }, backendDOMNodeId: 12 }
      ] })
    }
  });
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'read' });
  assert.equal(answer.ok, true);
  assert.equal(answer.outline, '- button "Download" [ref=12]');
  assert.equal(answer.url, 'https://instrument.local.splice.com/discover');
  assert.deepEqual(answer.viewport, { width: 1320, height: 880 });
  assert.ok(!context.calls.some((call) => call.method === 'Runtime.evaluate'), 'reading a page runs no script in it');
});

// ---- acting ----------------------------------------------------------------------

test('a click lands on the middle of what shows of the element, as a real press and release', async () => {
  const context = rig();
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'click', ref: 12 });
  assert.deepEqual({ ok: answer.ok, x: answer.x, y: answer.y }, { ok: true, x: 140, y: 220 });
  const mouse = context.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params);
  assert.deepEqual(mouse.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(mouse.every((event) => event.x === 140 && event.y === 220));
  assert.equal(mouse[1].button, 'left');
  assert.equal(context.calls[0].method, 'DOM.scrollIntoViewIfNeeded', 'the element is brought into view first');
});

test('an element that left the page is reported stale, not clicked somewhere else', async () => {
  const context = rig({ protocol: { 'DOM.scrollIntoViewIfNeeded': () => { throw new Error('No node with given id found'); } } });
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'click', ref: 12 });
  assert.equal(answer.reason, 'stale-ref');
  assert.ok(!context.calls.some((call) => call.method === 'Input.dispatchMouseEvent'));
});

test('a point off the visible page is refused as not visible', () => {
  assert.equal(visiblePoint([[2000, 10, 2100, 10, 2100, 50, 2000, 50]], { width: 1320, height: 880 }), null);
  assert.deepEqual(visiblePoint([[1300, 0, 1400, 0, 1400, 40, 1300, 40]], { width: 1320, height: 880 }), { x: 1310, y: 20 },
    'half an element on screen is clicked on the half that shows');
});

test('typing focuses the field, can replace what is there, and inserts the text', async () => {
  const context = rig();
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'type', ref: 90, text: 'Choir', replace: true });
  assert.equal(answer.ok, true);
  const methods = context.calls.map((call) => call.method);
  assert.deepEqual(methods, ['DOM.focus', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
  assert.deepEqual(context.calls[1].params.commands, ['selectAll']);
  assert.equal(context.calls[3].params.text, 'Choir');
});

test('Enter is pressed as a key that produces a carriage return', async () => {
  const context = rig();
  await context.browser.handle({ ...PLUGIN, operation: 'press', key: 'Enter' });
  const keys = context.calls.filter((call) => call.method === 'Input.dispatchKeyEvent').map((call) => call.params);
  assert.deepEqual(keys.map((key) => key.type), ['keyDown', 'keyUp']);
  assert.equal(keys[0].text, '\r');
  assert.equal(keys[0].windowsVirtualKeyCode, 13);
});

test('a screenshot is written where asked, in CSS pixels so its points are clickable', async () => {
  const context = rig();
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'screenshot', filePath: 'C:\\shots\\page.png' });
  assert.equal(answer.ok, true);
  assert.deepEqual(context.written, [{ filePath: 'C:\\shots\\page.png', data: 'png-bytes' }]);
  const capture = context.calls.find((call) => call.method === 'Page.captureScreenshot').params;
  assert.equal(capture.clip.scale, 1);
  assert.deepEqual([capture.clip.width, capture.clip.height], [1320, 880]);
});

// ---- two pages behind one browser -------------------------------------------------

test('two pages served by one browser are told apart by where they are drawn', async () => {
  const context = rig({
    lists: { 9333: [PAGE(9333, 'other'), PAGE(9333, 'mine')] },
    protocol: {
      'Runtime.evaluate': (_params, url) => ({ result: { value: JSON.stringify(url.endsWith('/mine')
        ? [65, 88, 1320, 880, 1] : [700, 300, 1320, 880, 1]) } })
    }
  });
  const answer = await context.browser.handle({ ...PLUGIN, operation: 'hover', ref: 12 });
  assert.equal(answer.ok, true);
  const acted = context.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  assert.ok(acted.length > 0 && acted.every((call) => call.url.endsWith('/mine')),
    'only the page drawn inside this editor received the pointer');
});

test('two pages drawn in the same place are not guessed between', async () => {
  const context = rig({
    lists: { 9333: [PAGE(9333, 'a'), PAGE(9333, 'b')] },
    protocol: { 'Runtime.evaluate': () => ({ result: { value: JSON.stringify([65, 88, 1320, 880, 1]) } }) }
  });
  assert.equal((await context.browser.handle({ ...PLUGIN, operation: 'read' })).reason, 'ambiguous-page');
});

test('a window on a scaled screen matches its page through the device ratio', () => {
  const rect = { x: 98, y: 132, width: 1980, height: 1320 };
  assert.equal(sameWindow(rect, [65.3, 88, 1320, 880, 1.5]), true);
  assert.equal(sameWindow(rect, [65, 88, 1320, 880, 1]), false);
});
