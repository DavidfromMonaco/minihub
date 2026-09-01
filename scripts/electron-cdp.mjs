import fs from 'node:fs/promises';

const [port = '9333', command = 'inspect', ...rawArgs] = process.argv.slice(2);
const targetOption = rawArgs.find((value) => value.startsWith('--target='));
const args = rawArgs.filter((value) => !value.startsWith('--target='));
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const requestedTarget = targetOption?.slice('--target='.length) || '';
const matchesTarget = (entry) => {
  if (!requestedTarget) return true;
  if (requestedTarget === 'main') return /\/index\.html(?:$|[?#])/.test(entry.url || '');
  if (requestedTarget === 'clip') return /\/clip-editor\.html(?:$|[?#])/.test(entry.url || '');
  return String(entry.title || '').includes(requestedTarget) || String(entry.url || '').includes(requestedTarget);
};
const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && matchesTarget(entry));
if (!target) throw new Error(`No Electron page target on port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

if (command !== 'dialog-accept') {
  await send('Runtime.enable');
  await send('Page.enable');
}

try {
  if (command === 'inspect') {
    const value = await evaluate(`(() => ({
      title: document.title,
      bodyText: document.body.innerText,
      buttons: [...document.querySelectorAll('button')].map((el) => ({
        text: String(el.innerText || el.textContent || '').trim(), id: el.id, className: el.className,
        action: el.dataset.action || null, moduleId: el.dataset.moduleId || null,
        title: el.title || null
      })),
      graphNodes: [...document.querySelectorAll('[data-node-id]')].map((el) => ({
        nodeId: el.dataset.nodeId, className: el.className, text: String(el.innerText || el.textContent || '').trim()
      })),
      ports: [...document.querySelectorAll('[data-port-id]')].map((el) => ({
        nodeId: el.dataset.nodeId || el.closest('[data-node-id]')?.dataset.nodeId || null,
        portId: el.dataset.portId, type: el.dataset.portType || null,
        direction: el.dataset.direction || null, text: String(el.innerText || el.textContent || '').trim(),
        ariaLabel: el.getAttribute('aria-label'), title: el.title || null
      }))
    }))()`);
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (command === 'eval-base64') {
    const expression = Buffer.from(args[0] || '', 'base64').toString('utf8');
    const value = await evaluate(expression);
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (command === 'screenshot') {
    const outputPath = args[0];
    if (!outputPath) throw new Error('screenshot requires an output path');
    const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fs.writeFile(outputPath, Buffer.from(result.data, 'base64'));
    process.stdout.write(`${outputPath}\n`);
  } else if (command === 'drag') {
    const [fromX, fromY, toX, toY] = args.map(Number);
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      throw new Error('drag requires fromX fromY toX toY');
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX, y: toY, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 });
    process.stdout.write(`${JSON.stringify({ fromX, fromY, toX, toY })}\n`);
  } else if (command === 'right-drag') {
    const [fromX, fromY, toX, toY] = args.map(Number);
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      throw new Error('right-drag requires fromX fromY toX toY');
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: fromX, y: fromY, button: 'right', buttons: 2, clickCount: 1
    });
    for (let step = 1; step <= 4; step += 1) {
      const ratio = step / 4;
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: fromX + (toX - fromX) * ratio,
        y: fromY + (toY - fromY) * ratio,
        button: 'right', buttons: 2
      });
    }
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toX, y: toY, button: 'right', buttons: 0, clickCount: 1
    });
    process.stdout.write(`${JSON.stringify({ fromX, fromY, toX, toY, button: 'right' })}\n`);
  } else if (command === 'click') {
    const [x, y, requestedCount = '1'] = args;
    const px = Number(x); const py = Number(y); const count = Number(requestedCount);
    if (![px, py, count].every(Number.isFinite) || count < 1 || count > 2) {
      throw new Error('click requires x y and an optional clickCount of 1 or 2');
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount });
    }
    process.stdout.write(`${JSON.stringify({ x: px, y: py, clickCount: count })}\n`);
  } else if (command === 'window-size') {
    const [requestedWidth, requestedHeight] = args.map(Number);
    if (![requestedWidth, requestedHeight].every(Number.isFinite)) {
      throw new Error('window-size requires width height');
    }
    const value = await evaluate(`(() => {
      window.resizeTo(${Math.round(requestedWidth)}, ${Math.round(requestedHeight)});
      return { outerWidth: window.outerWidth, outerHeight: window.outerHeight };
    })()`);
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else if (command === 'key') {
    const key = args[0];
    const definitions = {
      Delete: { code: 'Delete', virtualKeyCode: 46 },
      Backspace: { code: 'Backspace', virtualKeyCode: 8 },
      Enter: { code: 'Enter', virtualKeyCode: 13 },
      Escape: { code: 'Escape', virtualKeyCode: 27 },
      Home: { code: 'Home', virtualKeyCode: 36 },
      ArrowUp: { code: 'ArrowUp', virtualKeyCode: 38 },
      ArrowDown: { code: 'ArrowDown', virtualKeyCode: 40 }
    };
    const definition = definitions[key];
    const repeat = Math.max(1, Math.min(64, Number(args[1]) || 1));
    if (!definition) throw new Error('unsupported key');
    const params = {
      key,
      code: definition.code,
      windowsVirtualKeyCode: definition.virtualKeyCode,
      nativeVirtualKeyCode: definition.virtualKeyCode
    };
    for (let index = 0; index < repeat; index += 1) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    }
    process.stdout.write(`${JSON.stringify({ key, repeat })}\n`);
  } else if (command === 'dialog-accept') {
    await send('Page.handleJavaScriptDialog', { accept: true });
    process.stdout.write(`${JSON.stringify({ accepted: true })}\n`);
  } else if (command === 'close-target') {
    await send('Page.close');
    process.stdout.write(`${JSON.stringify({ closed: target.title, url: target.url })}\n`);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  socket.close();
  // A target can disappear before the DevTools close handshake completes.
  // Bound the CLI lifetime so closing an editor never leaves the smoke helper
  // (or a half-open debugger connection) behind.
  setTimeout(() => process.exit(0), 250);
}
