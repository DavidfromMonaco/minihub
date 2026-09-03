/**
 * The Preset node editor.
 *
 * A Preset node offers only what belongs to the plugin it is cabled to. The
 * cable is the authority for that: `resolveTarget()` reads the graph, never a
 * copy kept in the node's own content, so unplugging the cable changes what the
 * page offers with no other state to keep in step (invariant 2).
 *
 * This is the first editor to go through `core/nodeEditors.js`: it adds nothing
 * to `nodeInstances.js` and owns its listeners through `createDisposers()`.
 * That is the whole point of the seam -- a new node type is a folder plus one
 * registration, not a fifth branch inside a shared mount().
 *
 * Everything shown here comes from disk (preset names, vendors) or from a
 * plugin (its name), so every interpolation is escaped: invariant 9.
 */
import { registerNodeEditor } from '../../core/nodeEditors.js';
import { createDisposers } from '../../core/disposers.js';
import { escapeHtml } from '../../core/html.js';

/**
 * What the cable points at, derived from the graph on demand.
 *
 * Returns one of:
 *   { state: 'unconnected' }
 *   { state: 'missing-node' }        the cable names a node that is gone
 *   { state: 'empty-chain', node }   cabled, but the VST node holds no plugin
 *   { state: 'ready', node, plugins, plugin, classId, matchedBy }
 */
export function resolveTarget(hub, instance) {
  const links = hub.graph.connectionsFrom(instance.id, 'preset-out');
  if (!links || links.length === 0) return { state: 'unconnected' };

  const node = hub.graph.getNode(links[0].to.nodeId);
  if (!node) return { state: 'missing-node' };

  const target = hub.nodes?.get(node.id);
  const plugins = (target && target.content && Array.isArray(target.content.plugins))
    ? target.content.plugins
    : [];
  if (plugins.length === 0) return { state: 'empty-chain', node };

  const wanted = instance.content && instance.content.pluginInstanceId;
  const plugin = plugins.find((p) => p.id === wanted) || plugins[0];
  const catalogued = hub.engine?.getPlugin ? hub.engine.getPlugin(plugin.pluginId) : null;
  const classId = catalogued && typeof catalogued.classId === 'string' && catalogued.classId
    ? catalogued.classId.toUpperCase()
    : null;

  return {
    state: 'ready',
    node,
    plugins,
    plugin,
    classId,
    // Without a class UID the catalog predates the scan that records them, so
    // exact matching is impossible and the plugin name is the only handle left.
    matchedBy: classId ? 'class' : 'name'
  };
}

/**
 * Presets that belong to the target, from a library the main process scanned.
 *
 * With a class UID the filter is exact and done at the source. Without one it
 * falls back to the `<Plugin>` folder of the Steinberg layout, compared loosely
 * -- a hint, not an identity, which is why the page says so.
 */
export function selectPresets(library, target) {
  const presets = Array.isArray(library) ? library : [];
  if (target.matchedBy === 'class') return presets;
  const wanted = normalize(target.plugin.name);
  if (!wanted) return [];
  return presets.filter((preset) => normalize(preset.plugin) === wanted);
}

/**
 * Catalogue entries that belong to the target.
 *
 * A class id on both sides is an exact answer. When the entry has none -- a
 * GitHub listing cannot know one without opening every file -- the plugin name
 * is the only handle, and it is a hint, which is why such rows say so.
 */
export function selectOnline(entries, target) {
  const list = Array.isArray(entries) ? entries : [];
  const wanted = normalize(target && target.plugin ? target.plugin.name : '');
  return list.filter((entry) => {
    if (target.classId && entry.classId) return entry.classId === target.classId;
    return wanted.length > 0 && normalize(entry.plugin) === wanted;
  });
}

function normalize(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

function renderTarget(target) {
  if (target.state === 'unconnected') {
    return `<p class="muted m-0">Drag this node's PRESET output onto a VST node to choose its presets.</p>`;
  }
  if (target.state === 'missing-node') {
    return `<p class="muted m-0">The cabled node no longer exists.</p>`;
  }
  if (target.state === 'empty-chain') {
    return `<p class="muted m-0">${escapeHtml(target.node.name)} holds no plugin yet.</p>`;
  }

  const options = target.plugins.map((plugin) => `<option value="${escapeHtml(plugin.id)}"${
    plugin.id === target.plugin.id ? ' selected' : ''
  }>${escapeHtml(plugin.name)}</option>`).join('');
  const chooser = target.plugins.length > 1
    ? `<label>Plugin <select data-preset-plugin>${options}</select></label>`
    : `<span class="pill accent-vst">${escapeHtml(target.plugin.name)}</span>`;
  const note = target.matchedBy === 'name'
    ? `<p class="muted m-0 mt-10">No class UID in the catalog for this plugin, so presets are matched by name. Rescan VST3 for exact matching.</p>`
    : '';

  return `<div class="row">
      <span class="muted">${escapeHtml(target.node.name)}</span>
      <span class="spacer"></span>
      ${chooser}
    </div>${note}`;
}

function renderPresets(state) {
  if (state.status === 'idle') {
    return `<p class="muted m-0">Nothing to list until a plugin is cabled.</p>`;
  }
  if (state.status === 'loading') return `<p class="muted m-0">Reading the preset library...</p>`;
  if (state.status === 'error') {
    return `<p class="muted m-0">The preset library could not be read (${escapeHtml(state.reason)}).</p>`;
  }
  if (state.presets.length === 0) {
    return `<div class="empty-state"><p class="muted m-0">No preset installed for this plugin yet.</p></div>`;
  }
  return `<div class="preset-list">${state.presets.map((preset) => `
    <div class="preset-row" data-preset-path="${escapeHtml(preset.path)}">
      <span class="preset-name">${escapeHtml(preset.name)}</span>
      <span class="preset-origin">${escapeHtml(preset.vendor || preset.source)}</span>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-preset-action="apply">Apply</button>
    </div>`).join('')}</div>`;
}

function renderOnline(state) {
  if (state.status === 'idle') return `<p class="muted m-0">Nothing to list until a plugin is cabled.</p>`;
  if (state.status === 'loading') return `<p class="muted m-0">Contacting the catalogue sources...</p>`;
  if (state.status === 'no-sources') {
    return `<p class="muted m-0">No catalogue source configured. MiniHub contacts nothing on its own.</p>`;
  }
  if (state.status === 'error') {
    return `<p class="muted m-0">The catalogue could not be refreshed (${escapeHtml(state.reason)}). Showing what was remembered.</p>`;
  }
  if (state.entries.length === 0) {
    return `<div class="empty-state"><p class="muted m-0">No online preset for this plugin.</p></div>`;
  }
  return state.entries.map((entry, index) => `
    <div class="preset-row" data-preset-online="${index}">
      <span class="preset-name">${escapeHtml(entry.name)}</span>
      <span class="preset-origin">${escapeHtml(entry.source)}${
        entry.applicable ? '' : ' &middot; install only'
      }${entry.classId ? '' : ' &middot; by name'}</span>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-preset-action="download">Download</button>
    </div>`).join('');
}

function renderEditor({ instance, type }) {
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${escapeHtml(instance.name)}</h1>
        <span class="spacer"></span>
        <span class="pill accent-preset">${escapeHtml(type.label)}</span>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Target</h2>
        <div data-preset-target></div>
      </div>
      <div class="panel mt-16">
        <div class="row">
          <h2 class="panel-title m-0">Presets</h2>
          <span class="spacer"></span>
          <span class="muted" data-preset-status></span>
          <button class="btn btn-sm" data-preset-action="refresh">Refresh</button>
        </div>
        <div class="mt-10" data-preset-list></div>
      </div>
      <div class="panel mt-16">
        <div class="row">
          <h2 class="panel-title m-0">Online</h2>
          <span class="spacer"></span>
          <span class="muted" data-preset-online-status></span>
          <button class="btn btn-sm" data-preset-action="refresh-online">Refresh catalogue</button>
        </div>
        <div class="mt-10" data-preset-online-list></div>
      </div>
      <div class="row mt-16">
        <span class="spacer"></span>
        <button id="node-delete" class="btn danger">Delete Node</button>
      </div>
    </div>`;
}

function bindEditor(container, { instance, hub }) {
  const disposers = createDisposers();
  // Set by the teardown. Every asynchronous continuation checks it before
  // touching the DOM: `#content` is shared, so a library that arrives after the
  // user has navigated away would otherwise paint over another module's page
  // (invariant 8).
  let disposed = false;
  // Only the newest request of each kind may paint. Switching plugins twice
  // quickly would otherwise let the slower answer win. The two counters are
  // deliberately separate: sharing one made the library and the catalogue
  // invalidate each other's answers, and the installed list never painted.
  let listSeq = 0;
  let onlineSeq = 0;
  let listState = { status: 'idle', presets: [], reason: '' };
  let onlineState = { status: 'idle', entries: [], reason: '' };
  let onlineAll = [];

  const paint = () => {
    if (disposed) return;
    const target = resolveTarget(hub, instance);
    const targetEl = container.querySelector('[data-preset-target]');
    const listEl = container.querySelector('[data-preset-list]');
    const statusEl = container.querySelector('[data-preset-status]');
    if (targetEl) targetEl.innerHTML = renderTarget(target);
    if (listEl) listEl.innerHTML = renderPresets(listState);
    if (statusEl) {
      statusEl.textContent = listState.status === 'ready'
        ? `${listState.presets.length} preset${listState.presets.length === 1 ? '' : 's'}`
        : '';
    }
    const onlineEl = container.querySelector('[data-preset-online-list]');
    if (onlineEl) onlineEl.innerHTML = renderOnline(onlineState);
    return target;
  };

  /** Recompute which catalogue entries match, without refetching. */
  const projectOnline = (target) => {
    if (target.state !== 'ready') {
      onlineState = { status: 'idle', entries: [], reason: '' };
      return;
    }
    onlineState = { status: 'ready', entries: selectOnline(onlineAll, target), reason: '' };
  };

  /** `refresh` true goes to the network; otherwise the remembered catalogue. */
  const loadOnline = async (refresh) => {
    const target = resolveTarget(hub, instance);
    if (target.state !== 'ready') {
      onlineState = { status: 'idle', entries: [], reason: '' };
      paint();
      return;
    }
    const seq = ++onlineSeq;
    if (refresh) {
      onlineState = { status: 'loading', entries: [], reason: '' };
      paint();
    }
    let answer = null;
    try {
      answer = await hub.api.presetsCatalogue({ refresh: refresh === true });
    } catch (err) {
      answer = { ok: false, reason: 'unavailable' };
    }
    if (disposed || seq !== onlineSeq) return;

    if (!answer || !answer.ok) {
      onlineState = { status: 'error', entries: [], reason: (answer && answer.reason) || 'unavailable' };
      paint();
      return;
    }
    onlineAll = Array.isArray(answer.entries) ? answer.entries : [];
    if (refresh && answer.sources === 0) {
      onlineState = { status: 'no-sources', entries: [], reason: '' };
    } else {
      projectOnline(target);
    }
    paint();
  };

  const download = async (index) => {
    const entry = onlineState.entries[index];
    if (!entry) return;
    const statusEl = container.querySelector('[data-preset-online-status]');
    const say = (text) => { if (!disposed && statusEl) statusEl.textContent = text; };
    say('Downloading...');
    let answer = null;
    try {
      answer = await hub.api.presetsDownload(entry);
    } catch (err) {
      answer = { ok: false, reason: 'unavailable' };
    }
    if (disposed) return;
    if (!answer || !answer.ok) {
      say(`Refused (${(answer && answer.reason) || 'unavailable'})`);
      return;
    }
    say(answer.applicable ? 'Downloaded' : 'Downloaded, install only');
    // A .vstpreset that just landed belongs in the installed list.
    reload();
  };

  const reload = async () => {
    const target = resolveTarget(hub, instance);
    if (target.state !== 'ready') {
      listState = { status: 'idle', presets: [], reason: '' };
      paint();
      return;
    }
    const seq = ++listSeq;
    listState = { status: 'loading', presets: [], reason: '' };
    paint();

    let answer = null;
    try {
      answer = await hub.api.presetsLibrary(target.classId ? { classId: target.classId } : {});
    } catch (err) {
      answer = { ok: false, reason: 'unavailable' };
    }
    if (disposed || seq !== listSeq) return;

    listState = answer && answer.ok
      ? { status: 'ready', presets: selectPresets(answer.presets, target), reason: '' }
      : { status: 'error', presets: [], reason: (answer && answer.reason) || 'unavailable' };
    paint();
  };

  const applyPreset = async (path) => {
    const target = resolveTarget(hub, instance);
    if (target.state !== 'ready') return;
    const statusEl = container.querySelector('[data-preset-status]');
    const say = (text) => { if (!disposed && statusEl) statusEl.textContent = text; };
    say('Applying...');

    let read = null;
    try {
      read = await hub.api.presetsRead(path);
    } catch (err) {
      read = { ok: false, reason: 'unavailable' };
    }
    if (disposed) return;
    if (!read || !read.ok) {
      say(`Could not read the preset (${(read && read.reason) || 'unavailable'})`);
      return;
    }
    const result = await hub.engine.loadPresetChunks(
      target.node.id, target.plugin.id, target.plugin.pluginId,
      read.classId, read.component, read.controller
    );
    if (disposed) return;
    say(result && result.ok === false ? `Refused (${result.reason})` : 'Applied');
  };

  disposers.listen(container, 'click', (event) => {
    const button = event.target && event.target.closest
      ? event.target.closest('[data-preset-action]')
      : null;
    if (!button) return;
    const action = button.dataset.presetAction;
    if (action === 'refresh') {
      reload();
      return;
    }
    if (action === 'refresh-online') {
      loadOnline(true);
      return;
    }
    if (action === 'download') {
      const onlineRow = button.closest('[data-preset-online]');
      if (onlineRow) download(Number(onlineRow.dataset.presetOnline));
      return;
    }
    const row = button.closest('[data-preset-path]');
    if (row) applyPreset(row.dataset.presetPath);
  });

  disposers.listen(container, 'change', (event) => {
    const select = event.target;
    if (!select || !select.matches || !select.matches('[data-preset-plugin]')) return;
    instance.content.pluginInstanceId = select.value;
    hub.nodes.persist();
    reload();
  });

  // The cable is the authority, so the page follows the graph rather than
  // remembering what it was told.
  disposers.add(hub.events.on('graph:change', () => reload()));
  disposers.add(hub.events.on('engine:chainChanged', () => reload()));
  disposers.add(hub.events.on('engine:presetApplied', () => paint()));

  paint();
  reload();
  // The remembered catalogue only, never the network: nothing here reaches out
  // until the user presses Refresh (INTENT.md section 7).
  loadOnline(false);

  return () => {
    disposed = true;
    disposers.dispose();
  };
}

registerNodeEditor('preset', { render: renderEditor, bind: bindEditor });
