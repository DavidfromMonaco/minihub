/**
 * The minimal DOM the renderer modules actually touch.
 *
 * This used to be copy-pasted into four test files, and the copies had already
 * drifted: `matches()` handled compound selectors (`g.node`) in one file and
 * only bare class selectors in another, so the same assertion could pass in one
 * suite and fail in the next. One shim, one set of semantics.
 *
 * It is deliberately not a DOM implementation - only the surface the modules
 * use. Anything missing should fail loudly rather than be quietly emulated.
 */

/** Every element created through the shim, in creation order. */
export const created = [];

export function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    attributes: {},
    dataset: {},
    _classSet: new Set(),
    _listeners: {},
    textContent: '',
    parentNode: null,
    style: {},
    disabled: false,
    value: ''
  };

  Object.defineProperty(el, 'classList', {
    get: () => ({
      add: (...c) => c.forEach((x) => el._classSet.add(x)),
      remove: (...c) => c.forEach((x) => el._classSet.delete(x)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (el._classSet.has(c)) el._classSet.delete(c);
          else el._classSet.add(c);
        } else if (force) el._classSet.add(c);
        else el._classSet.delete(c);
      },
      contains: (c) => el._classSet.has(c)
    })
  });

  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set: () => { el.children.length = 0; },
    configurable: true
  });

  el.setAttribute = (k, v) => {
    el.attributes[k] = String(v);
    if (k === 'id') el.id = String(v);
    if (k === 'class') el._classSet = new Set(String(v).split(/\s+/).filter(Boolean));
  };
  el.getAttribute = (k) => el.attributes[k];

  el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
  el.removeChild = (child) => {
    const i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    child.parentNode = null;
  };
  el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };

  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || new Set()).add(fn); };
  el.removeEventListener = (t, fn) => { el._listeners[t]?.delete(fn); };

  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });

  /** Supports `.class`, `tag`, and `tag.class.class`. */
  el.matches = (sel) => {
    const parts = String(sel).split('.').filter(Boolean);
    const looksLikeClassOnly = String(sel).startsWith('.');
    const tag = looksLikeClassOnly ? '' : parts[0];
    const classes = looksLikeClassOnly ? parts : parts.slice(1);
    if (tag && tag.toLowerCase() !== el.tagName.toLowerCase()) return false;
    return classes.every((c) => el._classSet.has(c));
  };

  el.closest = (sel) => {
    let cur = el;
    while (cur) {
      if (cur.matches && cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };

  /** `#id` only - the modules never query anything else on a container. */
  el.querySelector = (sel) => {
    if (!String(sel).startsWith('#')) return null;
    const id = String(sel).slice(1);
    const stack = [el];
    while (stack.length) {
      const n = stack.pop();
      if (n.id === id) return n;
      stack.push(...n.children);
    }
    return null;
  };

  created.push(el);
  return el;
}

/** Install `document` / `window` globals. Call before importing renderer modules. */
export function installDom() {
  created.length = 0;
  const docListeners = {};
  const winListeners = {};
  globalThis.document = {
    _listeners: docListeners,
    body: makeEl('body'),
    createElementNS: (ns, tag) => makeEl(tag),
    createElement: (tag) => makeEl(tag),
    elementFromPoint: () => null,
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || new Set()).add(fn); },
    removeEventListener: (t, fn) => { docListeners[t]?.delete(fn); }
  };
  globalThis.window = {
    _listeners: winListeners,
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || new Set()).add(fn); },
    removeEventListener: (t, fn) => { winListeners[t]?.delete(fn); }
  };
}

/** Dispatch a synthetic event to the listeners registered on `el`. */
export function fire(el, type, init = {}) {
  const evt = {
    target: init.target || el,
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    key: init.key,
    deltaY: init.deltaY ?? 0,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; }
  };
  const listeners = el._listeners[type];
  if (listeners) [...listeners].forEach((fn) => fn(evt));
  return evt;
}

/** Dispatch a keydown on the window (where the Patch Bay listens). */
export function fireKey(key, target, opts = {}) {
  const evt = {
    key,
    target: target || null,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    preventDefault() {}
  };
  const listeners = globalThis.window._listeners['keydown'];
  if (listeners) [...listeners].forEach((fn) => fn(evt));
  return evt;
}

/** Depth-first search for the first descendant carrying a class. */
export function findClass(root, cls) {
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.pop();
    if (n._classSet.has(cls)) return n;
    stack.push(...n.children);
  }
  return null;
}

/** The most recently created element carrying a class (e.g. a context menu). */
export function lastCreatedWithClass(cls) {
  for (let i = created.length - 1; i >= 0; i -= 1) {
    if (created[i]._classSet.has(cls)) return created[i];
  }
  return null;
}
