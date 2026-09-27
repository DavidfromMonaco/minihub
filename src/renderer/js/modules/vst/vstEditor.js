import { registerNodeEditor } from '../../core/nodeEditors.js';
import { escapeHtml } from '../../core/html.js';
import { getVstRole, groupPluginsByFamily } from '../../core/vstChain.js';
import { copyOneRingToNode, isOneRingPlugin } from '../../core/oneRingImport.js';
import { bindPluginMenu, closePluginMenu } from '../../ui/pluginMenu.js';
import { icon } from '../../ui/icons.js';
import { pearlKeycap, pearlLegend } from '../../ui/omniPearl.js';

/**
 * The VST node's page: its plugin chain, the plugin picker and the scan.
 *
 * It wears the faceplate, as One Ring does (the author, 2026-09-27): the chain
 * is a rack, one unit per plugin in the order the signal crosses them, each
 * with the LED its engine status lights and its keys.
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
    state.notes = new Map(); // plugin instance id -> last editor feedback line
    for (const plugin of instance.content?.plugins || []) {
      const status = hub.engine.getInstanceStatus(instance.id, plugin.id);
      if (status) state.statuses.set(plugin.id, status);
      // A plugin that failed before the page opened says why, as one that
      // fails while it is open does.
      if (status === 'error') {
        state.notes.set(plugin.id, hub.engine.getInstanceError(instance.id, plugin.id) || 'Plugin failed to load');
      }
    }
    state.scan = { error: '' };
  }
  return state;
}

/** What a unit's LED and legend say, from what the engine said last. */
const STATUS_LOOK = {
  ready: { led: 'is-on', legend: 'on' },
  loading: { led: 'is-busy', legend: '' },
  error: { led: 'is-error', legend: 'error' },
  bypassed: { led: '', legend: '' },
  pending: { led: '', legend: '' }
};

/**
 * A rack unit shows RUNTIME state, not the persisted model.
 *
 * `status` is what the native engine last reported for this instance. When the
 * engine has never mentioned it there is no live plugin behind the unit, and
 * saying "ready" was an outright lie: it made "Open Plugin" look available
 * during the whole startup window and produced "Unknown instance" when clicked.
 */
function renderPluginCard(plugin, index, status, editorNote) {
  const role = getVstRole(plugin.role);
  const st = plugin.bypassed ? 'bypassed' : (status || 'pending');
  const look = STATUS_LOOK[st] || STATUS_LOOK.pending;
  const note = editorNote ? `<span class="op-rack-note">${escapeHtml(editorNote)}</span>` : '';
  const key = (label, action, extra = {}) => pearlKeycap({ label, size: 'sm word', attrs: `data-action="${action}"`, ...extra });
  const oneRing = isOneRingPlugin(plugin)
    ? key('Copy to One Ring', 'one-ring', { title: "Copy its sequence into a new One Ring node, and move this node's CTRL OUT cables there" })
    : '';
  return `
    <div class="op-rack-unit plugin-card role-${role.id}${plugin.bypassed ? ' is-bypassed' : ''}" data-plugin-id="${escapeHtml(plugin.id)}">
      <span class="op-rack-slot">${String(index + 1).padStart(2, '0')}</span>
      <span class="op-led ${look.led}" aria-hidden="true"></span>
      <span class="op-rack-name">
        <span class="op-rack-title">${escapeHtml(plugin.name)}</span>
        <span class="op-rack-meta">${pearlLegend(role.label)}<span class="plugin-status status-${st}">${pearlLegend(st, { state: look.legend })}</span>${note}</span>
      </span>
      <span class="op-rack-keys">
        ${key('Open', 'open', { title: 'Open native plugin editor' })}
        ${key('Bypass', 'bypass', {
          state: plugin.bypassed ? 'lit' : '', pressed: plugin.bypassed === true,
          title: plugin.bypassed ? 'Bypassed: click to hear it again' : 'Let the signal through this plugin untouched'
        })}
        ${key('↑', 'up', { title: 'Move up' })}
        ${key('↓', 'down', { title: 'Move down' })}
        ${key('Remove', 'remove')}
        ${oneRing}
      </span>
    </div>`;
}

function renderChain(plugins, statuses, notes) {
  if (!plugins || plugins.length === 0) {
    return `<div class="op-rack-empty">${pearlLegend('No plugins loaded')}</div>`;
  }
  return plugins
    .map((p, index) => renderPluginCard(p, index, statuses.get(p.id), notes.get(p.id)))
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
    ? pearlLegend('Scanning VST3 folders… this takes a minute', { state: 'on' })
    : (scan.error ? `<span class="op-legend is-error">${escapeHtml(scan.error)}</span>` : '');
  const scanButton = (label, state = '') => pearlKeycap({
    label: scanning ? 'Scanning…' : label, size: 'word', state: scanning ? 'pending' : state, disabled: scanning,
    title: 'Scan the VST3 folders again', attrs: 'id="vst-scan"'
  });
  if (plugins.length === 0) {
    return `
      <div class="op-rack-add">
        ${scanButton('Scan for VST3', 'lit')}
        ${scanning ? scanNote : pearlLegend('No VST3 plugins discovered yet')}
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
    <div class="op-rack-add">
      <span class="op-select op-select--wide op-rack-pick">
        <select id="vst-pick" class="op-select-native plugin-pick" aria-label="Plugin to add" aria-haspopup="menu">
          ${optionsHtml}
        </select>
        <span class="op-select-chevron"></span>
      </span>
      ${pearlKeycap({ label: '+ Add VST', size: 'word', state: 'lit', attrs: 'id="vst-add"' })}
      <span class="op-spacer"></span>
      <span class="op-legend" id="vst-catalog-count">${plugins.length} plugin${plugins.length === 1 ? '' : 's'}</span>
      ${scanButton('Rescan')}
    </div>
    ${scanNote ? `<div class="op-rack-add op-rack-add--note">${scanNote}</div>` : ''}`;
}

/** The engine's state, as a lit LED and its legend. */
function engineStatus(hub) {
  const down = engineDown(hub);
  return `<span class="op-led ${down ? 'is-error' : 'is-on'}"></span>${pearlLegend(down ? 'Engine unavailable' : 'Engine ready', { state: down ? 'error' : '' })}`;
}

function render(context) {
  const { instance, type, hub } = context;
  const view = viewOf(context);
  const plugins = Array.isArray(instance.content?.plugins) ? instance.content.plugins : [];
  return `<div class="omni-pearl op-module op-rack" data-vst-editor>
    <div class="op-module-header"><span class="op-module-glyph">${icon(type?.icon || 'chip', 22)}</span>
      <h1 class="op-module-title">${escapeHtml(instance.name)}</h1><span class="op-spacer"></span>
      <span id="vst-engine-status" class="op-rack-engine">${engineStatus(hub)}</span>
      <button type="button" id="node-delete" class="op-btn op-btn--danger">Delete Node</button></div>
    <section class="op-panel" aria-label="Plugin chain">
      <div class="op-panel-head"><span class="op-label accent">Plugin chain</span><span class="op-hint">In the order the signal crosses them, top to bottom</span></div>
      <div id="vst-chain" class="op-rack-units">${renderChain(plugins, view.statuses, view.notes)}</div>
      <div id="vst-add-section" class="op-rack-foot">${renderAddVst(hub, view.scan)}</div>
    </section>
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
      const status = container.querySelector('#vst-engine-status');
      if (status) status.innerHTML = engineStatus(hub);
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
    // A key's label or LED may be what was clicked.
    const action = (e.target.closest?.('[data-action]') || e.target).dataset.action;
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
