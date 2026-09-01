/**
 * Node Instance Manager.
 *
 * Manages user-created node instances (e.g. "VST 1", "Video 1"). Each instance
 * is a thin object:
 *
 *   { id, type, ordinal, name, content }
 *
 * IDENTITY vs DISPLAY NUMBER - these are deliberately two different things:
 *
 *   id       `vst-011`. Stable, unique forever, NEVER reused after a delete.
 *            Everything that must survive a reload keys off this: routing
 *            connections, layout, module registration, native engine chains.
 *   ordinal  `2`, rendered as "VST 2". Display only. A new node takes the
 *            LOWEST positive number not currently used by a live node of the
 *            same type, so deleting VST 2..10 makes the next VST "VST 2"
 *            again - while its id may well be `vst-011`.
 *
 * Existing nodes are never renumbered; only new ones fill the holes.
 * `name` is derived (`type.label + ordinal`) and is not persisted separately.
 *
 * `type` is immutable (from the Node Type Registry). For VST nodes, content is
 * the internal plugin chain `{ plugins: [] }` (see vstChain.js); other types
 * keep `content: null` for now.
 *
 * Instances are persisted under the `nodeInstances` settings key, together with
 * the per-type monotonic id sequence. They integrate with the Hub by
 * registering a module (sidebar entry + editor shell) and a routing node in
 * `hub.graph`.
 *
 * VST nodes now connect their internal plugin chain to the native engine:
 * every chain operation (add / remove / reorder / bypass) is synchronized to
 * the engine, and MIDI reaching a VST node through the graph is forwarded to
 * the engine for that chain. The Patch Bay still sees the complete VST chain as
 * ONE VST node — individual plugins never enter `hub.graph`.
 *
 * Responsibilities are kept separate: `nodeInstances` owns instances,
 * `graphLayout` owns positions, `graphConnections` owns routing.
 */
import { getNodeType, nodeDisplayName } from './nodeTypes.js';
import { GraphLayout } from './graphLayout.js';
import { VstChain, getVstRole, duplicateVstContent, groupPluginsByFamily } from './vstChain.js';
import { escapeHtml } from './html.js';
import { normalizeControlBinding, normalizeControlBindings } from './controlBindings.js';
import { MINILAB_CONTROL_SOURCES } from '../midi/minilabControls.js';
import { miniLabControlSurfaceHtml } from '../ui/miniLabControlSurface.js';
import { defaultArpeggiatorContent, normalizeArpeggiatorContent } from './arpeggiatorState.js';
import { currentArpeggiatorStep, moveCustomNote, removeCustomNote, renderArpControlStrip, renderCustomPatternEditor, setCustomGateDuration, setCustomNote, syncArpControlStrip, velocityFromPointer } from './arpeggiatorEditor.js';

/** Coalescing window for continuous native-value controls (Mixer / Morpher
 *  levels, mutes, master level, Morpher steps). Long enough to collapse a drag
 *  into a single settings write and a single native graph republish, short
 *  enough to stay imperceptible when the user simply clicks a slider. */
const NATIVE_VALUE_COALESCE_MS = 120;
import { icon } from '../ui/icons.js';

const KEY = 'nodeInstances';

function renderGenericShell(instance, type) {
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${escapeHtml(instance.name)}</h1>
        <span class="spacer"></span>
        <span class="pill accent-${type.id}">${type.label}</span>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Content</h2>
        <p class="muted m-0">${type.emptyLabel}</p>
      </div>
      <div class="row mt-16">
        <span class="spacer"></span>
        <button id="node-delete" class="btn danger">Delete Node</button>
      </div>
    </div>`;
}

function renderNativeAudioEditor(instance, type, hub) {
  const content = instance.content;
  const connections = hub.graph.connectionsTo(instance.id);
  const sourceFor = (id) => connections.find((c) => c.to.portId === id)?.from.nodeId || 'Unconnected';
  const channels = content.inputs.map((input, index) => `<div class="row mt-10" data-audio-input="${input.id}">
    <strong>${index + 1}</strong><span class="muted">${escapeHtml(sourceFor(input.id))}</span>
    <span class="spacer"></span><label>Level <input data-native-control="level" type="range" min="0" max="2" step="0.01" value="${input.level}"></label>
    <label><input data-native-control="mute" type="checkbox" ${input.muted ? 'checked' : ''}> Mute</label></div>`).join('');
  const steps = type.id === 'morpher' ? `<div class="row mt-16"><label>Steps <select data-native-control="stepCount">${[4,8,16,32].map((n)=>`<option ${content.stepCount===n?'selected':''}>${n}</option>`).join('')}</select></label></div>
    <div class="morph-steps">${content.steps.slice(0,content.stepCount).map((v,i)=>`<label data-morph-step="${i}"> ${i+1}<input data-native-step="${i}" type="range" min="0" max="1" step="0.01" value="${v}"></label>`).join('')}</div>` : '';
  return `<div class="panel"><div class="row"><h1 class="page-title">${escapeHtml(instance.name)}</h1><span class="spacer"></span><span class="pill accent-${type.id}">${type.label}</span></div>
    <div class="panel mt-16"><h2 class="panel-title">Ordered Audio Inputs</h2>${channels}${steps}${type.id==='mixer'?`<div class="row mt-16"><label>Master <input data-native-control="masterLevel" type="range" min="0" max="2" step="0.01" value="${content.masterLevel}"></label></div>`:''}</div>
    <div class="row mt-16"><span class="spacer"></span><button id="node-delete" class="btn danger">Delete Node</button></div></div>`;
}

/**
 * Arpeggiator editor - Omni Pearl skin.
 *
 * The Bay opens straight onto this: the control strip and the pattern editor
 * are both here, always. There is no intermediate "open the editor" page any
 * more - the roll is the page. Drawing in it while a preset mode is selected
 * simply edits the stored Custom pattern; the mode selector alone decides what
 * the engine plays.
 */
export function renderArpeggiatorEditor(instance, type, selectedStep=-1) {
  const c=instance.content;
  return `<div class="omni-pearl op-module" data-arp-editor>
    <div class="op-module-header"><span class="op-module-glyph">${icon(type?.icon||'sequencer',22)}</span>
      <h1 class="op-module-title">${escapeHtml(instance.name)}</h1><span class="op-spacer"></span>
      <button type="button" id="node-delete" class="op-btn op-btn--danger">Delete Node</button></div>
    ${renderArpControlStrip(c)}
    <div class="op-arp-stack" data-arp-custom-editor>${renderCustomPatternEditor(c,selectedStep)}</div>
  </div>`;
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
      </span>
    </div>`;
}

function renderChain(plugins, statusMap, editorNotes) {
  if (!plugins || plugins.length === 0) {
    return `<div class="empty-state"><p class="muted m-0">No plugins loaded</p></div>`;
  }
  return plugins
    .map((p) => renderPluginCard(p, statusMap.get(p.id), editorNotes && editorNotes.get(p.id)))
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
function renderAddVst(hub, scan = {}) {
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
          .map((p) => `<option value="${escapeHtml(p.pluginId)}">${escapeHtml(p.name)} · ${escapeHtml(p.manufacturer || '?')}</option>`)
          .join('')}
      </optgroup>`)
    .join('');
  // The rescan control stays available once plugins are known: it used to be
  // rendered only in the empty state, so a catalog that had gone stale or
  // incomplete could never be refreshed from the UI.
  return `
    <div class="row mt-10">
      <select id="vst-pick" class="select select-sm">
        ${optionsHtml}
      </select>
      <button id="vst-add" class="btn btn-sm primary">+ Add VST</button>
      <span class="spacer"></span>
      <span class="muted" id="vst-catalog-count">${plugins.length} plugin${plugins.length === 1 ? '' : 's'}</span>
      ${scanButton('Rescan')}
    </div>
    ${scanNote ? `<div class="row mt-6">${scanNote}</div>` : ''}`;
}

export function renderControlBindings(instance, hub, selectedControlId = null) {
  const pending = hub.control?.pendingLearn;
  const states = {};
  MINILAB_CONTROL_SOURCES.forEach((source) => {
    const status = hub.control?.bindingStatus(instance.id, source.id)
      || { state: 'unbound', binding: null };
    const connected = hub.control?.isConnected(instance.id, source.id) || false;
    const isPending = pending?.nodeId === instance.id && pending.sourceControlId === source.id;
    states[source.id] = !connected ? 'unavailable' : (isPending ? 'learn-armed' : (status.binding ? 'mapped' : 'unmapped'));
  });
  const selected = MINILAB_CONTROL_SOURCES.find((source) => source.id === selectedControlId) || null;
  const selectedStatus = selected ? hub.control?.bindingStatus(instance.id, selected.id) : null;
  const selectedConnected = selected ? hub.control?.isConnected(instance.id, selected.id) : false;
  const isPending = selected && pending?.nodeId === instance.id && pending.sourceControlId === selected.id;
  const binding = selectedStatus?.binding;
  const target = binding
    ? `${binding.pluginName || binding.pluginInstanceId} · ${binding.parameterName || `ParamID ${binding.parameterId}`}`
    : (selectedConnected ? 'Unmapped' : 'Connect this control to CTRL IN in Patch Bay');
  return `
    <div class="control-bindings-help muted">
      Select an observable control on the MiniLab, then Arm Learning. Native MIDI behavior remains active while MiniHub opens and foregrounds the target OmniBox.
    </div>
    ${miniLabControlSurfaceHtml({ states, selectedId: selected?.id || null })}
    <div class="control-learn-toolbar" data-selected-source-control-id="${selected?.id || ''}">
      <strong>${selected?.label || 'Select a control'}</strong>
      <span class="control-binding-target">${escapeHtml(selected ? target : 'Choose an observable physical control above')}</span>
      <span class="spacer"></span>
      <button class="btn primary" data-control-action="${isPending ? 'cancel' : 'learn'}" data-source-control-id="${selected?.id || ''}"
        ${selected && selectedConnected ? '' : 'disabled'}>${isPending ? 'Cancel Learning' : 'Arm Learning'}</button>
      <button class="btn" data-control-action="clear" data-source-control-id="${selected?.id || ''}"
        ${binding && !isPending ? '' : 'disabled'}>Clear</button>
    </div>`;
}

function renderVstEditor(instance, type, hub, statusMap, editorNotes) {
  const plugins = (instance.content && Array.isArray(instance.content.plugins)) ? instance.content.plugins : [];
  const engineDown = hub.engine.state === 'error' || hub.engine.state === 'stopped';
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${instance.name}</h1>
        <span class="spacer"></span>
        <span class="pill accent-vst">VST</span>
        <span id="vst-engine-status" class="pill ${engineDown ? 'off' : 'ok'}">${engineDown ? 'Engine unavailable' : 'Engine ready'}</span>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Plugin Chain</h2>
        <div id="vst-chain">${renderChain(plugins, statusMap, editorNotes)}</div>
        <div id="vst-add-section">${renderAddVst(hub)}</div>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Control Bindings</h2>
        <div id="vst-control-bindings">${renderControlBindings(instance, hub)}</div>
      </div>
      <div class="row mt-16">
        <span class="spacer"></span>
        <button id="node-delete" class="btn danger">Delete Node</button>
      </div>
    </div>`;
}

function buildRoutingNode(instance, hub) {
  const type = getNodeType(instance.type);
  return {
    id: instance.id,
    name: instance.name,
    type: instance.type,
    inputs: type.dynamicAudioInputs ? instance.content.inputs.map((p, i) => ({ id: p.id, type: 'audio', label: `AUDIO IN ${i + 1}` })) : ((type.ports && type.ports.inputs) || []),
    outputs: (type.ports && type.ports.outputs) || [],
    onInput: (portId, data) => {
      // The Sequencer owns musical focus. Its controller records the one
      // physical ingress and forwards live MIDI only through the stable output
      // branches selected by armed/monitored tracks. Arrangement playback is
      // still routed independently by the native per-track plan.
      if (instance.type === 'sequencer') {
        if (portId !== 'midi-in' || !data || !Array.isArray(data.raw)) return;
        hub.sequencer?.receiveMidiInput(data);
        return;
      }
      // Forward raw MIDI to the native engine for this VST chain. This only
      // fires when the MiniLab is actually connected into this node in the
      // graph (the graph only calls onInput for connected targets).
      if (instance.type === 'arpeggiator') {
        if (portId === 'midi-in' && data && Array.isArray(data.raw)) hub.engine?.midiNode(instance.id, data.raw);
        return;
      }
      if (instance.type !== 'vst') return;
      if (portId === 'ctrl-in') {
        if (hub.control) hub.control.route(instance.id, data);
        return;
      }
      if (portId !== 'midi-in') return;
      if (data && Array.isArray(data.raw) && hub.engine) {
        hub.engine.midi(instance.id, data.raw);
      }
    }
  };
}

/** Fresh default content for a node type (VST nodes own a plugin chain). */
function defaultContentFor(typeId) {
  if (typeId === 'vst') return { plugins: [], controlBindings: [] };
  if (typeId === 'mixer') return { inputs: [{ id: 'audio-in-1', level: 1, muted: false }], masterLevel: 1, nextInputSeq: 1 };
  if (typeId === 'morpher') return { inputs: [{ id: 'audio-in-1', level: 1, muted: false }], stepCount: 4, steps: Array(32).fill(0).map((_,i)=>i/31), nextInputSeq: 1 };
  if (typeId === 'arpeggiator') return defaultArpeggiatorContent();
  return null;
}

/** An independent deep copy of a node's content, for duplicate/paste. */
function cloneContentFor(typeId, content) {
  if (typeId === 'vst') return duplicateVstContent(content);
  return content ? JSON.parse(JSON.stringify(content)) : null;
}

function normalizeNativeAudioContent(typeId, value) {
  const base = defaultContentFor(typeId); const source = value && typeof value === 'object' ? value : {};
  const inputs = Array.isArray(source.inputs) ? source.inputs.filter((p)=>p&&/^audio-in-[1-9][0-9]*$/.test(p.id)).map((p)=>({ id:p.id, level:Number.isFinite(p.level)?Math.max(0,Math.min(2,p.level)):1, muted:p.muted===true })) : base.inputs;
  const maxSeq = inputs.reduce((m,p)=>Math.max(m,Number(p.id.slice(9))||0),0);
  if (!inputs.length) inputs.push({id:'audio-in-1',level:1,muted:false});
  if (typeId === 'mixer') return { inputs, masterLevel:Number.isFinite(source.masterLevel)?Math.max(0,Math.min(2,source.masterLevel)):1, nextInputSeq:Math.max(maxSeq,source.nextInputSeq||0) };
  const stepCount=[4,8,16,32].includes(source.stepCount)?source.stepCount:4;
  const steps=Array.from({length:32},(_,i)=>Number.isFinite(source.steps?.[i])?Math.max(0,Math.min(1,source.steps[i])):base.steps[i]);
  return { inputs, stepCount, steps, nextInputSeq:Math.max(maxSeq,source.nextInputSeq||0) };
}

/** Numeric suffix of a stable instance id (`vst-011` -> 11), or 0. */
function idSuffix(id) {
  const m = /-(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : 0;
}

export class NodeInstanceManager {
  constructor(hub) {
    this.hub = hub;
    this.instances = new Map(); // id -> instance
    this.layout = new GraphLayout(hub.settings);
    this._idSeq = {}; // type -> last used ID sequence number (never reused)
    this._expandingPorts = false;
    hub.events.on('graph:change', () => this._ensureDynamicAudioPorts());
  }

  _ensureDynamicAudioPorts() {
    if (this._expandingPorts) return;
    this._expandingPorts = true; let changed=false;
    for (const instance of this.instances.values()) {
      if (instance.type !== 'mixer' && instance.type !== 'morpher') continue;
      const graphNode=this.hub.graph.getNode(instance.id); if(!graphNode) continue;
      const connected=new Set(this.hub.graph.connectionsTo(instance.id).map((c)=>c.to.portId));
      if (instance.content.inputs.some((input)=>!connected.has(input.id))) continue;
      const seq=(instance.content.nextInputSeq||0)+1; instance.content.nextInputSeq=seq;
      const input={id:`audio-in-${seq}`,level:1,muted:false}; instance.content.inputs.push(input);
      graphNode.inputs.push({id:input.id,type:'audio',label:`AUDIO IN ${instance.content.inputs.length}`}); changed=true;
    }
    this._expandingPorts=false;
    if(changed){this._persist();this.hub.events.emit('graph:change',{type:'ports',connections:this.hub.graph.serialize()});}
  }

  list() {
    return [...this.instances.values()];
  }

  get(id) {
    return this.instances.get(id) || null;
  }

  /** Access the internal plugin chain of a VST instance (or null). */
  getChain(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.type !== 'vst') return null;
    return new VstChain(inst.content, () => this._persist());
  }

  /** Validated persistent CONTROL bindings owned by one VST node. */
  getControlBindings(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.type !== 'vst' || !Array.isArray(inst.content.controlBindings)) return [];
    return inst.content.controlBindings;
  }

  /** Upsert one binding by physical source identity. */
  setControlBinding(instanceId, value) {
    const inst = this.instances.get(instanceId);
    const binding = normalizeControlBinding(value);
    if (!inst || inst.type !== 'vst' || !binding) return false;
    if (!Array.isArray(inst.content.controlBindings)) inst.content.controlBindings = [];
    const index = inst.content.controlBindings
      .findIndex((item) => item.sourceControlId === binding.sourceControlId);
    if (index === -1) inst.content.controlBindings.push(binding);
    else inst.content.controlBindings[index] = binding;
    this._persist();
    return true;
  }

  clearControlBinding(instanceId, sourceControlId) {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.type !== 'vst' || !Array.isArray(inst.content.controlBindings)) return false;
    const before = inst.content.controlBindings.length;
    inst.content.controlBindings = inst.content.controlBindings
      .filter((binding) => binding.sourceControlId !== sourceControlId);
    if (inst.content.controlBindings.length === before) return false;
    this._persist();
    return true;
  }

  setPluginState(instanceId, pluginInstanceId, pluginId, state) {
    const inst=this.instances.get(instanceId);const plugin=inst?.type==='vst'&&inst.content?.plugins?.find((p)=>p.id===pluginInstanceId);
    if(!plugin||plugin.pluginId!==pluginId||typeof state!=='string')return false;
    plugin.state=state;this._persist();return true;
  }

  /** Restore persisted instances (registers modules + routing nodes). */
  async load() {
    const data = this.hub.settings.get(KEY);
    const stored = data && Array.isArray(data.instances) ? [...data.instances] : [];
    // `counts` is the pre-ordinal key name; still read so existing installs
    // keep their ID sequence and never regenerate an id that is already taken.
    const seq = (data && (data.idSeq || data.counts)) || {};
    this._idSeq = typeof seq === 'object' ? { ...seq } : {};
    let migratedArpeggiator = false;
    let migratedAudioInput = false;
    const migratedStableIds = new Map();

    // Audio Input used to be an always-present system module and therefore was
    // absent from nodeInstances even when a saved project routed or positioned
    // it. Materialise that legacy project evidence once so existing projects
    // keep their source while fresh New projects remain free of Audio Input.
    const connections = this.hub.settings.get('graphConnections');
    const layout = this.hub.settings.get('graphLayout');
    const legacyAudioInputPresent = Array.isArray(connections)
      && connections.some((connection) => connection?.from?.nodeId === 'audio-input'
        || connection?.to?.nodeId === 'audio-input');
    if (!stored.some((entry) => entry?.type === 'audio-input')
        && (legacyAudioInputPresent || Object.hasOwn(layout || {}, 'audio-input'))) {
      stored.push({ id: 'audio-input', type: 'audio-input', ordinal: 1, content: null });
      migratedAudioInput = true;
    }

    for (const entry of stored) {
      // Persisted data is not trusted: a corrupt entry must cost that one node,
      // not the whole startup.
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
      const type = getNodeType(entry.type);
      if (!type) continue;
      const instanceId = type.stableId || entry.id;
      if (instanceId !== entry.id) migratedStableIds.set(entry.id, instanceId);
      if (this.instances.has(instanceId)) continue; // duplicate id in the file
      if (type.singleton && this.list().some((instance) => instance.type === type.id)) continue;
      const content = entry.type === 'vst'
        ? {
            plugins: (entry.content && Array.isArray(entry.content.plugins)) ? entry.content.plugins : [],
            controlBindings: normalizeControlBindings(entry.content?.controlBindings),
            ...(Number.isSafeInteger(entry.content?.nextPluginInstanceSeq)
              && entry.content.nextPluginInstanceSeq >= 0
              ? { nextPluginInstanceSeq: entry.content.nextPluginInstanceSeq }
              : {})
          }
        : ((entry.type === 'mixer' || entry.type === 'morpher') ? normalizeNativeAudioContent(entry.type, entry.content) : (entry.type === 'arpeggiator' ? normalizeArpeggiatorContent(entry.content) : (entry.content ?? null)));
      if (entry.type === 'arpeggiator' && JSON.stringify(content) !== JSON.stringify(entry.content)) migratedArpeggiator = true;

      const instance = {
        id: instanceId,
        type: entry.type,
        ordinal: this._restoreOrdinal(entry, type),
        content
      };
      instance.name = nodeDisplayName(type, instance.ordinal);

      // Defensive: if the persisted sequence is missing or behind the ids
      // actually in use, a new node would collide with an existing one and
      // module registration would throw. Keep the sequence ahead of reality.
      const suffix = idSuffix(instance.id);
      if (suffix > (this._idSeq[instance.type] || 0)) this._idSeq[instance.type] = suffix;

      this.instances.set(instance.id, instance);
      this._registerModule(instance);
    }
    // Rewrite a legacy degree-based Custom pattern once, during the existing
    // startup/project-loading phase. The conversion is pitch-preserving and
    // prevents a later save from resurrecting the obsolete representation.
    if (migratedStableIds.size) {
      const migrateId = (id) => migratedStableIds.get(id) || id;
      const connections = this.hub.settings.get('graphConnections');
      if (Array.isArray(connections)) await this.hub.settings.set('graphConnections', connections.map((connection) => {
        if (!connection || typeof connection !== 'object') return connection;
        return {
          ...connection,
          from: { ...connection.from, nodeId: migrateId(connection.from?.nodeId) },
          to: { ...connection.to, nodeId: migrateId(connection.to?.nodeId) }
        };
      }));
      const layout = this.hub.settings.get('graphLayout');
      if (layout && typeof layout === 'object') {
        const migratedLayout = { ...layout };
        for (const [oldId, stableId] of migratedStableIds) {
          if (!(stableId in migratedLayout) && oldId in migratedLayout) migratedLayout[stableId] = migratedLayout[oldId];
          delete migratedLayout[oldId];
        }
        await this.hub.settings.set('graphLayout', migratedLayout);
      }
    }
    if (migratedArpeggiator || migratedAudioInput || migratedStableIds.size) await this._persist();
  }

  /**
   * Ordinal for a restored instance: the persisted one when valid, else the
   * number in its persisted name (pre-ordinal installs), else the lowest free
   * one. Duplicates are resolved so two live nodes never share a number.
   */
  _restoreOrdinal(entry, type) {
    const candidates = [];
    if (Number.isInteger(entry.ordinal) && entry.ordinal > 0) candidates.push(entry.ordinal);
    const fromName = /\s(\d+)$/.exec(String(entry.name || ''));
    if (fromName) candidates.push(Number(fromName[1]));
    const taken = this._takenOrdinals(entry.type);
    for (const n of candidates) {
      if (!taken.has(n)) return n;
    }
    return this._lowestFreeOrdinal(entry.type);
  }

  /** Display ordinals currently in use by live instances of a type. */
  _takenOrdinals(typeId) {
    const taken = new Set();
    for (const inst of this.instances.values()) {
      if (inst.type === typeId) taken.add(inst.ordinal);
    }
    return taken;
  }

  /**
   * Lowest positive display number free within a type family. This is what
   * makes "delete VST 2..10, create a VST" produce "VST 2" and not "VST 11".
   */
  _lowestFreeOrdinal(typeId) {
    const taken = this._takenOrdinals(typeId);
    let n = 1;
    while (taken.has(n)) n += 1;
    return n;
  }

  /** Next stable id for a type. Monotonic per type; never reused. */
  _nextId(typeId) {
    const n = (this._idSeq[typeId] || 0) + 1;
    this._idSeq[typeId] = n;
    return `${typeId}-${String(n).padStart(3, '0')}`;
  }

  /**
   * The single creation path. Every UI route (sidebar, Patch Bay toolbar,
   * context menu, paste, duplicate) ends up here, so naming, default content,
   * module registration, graph registration and persistence cannot drift
   * apart between them.
   */
  _add(typeId, content) {
    const type = getNodeType(typeId);
    if (!type) return null;
    // Singleton creation is deliberately a no-op. Returning null also keeps a
    // repeated Patch Bay create action from moving/reselecting the live node.
    if (type.singleton && this.list().some((instance) => instance.type === typeId)) return null;
    const instance = {
      id: type.stableId || this._nextId(typeId),
      type: typeId,
      ordinal: this._lowestFreeOrdinal(typeId),
      content
    };
    instance.name = nodeDisplayName(type, instance.ordinal);
    this.instances.set(instance.id, instance);
    this._registerModule(instance);
    this._persist();
    return instance;
  }

  /** Create a new empty instance of the given node type. */
  create(typeId) {
    if (!getNodeType(typeId)) throw new Error(`Unknown node type: ${typeId}`);
    return this._add(typeId, defaultContentFor(typeId));
  }

  /**
   * Create a new independent instance duplicating a live instance's content.
   * The copy gets a fresh ID, its own display number and a separate layout
   * entry; it starts externally disconnected (no copied graph connections).
   */
  duplicate(sourceId) {
    const source = this.instances.get(sourceId);
    if (!source) return null;
    if (getNodeType(source.type)?.copyable === false) return null;
    return this._add(source.type, cloneContentFor(source.type, source.content));
  }

  /**
   * Create a new instance from a serializable { type, content } snapshot
   * (e.g. the internal Patch Bay clipboard). Content is duplicated so the new
   * instance is fully independent of the snapshot/source.
   */
  createFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const type = getNodeType(snapshot.type);
    if (!type || type.copyable === false) return null;
    return this._add(snapshot.type, cloneContentFor(snapshot.type, snapshot.content));
  }

  /** Delete a user-created instance (native/system nodes are never deletable). */
  delete(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    if (getNodeType(instance.type)?.deletable === false) return false;
    // Tear the chain down in the engine FIRST. Deleting the node only removed
    // it from the graph, so `engineSync` stopped seeing it and its chain kept
    // its last `outputEnabled=true` — a deleted VST node went on making sound
    // and kept its plugins (and their editor windows) alive forever.
    if (instance.type === 'vst' && this.hub.engine) {
      if (this.hub.control?.pendingLearn?.nodeId === id) {
        this.hub.control.cancelLearn(id, null, 'node-deleted');
      }
      this.hub.engine.setChainMidiEnabled(id, false);
      const plugins = (instance.content && Array.isArray(instance.content.plugins))
        ? instance.content.plugins
        : [];
      for (const plugin of plugins) {
        this.hub.engine.removeInstance(id, plugin.id);
      }
    }
    // Remove routing node (graph cleans up its connections) and layout entry.
    this.hub.graph.removeNode(id);
    this.layout.remove(id);
    // A fixed module (currently Sequencer) is the project-wide editor for data
    // that outlives its Patch Bay routing presence. Removing that node must not
    // make the editor — and therefore its Stop control / arrangement — vanish.
    if (!getNodeType(instance.type)?.fixedModuleId) this.hub.modules.unregister(id);
    this.instances.delete(id);
    this._persist();
    return true;
  }

  _registerModule(instance) {
    const type = getNodeType(instance.type);
    const manager = this;
    const hub = this.hub;
    // Sequencer keeps its existing fixed page/sidebar module. Its persisted
    // project instance contributes only the graph node, avoiding a duplicate
    // module id while keeping NodeInstanceManager as the sole instance store.
    if (type.fixedModuleId) {
      if (!hub.graph.getNode(instance.id)) hub.graph.addNode(buildRoutingNode(instance, hub));
      return;
    }
    const module = {
      id: instance.id,
      name: instance.name,
      navEntry: { label: instance.name, icon: type.icon, accent: instance.type, group: 'node' },
      routingNode: buildRoutingNode(instance, hub),
      mount(container) {
        // Seed from the engine rather than starting blank: opening this panel
        // for the second time must show what is actually loaded, not "pending"
        // for everything just because the events fired while it was unmounted.
        const statusMap = new Map(); // instanceId -> loading|ready|error
        if (type.id === 'vst') {
          for (const plugin of (instance.content && instance.content.plugins) || []) {
            const status = hub.engine.getInstanceStatus(instance.id, plugin.id);
            if (status) statusMap.set(plugin.id, status);
          }
        }
        const editorNotes = new Map(); // instanceId -> last editor feedback line
        const subs = [];
        let selectedArpStep = -1;
        let arpCurrentStep = -1;
        let arpDrag = null;

        function updateArpPlayhead() {
          if (type.id !== 'arpeggiator') return;
          container.querySelectorAll('[data-arp-step-marker],[data-arp-velocity]').forEach((el) => {
            const step = Number(el.dataset.arpStepMarker ?? el.dataset.arpVelocity);
            el.classList.toggle('current', step === arpCurrentStep);
          });
        }

        function centerArpRoll() {
          if (type.id !== 'arpeggiator') return;
          const scroll = container.querySelector('[data-arp-roll-scroll]');
          const rootCell = container.querySelector('[data-arp-cell][data-arp-step="0"][data-arp-offset="0"]');
          if (scroll && rootCell) {
            scroll.scrollTop = Math.max(0, rootCell.offsetTop - scroll.clientHeight / 2 + rootCell.offsetHeight / 2);
          }
        }

        function afterArpRender(center = false) {
          updateArpPlayhead();
          if (!center) return;
          if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(centerArpRoll);
          else centerArpRoll();
        }

        function rerenderArpCustom(center = false) {
          const editor = container.querySelector('[data-arp-custom-editor]');
          if (!editor) return;
          const scroll = editor.querySelector('[data-arp-roll-scroll]');
          const scrollTop = scroll?.scrollTop || 0;
          const scrollLeft = scroll?.scrollLeft || 0;
          editor.innerHTML = renderCustomPatternEditor(instance.content, selectedArpStep);
          const nextScroll = editor.querySelector('[data-arp-roll-scroll]');
          if (nextScroll && !center) {
            nextScroll.scrollTop = scrollTop;
            nextScroll.scrollLeft = scrollLeft;
          }
          const velocityScroll = editor.querySelector('[data-arp-velocity-scroll]');
          if (velocityScroll) velocityScroll.scrollLeft = nextScroll?.scrollLeft || 0;
          afterArpRender(center);
        }

        function publishArpEdit() {
          manager._persist();
          hub.events.emit('nativeMidi:stateChanged', { nodeId:instance.id });
        }

        if(type.id==='morpher') subs.push(hub.events.on('engine:transport',(state)=>{
          const phase=((Number(state.ppqPosition)||0)%4+4)%4/4;const active=Math.min(instance.content.stepCount-1,Math.floor(phase*instance.content.stepCount));
          container.querySelectorAll('[data-morph-step]').forEach((el)=>el.classList.toggle('active',Number(el.dataset.morphStep)===active));
        }));
        if(type.id==='arpeggiator') subs.push(hub.events.on('engine:transport',(state)=>{
          const next = state?.playing
            ? currentArpeggiatorStep(state.ppqPosition, instance.content.rate, instance.content.patternLength)
            : -1;
          if (next === arpCurrentStep) return;
          arpCurrentStep = next;
          updateArpPlayhead();
        }));

        hub.diagnostics.log(`vst: mount ${instance.id} plugins=${hub.engine.plugins.length} engine=${hub.engine.state}`);
        container.innerHTML = type.id === 'vst' ? renderVstEditor(instance, type, hub, statusMap, editorNotes)
          : (type.id === 'arpeggiator' ? renderArpeggiatorEditor(instance,type) : ((type.id === 'mixer'||type.id === 'morpher') ? renderNativeAudioEditor(instance,type,hub) : renderGenericShell(instance, type)));
        afterArpRender(true);

        if (type.id === 'vst') {
          // Live engine status for this chain.
          subs.push(
            hub.events.on('engine:instanceStatus', (msg) => {
              if (msg.chainId !== instance.id) return;
              statusMap.set(msg.instanceId, msg.status);
              if (msg.status === 'error') editorNotes.set(msg.instanceId, msg.error || 'Plugin failed to load');
              rerenderChain();
            }),
            hub.events.on('engine:chainChanged', (msg) => {
              if (msg.chainId !== instance.id) return;
              for (const inst of msg.instances || []) statusMap.set(inst.instanceId, inst.status);
              rerenderChain();
            }),
            // Native editor feedback. Without this the user got no signal at
            // all from "Open Plugin" — a failure and a success looked the same.
            hub.events.on('engine:editorStatus', (msg) => {
              if (msg.chainId !== instance.id) return;
              if (msg.open) {
                editorNotes.set(msg.instanceId, `editor open ${msg.width || '?'}x${msg.height || '?'}`);
              } else {
                editorNotes.set(msg.instanceId, msg.message ? `editor: ${msg.message}` : 'editor closed');
              }
              rerenderChain();
            }),
            hub.events.on('engine:plugins', () => {
              hub.diagnostics.log(`vst: plugins event -> re-render add section (${hub.engine.plugins.length} plugins)`);
              scanState.error = '';
              rerenderAddSection();
            }),
            // A scan says nothing for a minute; the button has to show that.
            hub.events.on('engine:scanning', (scanning) => {
              if (scanning) scanState.error = '';
              rerenderAddSection();
            }),
            hub.events.on('engine:error', (msg) => {
              if (!String(msg?.code || '').startsWith('scan')) return;
              scanState.error = msg.message || msg.code;
              rerenderAddSection();
            }),
            hub.events.on('engine:state', () => {
              const pill = container.querySelector('#vst-engine-status');
              if (pill) {
                const down = hub.engine.state === 'error' || hub.engine.state === 'stopped';
                pill.textContent = down ? 'Engine unavailable' : 'Engine ready';
                pill.className = 'pill ' + (down ? 'off' : 'ok');
              }
            }),
            hub.events.on('control:bindingsChanged', (change) => {
              if (change.nodeId && change.nodeId !== instance.id) return;
              rerenderControlBindings();
            })
          );
        }

        const scanState = { error: '' };

        function rerenderAddSection() {
          const addEl = container.querySelector('#vst-add-section');
          if (addEl) addEl.innerHTML = renderAddVst(hub, scanState);
        }

        function rerenderChain() {
          const chainEl = container.querySelector('#vst-chain');
          if (chainEl) chainEl.innerHTML = renderChain(instance.content.plugins, statusMap, editorNotes);
        }

        let selectedControlId = null;

        function rerenderControlBindings() {
          const bindingsEl = container.querySelector('#vst-control-bindings');
          if (bindingsEl) bindingsEl.innerHTML = renderControlBindings(instance, hub, selectedControlId);
        }

        // One handler per mount, removed on unmount. It used to be attached to
        // the shared `#content` element and never removed, so every module
        // visit left another live handler on it: clicking a plugin action then
        // fired for OTHER VST nodes too (same `plugin-N` ids), and "Delete
        // Node" on any page could delete a previously visited node.
        const onClick = (e) => {
          if (e.target.closest('#node-delete')) {
            manager.delete(instance.id);
            hub.modules.activate('home', container);
            return;
          }
          if (type.id === 'arpeggiator') {
            const action=e.target.closest('[data-arp-action]')?.dataset.arpAction;
            if (action === 'remove-note' && selectedArpStep >= 0) {
              removeCustomNote(instance.content, selectedArpStep);
              publishArpEdit();
              rerenderArpCustom();
            }
            return;
          }
          if (type.id !== 'vst') return;

          const surfaceControl = e.target.closest('[data-minilab-control-id]');
          if (surfaceControl?.dataset.minilabControlId) {
            selectedControlId = surfaceControl.dataset.minilabControlId;
            rerenderControlBindings();
            return;
          }

          const controlAction = e.target.dataset.controlAction;
          const sourceControlId = e.target.dataset.sourceControlId;
          if (controlAction === 'learn' && sourceControlId) {
            hub.control.armLearn(instance.id, sourceControlId);
            rerenderControlBindings();
            return;
          }
          if (controlAction === 'cancel' && sourceControlId) {
            hub.control.cancelLearn(instance.id, sourceControlId, 'cancelled');
            rerenderControlBindings();
            return;
          }
          if (controlAction === 'clear' && sourceControlId) {
            hub.control.clear(instance.id, sourceControlId);
            rerenderControlBindings();
            return;
          }

          if (e.target.closest('#vst-scan')) {
            scanState.error = '';
            hub.engine.scanVst3(true); // explicit: this result may also shrink the catalog
            rerenderAddSection();
            return;
          }
          if (e.target.closest('#vst-add')) {
            const pick = container.querySelector('#vst-pick');
            if (!pick || !pick.value) return;
            const plugin = hub.engine.getPlugin(pick.value);
            if (!plugin) return;
            const chain = manager.getChain(instance.id);
            if (!chain) return;
            const p = chain.append({
              pluginId: plugin.pluginId,
              name: plugin.name,
              role: plugin.role
            });
            statusMap.set(p.id, 'loading');
            hub.engine.createInstance(instance.id, plugin.pluginId, p.id, chain.plugins.length - 1);
            rerenderChain();
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
              editorNotes.set(id, status === 'error'
                ? (hub.engine.getInstanceError(instance.id, id) || 'plugin failed to load')
                : 'still loading — try again in a moment');
              rerenderChain();
              return;
            }
            editorNotes.set(id, 'opening editor…');
            rerenderChain();
            hub.engine.openEditor(instance.id, id);
          } else if (action === 'bypass') {
            const p = chain.plugins[idx];
            const newBypass = !p.bypassed;
            chain.setBypass(id, newBypass);
            hub.engine.setBypass(instance.id, id, newBypass);
            statusMap.set(id, newBypass ? 'bypassed' : 'ready');
            rerenderChain();
          } else if (action === 'remove') {
            hub.control.targetInvalidated(instance.id, id, 'target-removed');
            chain.remove(id);
            hub.engine.removeInstance(instance.id, id);
            statusMap.delete(id);
            editorNotes.delete(id);
            rerenderChain();
          } else if (action === 'up') {
            if (idx > 0) {
              chain.reorder(id, idx - 1);
              hub.engine.reorderChain(instance.id, id, idx - 1);
              rerenderChain();
            }
          } else if (action === 'down') {
            if (idx < chain.plugins.length - 1) {
              chain.reorder(id, idx + 1);
              // After reorder, the plugin moves to idx+1; engine index is the new position.
              hub.engine.reorderChain(instance.id, id, idx + 1);
              rerenderChain();
            }
          }
        };

        // A `range` input fires `input` on every pixel of a drag. Each one used
        // to run a full synchronous settings write AND a complete native audio
        // graph recompile - measured at up to 37 recompiles per second in the
        // runtime log, every one of them resetting the PDC delay lines. The
        // model is still updated on the spot so the UI stays live; only the
        // persistence and the native republish are coalesced, and the `change`
        // that ends the gesture flushes them immediately.
        let nativeValueTimer = null;
        const flushNativeValues = () => {
          if (nativeValueTimer) { clearTimeout(nativeValueTimer); nativeValueTimer = null; }
          manager._persist();
          hub.events.emit('nativeAudio:stateChanged', { nodeId: instance.id });
        };
        // Unmount must not republish a graph nobody edited.
        const flushPendingNativeValues = () => {
          if (nativeValueTimer) flushNativeValues();
        };
        const scheduleNativeValues = (immediate) => {
          if (immediate) { flushNativeValues(); return; }
          if (nativeValueTimer) clearTimeout(nativeValueTimer);
          nativeValueTimer = setTimeout(flushNativeValues, NATIVE_VALUE_COALESCE_MS);
        };
        module._flushNativeValues = flushPendingNativeValues;

        const onInput = (e) => {
          if (type.id === 'arpeggiator') {
            const control=e.target.dataset.arpControl;
            if (control) {
              if (e.target.tagName === 'SELECT' && e.type !== 'change') return;
              const value=control==='snapToScale'?e.target.checked
                :(control==='root'||control==='patternLength'?Number(e.target.value):e.target.value);
              if (instance.content[control] === value) return;
              instance.content[control]=value;
              if (control === 'patternLength' && selectedArpStep >= value) selectedArpStep = -1;
              publishArpEdit();
              syncArpControlStrip(container, instance.content);
              rerenderArpCustom();
              return;
            }
            const step=e.target.closest('[data-arp-step]'); const field=e.target.dataset.arpField;
            if (step && field) {
              const target=instance.content.customPattern[Number(step.dataset.arpStep)];
              target[field]=e.target.type==='checkbox'?e.target.checked:Number(e.target.value);
              if (field==='rest' && target.rest) target.tie=false;
              if (field==='tie' && target.tie) target.rest=true;
              publishArpEdit();
              if (field !== 'gate' || e.type === 'change') rerenderArpCustom();
            }
            return;
          }
          if (type.id !== 'mixer' && type.id !== 'morpher') return;
          const row=e.target.closest('[data-audio-input]'); const item=row&&instance.content.inputs.find((p)=>p.id===row.dataset.audioInput);
          if (item && e.target.dataset.nativeControl==='level') item.level=Number(e.target.value);
          if (item && e.target.dataset.nativeControl==='mute') item.muted=e.target.checked;
          if (e.target.dataset.nativeControl==='masterLevel') instance.content.masterLevel=Number(e.target.value);
          if (e.target.dataset.nativeControl==='stepCount') instance.content.stepCount=Number(e.target.value);
          if (e.target.dataset.nativeStep) instance.content.steps[Number(e.target.dataset.nativeStep)]=Number(e.target.value);
          scheduleNativeValues(e.type === 'change');
        };

        const onPointerDown = (e) => {
          if (type.id !== 'arpeggiator') return;
          const resize=e.target.closest('[data-arp-resize]');
          const cell=e.target.closest('[data-arp-cell]');
          const velocity=e.target.closest('[data-arp-velocity]');
          if (resize && cell) {
            const step=Number(cell.dataset.arpStep);
            selectedArpStep=step;arpDrag={kind:'gate',step};e.preventDefault();
          } else if (velocity) {
            const step=Number(velocity.dataset.arpVelocity);
            selectedArpStep=step;arpDrag={kind:'velocity',step};
            instance.content.customPattern[step].velocity=velocityFromPointer(e.clientY,velocity.getBoundingClientRect());
            publishArpEdit();rerenderArpCustom();e.preventDefault();
          } else if (cell) {
            const step=Number(cell.dataset.arpStep), offset=Number(cell.dataset.arpOffset);
            selectedArpStep=step;arpDrag={kind:'note',step};
            setCustomNote(instance.content,step,offset);
            publishArpEdit();rerenderArpCustom();e.preventDefault();
          } else return;
          if (typeof container.setPointerCapture === 'function') {
            try { container.setPointerCapture(e.pointerId); } catch {}
          }
        };

        const onPointerMove = (e) => {
          if (!arpDrag || type.id !== 'arpeggiator') return;
          if (arpDrag.kind === 'velocity') {
            const velocity=container.querySelector(`[data-arp-velocity="${arpDrag.step}"]`);
            if (!velocity) return;
            const next=velocityFromPointer(e.clientY,velocity.getBoundingClientRect());
            if (instance.content.customPattern[arpDrag.step].velocity === next) return;
            instance.content.customPattern[arpDrag.step].velocity=next;
          } else if (arpDrag.kind === 'gate') {
            const source=container.querySelector(`[data-arp-cell][data-arp-step="${arpDrag.step}"][data-arp-offset="${instance.content.customPattern[arpDrag.step].semitoneOffset}"]`);
            if (!source) return;
            const rect=source.getBoundingClientRect();
            const units=Math.max(.05,(e.clientX-rect.left)/Math.max(1,rect.width));
            const cells=Math.max(1,Math.ceil(units));
            const end=Math.min(instance.content.patternLength-1,arpDrag.step+cells-1);
            const fraction=end===instance.content.patternLength-1&&arpDrag.step+cells-1>end
              ? 1 : Math.max(.05,Math.min(1,units-(cells-1)));
            setCustomGateDuration(instance.content,arpDrag.step,end,fraction);
          } else {
            const hit=(typeof document !== 'undefined' && document.elementFromPoint)
              ? document.elementFromPoint(e.clientX,e.clientY) : e.target;
            const cell=hit?.closest?.('[data-arp-cell]');
            if (!cell) return;
            const step=Number(cell.dataset.arpStep), offset=Number(cell.dataset.arpOffset);
            if (step === arpDrag.step && instance.content.customPattern[step].semitoneOffset === offset) return;
            moveCustomNote(instance.content,arpDrag.step,step,offset);
            arpDrag.step=step;selectedArpStep=step;
          }
          publishArpEdit();rerenderArpCustom();e.preventDefault();
        };

        const onPointerUp = (e) => {
          if (!arpDrag) return;
          arpDrag=null;
          if (typeof container.releasePointerCapture === 'function') {
            try { container.releasePointerCapture(e.pointerId); } catch {}
          }
        };

        const onKeyDown = (e) => {
          if (type.id !== 'arpeggiator' || selectedArpStep < 0 || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
          if (e.target.closest('input,select,textarea')) return;
          removeCustomNote(instance.content,selectedArpStep);
          publishArpEdit();rerenderArpCustom();e.preventDefault();
        };

        const onScroll = (e) => {
          if (type.id !== 'arpeggiator') return;
          const roll=container.querySelector('[data-arp-roll-scroll]');
          const velocity=container.querySelector('[data-arp-velocity-scroll]');
          if (!roll || !velocity) return;
          if (e.target === roll && velocity.scrollLeft !== roll.scrollLeft) velocity.scrollLeft=roll.scrollLeft;
          if (e.target === velocity && roll.scrollLeft !== velocity.scrollLeft) roll.scrollLeft=velocity.scrollLeft;
        };

        container.addEventListener('click', onClick);
        container.addEventListener('input', onInput);
        container.addEventListener('change', onInput);
        container.addEventListener('pointerdown', onPointerDown);
        container.addEventListener('pointermove', onPointerMove);
        container.addEventListener('pointerup', onPointerUp);
        container.addEventListener('pointercancel', onPointerUp);
        container.addEventListener('keydown', onKeyDown);
        container.addEventListener('scroll', onScroll, true);

        // Store cleanup for unmount.
        module._subs = subs;
        module._container = container;
        module._onClick = onClick;
        module._onInput = onInput;
        module._onPointerDown = onPointerDown;
        module._onPointerMove = onPointerMove;
        module._onPointerUp = onPointerUp;
        module._onKeyDown = onKeyDown;
        module._onScroll = onScroll;
      },
      unmount() {
        if (module._flushNativeValues) {
          module._flushNativeValues();
          module._flushNativeValues = null;
        }
        if (module._subs) {
          module._subs.forEach((u) => u());
          module._subs = [];
        }
        if (module._container && module._onClick) {
          module._container.removeEventListener('click', module._onClick);
          module._container.removeEventListener('input', module._onInput);
          module._container.removeEventListener('change', module._onInput);
          module._container.removeEventListener('pointerdown', module._onPointerDown);
          module._container.removeEventListener('pointermove', module._onPointerMove);
          module._container.removeEventListener('pointerup', module._onPointerUp);
          module._container.removeEventListener('pointercancel', module._onPointerUp);
          module._container.removeEventListener('keydown', module._onKeyDown);
          module._container.removeEventListener('scroll', module._onScroll, true);
        }
        module._container = null;
        module._onClick = null;
        module._onInput = null;
        module._onPointerDown = null;
        module._onPointerMove = null;
        module._onPointerUp = null;
        module._onKeyDown = null;
        module._onScroll = null;
      }
    };
    this.hub.modules.register(module);
  }

  /**
   * Persisted form of an instance. `name` is deliberately NOT stored: it is
   * derived from type + ordinal, and storing both invites the two to drift.
   */
  _serialize(instance) {
    return {
      id: instance.id,
      type: instance.type,
      ordinal: instance.ordinal,
      content: instance.content
    };
  }

  _persist() {
    return this.hub.settings.set(KEY, {
      instances: this.list().map((inst) => this._serialize(inst)),
      idSeq: { ...this._idSeq }
    });
  }
}
