import { registerNodeEditor } from '../../core/nodeEditors.js';
import { escapeHtml } from '../../core/html.js';
import { getVstRole, groupPluginsByFamily } from '../../core/vstChain.js';
import { copyOneRingToNode, isOneRingPlugin } from '../../core/oneRingImport.js';
import { bindPluginMenu, closePluginMenu } from '../../ui/pluginMenu.js';

/**
 * The VST node's page: its plugin chain, the plugin picker and the scan.
 *
 * WHAT THE PAGE REMEMBERS WHILE IT IS OPEN
 * ----------------------------------------
 * Two things the model does not hold, kept in `context.state` for one mount:
 * what the engine last said of each plugin (loading, ready, error) and the last
 * line its native editor sent back. Both are seeded from the engine, not
 * started blank: opening this page a second time must show what is actually
 * loaded, not "pending" for everything because the events fired while it was
 * closed.
 */

const engineDown = (hub) => hub.engine.state === 'error' || hub.engine.state === 'stopped';

/** The page's own memory for this mount, created on first use. */
function viewOf({ instance, hub, state }) {
  if (!state.statuses) {
    state.statuses = new Map(); // plugin instance id -> loading|ready|error
    for (const plugin of instance.content?.plugins || []) {
      const status = hub.engine.getInstanceStatus(instance.id, plugin.id);
      if (status) state.statuses.set(plugin.id, status);
    }
    state.notes = new Map(); // plugin instance id -> last editor feedback line
    state.scan = { error: '' };
  }
  return state;
}

/**
 * A plugin card shows RUNTIME state, not the persisted model.
 *
 * `status` is what the native engine last reported for this instance. When the
 * engine has never mentioned it there is no live plugin behind the card, and
 * saying "ready" was an outright lie: it made "Open Plugin" look available
 * during the whole startup window and produced "Unknown instance" when clicked.
 */
function renderPluginCard(plugin, status, editorNote) {
  const role = getVstRole(plugin.role);
  const st = plugin.bypassed ? 'bypassed' : (status || 'pending');
  const note = editorNote ? `<span class="plugin-editor-note">${escapeHtml(editorNote)}</span>` : '';
  return `
    <div class="plugin-card role-${role.id}" data-plugin-id="${escapeHtml(plugin.id)}">
      <span class="plugin-role-dot"></span>
      <span class="plugin-name">${escapeHtml(plugin.name)}</span>
      <span class="plugin-role-badge">${role.badge}</span>
      <span class="plugin-status status-${st}">${st}</span>
      ${note}
      <span class="plugin-actions">
        <button class="btn btn-sm plugin-action" data-action="open" title="Open native plugin editor">Open Plugin</button>
        <button class="btn btn-sm plugin-action" data-action="bypass">${plugin.bypassed ? 'Unbypass' : 'Bypass'}</button>
        <button class="btn btn-sm plugin-action" data-action="up" title="Move up">↑</button>
        <button class="btn btn-sm plugin-action" data-action="down" title="Move down">↓</button>
        <button class="btn btn-sm plugin-action" data-action="remove">Remove</button>
        ${isOneRingPlugin(plugin) ? '<button class="btn btn-sm plugin-action" data-action="one-ring" title="Copy its sequence into a new One Ring node, and move this node\'s CTRL OUT cables there">Copy to One Ring node</button>' : ''}
      </span>
    </div>`;
}

function renderChain(plugins, statuses, notes) {
  if (!plugins || plugins.length === 0) {
    return `<div class="empty-state"><p class="muted m-0">No plugins loaded</p></div>`;
  }
  return plugins
    .map((p) => renderPluginCard(p, statuses.get(p.id), notes.get(p.id)))
    .join('');
}

/**
 * Plugin picker + catalog controls.
 *
 * A VST3 scan spawns one child process per plugin and takes a minute or more,
 * and the engine reports nothing at all until it finishes. The scan state is
 * therefore part of this view: without it the button looked broken, and the
 * only visible outcome of clicking it again was a silent "scan already
 * running" error from the engine.
 */
function renderAddVst(hub, scan = {}, picked = '') {
  const plugins = hub.engine.plugins;
  const scanning = hub.engine.scanning === true;
  const scanNote = scanning
    ? '<span class="muted ml-6">Scanning VST3 folders… this takes a minute.</span>'
    : (scan.error ? `<span class="danger-text ml-6">${escapeHtml(scan.error)}</span>` : '');
  const scanButton = (label, extraClass = '') =>
    `<button id="vst-scan" class="btn btn-sm ${extraClass}" ${scanning ? 'disabled' : ''} title="Scan the VST3 folders again">${scanning ? 'Scanning…' : label}</button>`;
  if (plugins.length === 0) {
    return `
      <div class="row mt-10">
        ${scanButton('Scan for VST3', 'primary')}
        ${scanning ? scanNote : '<span class="muted ml-6">No VST3 plugins discovered yet</span>'}
      </div>`;
  }
  const groups = groupPluginsByFamily(plugins);
  const optionsHtml = groups
    .map((g) => `
      <optgroup label="${escapeHtml(g.label)}">
        ${g.plugins
          .map((p) => `<option value="${escapeHtml(p.pluginId)}"${p.pluginId === picked ? ' selected' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.manufacturer || '?')}</option>`)
          .join('')}
      </optgroup>`)
    .join('');
  // The rescan control stays available once plugins are known: it used to be
  // rendered only in the empty state, so a catalog that had gone stale or
  // incomplete could never be refreshed from the UI.
  return `
    <div class="row mt-10">
      <select id="vst-pick" class="select select-sm plugin-pick" aria-haspopup="menu">
        ${optionsHtml}
      </select>
      <button id="vst-add" class="btn btn-sm primary">+ Add VST</button>
      <span class="spacer"></span>
      <span class="muted" id="vst-catalog-count">${plugins.length} plugin${plugins.length === 1 ? '' : 's'}</span>
      ${scanButton('Rescan')}
    </div>
    ${scanNote ? `<div class="row mt-6">${scanNote}</div>` : ''}`;
}

function render(context) {
  const { instance, hub } = context;
  const view = viewOf(context);
  const plugins = Array.isArray(instance.content?.plugins) ? instance.content.plugins : [];
  const down = engineDown(hub);
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${escapeHtml(instance.name)}</h1>
        <span class="spacer"></span>
        <span class="pill accent-vst family-plugin">VST</span>
        <span id="vst-engine-status" class="pill ${down ? 'off' : 'ok'}">${down ? 'Engine unavailable' : 'Engine ready'}</span>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Plugin Chain</h2>
        <div id="vst-chain">${renderChain(plugins, view.statuses, view.notes)}</div>
        <div id="vst-add-section">${renderAddVst(hub)}</div>
      </div>
      <div class="row mt-16">
        <span class="spacer"></span>
        <button id="node-delete" class="btn danger">Delete Node</button>
      </div>
    </div>`;
}

function rerenderChain(container, context) {
  const view = viewOf(context);
  const chainEl = container.querySelector('#vst-chain');
  if (chainEl) chainEl.innerHTML = renderChain(context.instance.content.plugins, view.statuses, view.notes);
}

/** An undo or a redo moved the chain: the cards follow, the picker is left alone. */
function refresh(container, context) {
  rerenderChain(container, context);
}

function bind(container, context) {
  const { instance, hub, manager } = context;
  const { statuses, notes, scan } = viewOf(context);
  const chainChanged = () => rerenderChain(container, context);

  hub.diagnostics.log(`vst: mount ${instance.id} plugins=${hub.engine.plugins.length} engine=${hub.engine.state}`);

  // The list the picker opens describes the catalogue it was opened on,
  // so a redraw closes it; the plugin picked survives the redraw.
  function rerenderAddSection() {
    closePluginMenu();
    const addEl = container.querySelector('#vst-add-section');
    const picked = container.querySelector('#vst-pick')?.value || '';
    if (addEl) addEl.innerHTML = renderAddVst(hub, scan, picked);
  }

  const offs = [
    // Live engine status for this chain.
    hub.events.on('engine:instanceStatus', (msg) => {
      if (msg.chainId !== instance.id) return;
      statuses.set(msg.instanceId, msg.status);
      if (msg.status === 'error') notes.set(msg.instanceId, msg.error || 'Plugin failed to load');
      chainChanged();
    }),
    hub.events.on('engine:chainChanged', (msg) => {
      if (msg.chainId !== instance.id) return;
      for (const inst of msg.instances || []) statuses.set(inst.instanceId, inst.status);
      chainChanged();
    }),
    // Native editor feedback. Without this the user got no signal at
    // all from "Open Plugin" — a failure and a success looked the same.
    hub.events.on('engine:editorStatus', (msg) => {
      if (msg.chainId !== instance.id) return;
      if (msg.open) {
        notes.set(msg.instanceId, `editor open ${msg.width || '?'}x${msg.height || '?'}`);
      } else {
        notes.set(msg.instanceId, msg.message ? `editor: ${msg.message}` : 'editor closed');
      }
      chainChanged();
    }),
    hub.events.on('engine:plugins', () => {
      hub.diagnostics.log(`vst: plugins event -> re-render add section (${hub.engine.plugins.length} plugins)`);
      scan.error = '';
      rerenderAddSection();
    }),
    // A scan says nothing for a minute; the button has to show that.
    hub.events.on('engine:scanning', (scanning) => {
      if (scanning) scan.error = '';
      rerenderAddSection();
    }),
    hub.events.on('engine:error', (msg) => {
      if (!String(msg?.code || '').startsWith('scan')) return;
      scan.error = msg.message || msg.code;
      rerenderAddSection();
    }),
    hub.events.on('engine:state', () => {
      const pill = container.querySelector('#vst-engine-status');
      if (!pill) return;
      const down = engineDown(hub);
      pill.textContent = down ? 'Engine unavailable' : 'Engine ready';
      pill.className = 'pill ' + (down ? 'off' : 'ok');
    })
  ];

  const onClick = (e) => {
    if (e.target.closest('#vst-scan')) {
      scan.error = '';
      hub.engine.scanVst3(true); // explicit: this result may also shrink the catalog
      rerenderAddSection();
      return;
    }
    if (e.target.closest('#vst-add')) {
      const pick = container.querySelector('#vst-pick');
      if (!pick || !pick.value) return;
      const added = manager.appendPlugin(instance.id, pick.value);
      if (!added) return;
      statuses.set(added.id, 'loading');
      chainChanged();
      return;
    }

    const card = e.target.closest('.plugin-card');
    if (!card) return;
    const id = card.dataset.pluginId;
    const action = e.target.dataset.action;
    const chain = manager.getChain(instance.id);
    if (!chain) return;
    const idx = chain.plugins.findIndex((x) => x.id === id);
    if (idx === -1) return;

    if (action === 'open') {
      const status = hub.engine.getInstanceStatus(instance.id, id);
      if (status !== 'ready') {
        // No runtime instance yet (engine still starting, plugin still
        // loading, or it failed). Say so instead of firing a command
        // that can only come back as "Unknown instance".
        notes.set(id, status === 'error'
          ? (hub.engine.getInstanceError(instance.id, id) || 'plugin failed to load')
          : 'still loading — try again in a moment');
        chainChanged();
        return;
      }
      notes.set(id, 'opening editor…');
      chainChanged();
      hub.engine.openEditor(instance.id, id);
    } else if (action === 'bypass') {
      const newBypass = !chain.plugins[idx].bypassed;
      manager.setPluginBypass(instance.id, id, newBypass);
      statuses.set(id, newBypass ? 'bypassed' : 'ready');
      chainChanged();
    } else if (action === 'remove') {
      manager.removePlugin(instance.id, id);
      statuses.delete(id);
      notes.delete(id);
      chainChanged();
    } else if (action === 'up') {
      if (idx > 0 && manager.movePlugin(instance.id, id, idx - 1)) chainChanged();
    } else if (action === 'down') {
      if (idx < chain.plugins.length - 1 && manager.movePlugin(instance.id, id, idx + 1)) chainChanged();
    } else if (action === 'one-ring') {
      notes.set(id, 'copying its sequence…');
      chainChanged();
      copyOneRingToNode(hub, instance.id, id).then((result) => {
        const moved = result.moved ? `, ${result.moved} cable${result.moved === 1 ? '' : 's'} moved` : '';
        notes.set(id, result.ok
          ? `copied to ${hub.nodes.get(result.nodeId)?.name || 'a One Ring node'}${moved}`
          : `not copied: ${result.message || result.reason}`);
        if (container.isConnected !== false) chainChanged();
      });
    }
  };

  container.addEventListener('click', onClick);
  const unbindMenu = bindPluginMenu(container, { plugins: () => hub.engine.plugins });

  return () => {
    container.removeEventListener('click', onClick);
    unbindMenu();
    for (const off of offs) off();
  };
}

/** Install the page. Returns its unregister function, as `registerNodeEditor` does. */
export function registerVstEditor() {
  return registerNodeEditor('vst', { render, bind, refresh });
}
