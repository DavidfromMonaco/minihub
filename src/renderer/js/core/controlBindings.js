import {
  MINILAB_CONTROL_SOURCES,
  getMiniLabControlSource,
  getMiniLabControlSourceByPort
} from '../midi/minilabControls.js';
import { MINILAB_NODE_ID } from './systemNodes.js';

export const CONTROL_BINDING_VERSION = 1;
const MAX_PLUGIN_ID_LENGTH = 2048;
const MAX_NAME_LENGTH = 256;

/** VST3 ParamID is an unsigned 32-bit integer rendered by JUCE as decimal. */
export function isStableVstParameterId(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(value)) return false;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
}

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Validate one persisted binding. Invalid/unbounded records are discarded on
 * load instead of being allowed to widen the IPC surface later.
 */
export function normalizeControlBinding(value) {
  if (!value || typeof value !== 'object' || value.version !== CONTROL_BINDING_VERSION) return null;
  if (!getMiniLabControlSource(value.sourceControlId)) return null;
  if (!boundedString(value.pluginInstanceId, 64)
      || !/^plugin-[1-9][0-9]*$/.test(value.pluginInstanceId)) return null;
  if (!boundedString(value.pluginId, MAX_PLUGIN_ID_LENGTH)) return null;
  if (!isStableVstParameterId(value.parameterId)) return null;
  return {
    version: CONTROL_BINDING_VERSION,
    sourceControlId: value.sourceControlId,
    pluginInstanceId: value.pluginInstanceId,
    pluginId: value.pluginId,
    parameterId: value.parameterId,
    pluginName: boundedString(value.pluginName, MAX_NAME_LENGTH) ? value.pluginName : '',
    parameterName: boundedString(value.parameterName, MAX_NAME_LENGTH) ? value.parameterName : ''
  };
}

/** At most one destination record exists for each physical source. */
export function normalizeControlBindings(values) {
  if (!Array.isArray(values)) return [];
  const unique = new Map();
  for (const value of values) {
    const binding = normalizeControlBinding(value);
    if (binding && !unique.has(binding.sourceControlId)) {
      unique.set(binding.sourceControlId, binding);
    }
  }
  return [...unique.values()];
}

/**
 * Owns persistent CONTROL bindings and the one pending Learn selection.
 *
 * The network remains topology authority: routing is possible only while the
 * specific MiniLab CONTROL source has a cable into the VST node's CTRL IN.
 * Binding identity is node id + stable source id + plugin instance id + exact
 * plugin id + stable VST3 ParamID. Display names are metadata only.
 */
export class ControlBindingManager {
  constructor(hub) {
    this.hub = hub;
    this.pendingLearn = null;
    this._learnSeq = 0;
    this._learnNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this._learnFeedback = new Map();
    this._unsubs = [
      hub.events.on('engine:vstParameterTouched', (msg) => this._captureLearn(msg)),
      hub.events.on('engine:vstParameterLearnState', (msg) => this._onLearnState(msg)),
      hub.events.on('engine:state', (state) => this._onEngineState(state)),
      hub.events.on('engine:instanceStatus', (msg) => this._onInstanceStatus(msg)),
      hub.events.on('engine:chainChanged', (msg) => this._onChainChanged(msg)),
      hub.events.on('engine:editorStatus', (msg) => this._onEditorStatus(msg)),
      hub.events.on('network:change', (change) => this._onNetworkChange(change))
    ];
  }

  dispose() {
    this.cancelLearn(null, null, 'disposed');
    this._unsubs.forEach((off) => { if (typeof off === 'function') off(); });
    this._unsubs = [];
    this._clearPending();
  }

  connectedSources(nodeId) {
    const byId = new Map();
    for (const connection of this.hub.network.connectionsTo(nodeId, 'ctrl-in')) {
      if (connection.from.nodeId !== MINILAB_NODE_ID) continue;
      const source = getMiniLabControlSourceByPort(connection.from.portId);
      if (source) byId.set(source.id, source);
    }
    return MINILAB_CONTROL_SOURCES.filter((source) => byId.has(source.id));
  }

  isConnected(nodeId, sourceControlId) {
    const source = getMiniLabControlSource(sourceControlId);
    if (!source) return false;
    return this.hub.network.connectionsTo(nodeId, 'ctrl-in').some((connection) => (
      connection.from.nodeId === MINILAB_NODE_ID && connection.from.portId === source.portId
    ));
  }

  armLearn(nodeId, sourceControlId) {
    const node = this.hub.nodes.get(nodeId);
    if (!node || node.type !== 'vst') return this._armFailure(nodeId, sourceControlId, 'node-not-found');
    if (!this.isConnected(nodeId, sourceControlId)) {
      return this._armFailure(nodeId, sourceControlId, 'source-not-connected');
    }
    if (this.hub.engine.state !== 'running') {
      return this._armFailure(nodeId, sourceControlId, 'engine-not-running');
    }

    const openCandidates = this.hub.engine.getOpenEditors(nodeId).filter((editor) => {
      const plugin = node.content.plugins.find((p) => p.id === editor.instanceId);
      return plugin && plugin.pluginId === editor.pluginId
        && this.hub.engine.getInstanceStatus(nodeId, plugin.id) === 'ready'
        && this.hub.engine.getInstanceGeneration(nodeId, plugin.id) === editor.generation;
    });
    if (openCandidates.length > 1) {
      return this._armFailure(nodeId, sourceControlId, 'multiple-plugin-editors-open');
    }
    const readyCandidates = node.content.plugins.filter((plugin) => (
      this.hub.engine.getInstanceStatus(nodeId, plugin.id) === 'ready'
      && Number.isSafeInteger(this.hub.engine.getInstanceGeneration(nodeId, plugin.id))
    ));
    const targetPlugin = openCandidates.length === 1
      ? node.content.plugins.find((plugin) => plugin.id === openCandidates[0].instanceId)
      : (readyCandidates.length === 1 ? readyCandidates[0] : null);
    if (!targetPlugin) {
      return this._armFailure(nodeId, sourceControlId,
        readyCandidates.length > 1 ? 'multiple-plugin-targets' : 'plugin-not-ready');
    }

    // The native engine also supersedes its previous operation atomically.
    // Sending an explicit cancellation first gives the old Hub row an exact
    // terminal state without ever allowing a stale touch to bind the new row.
    if (this.pendingLearn) this.cancelLearn(null, null, 'superseded');
    const target = openCandidates[0] || {
      instanceId: targetPlugin.id,
      pluginId: targetPlugin.pluginId,
      generation: this.hub.engine.getInstanceGeneration(nodeId, targetPlugin.id)
    };
    const learnId = `learn-${this._learnNonce}-${++this._learnSeq}`;
    const plugin = node.content.plugins.find((p) => p.id === target.instanceId);
    this.pendingLearn = {
      learnId,
      nodeId,
      sourceControlId,
      pluginInstanceId: plugin.id,
      pluginId: plugin.pluginId,
      generation: target.generation,
      state: 'arming',
      timer: null
    };
    this._learnFeedback.delete(this._feedbackKey(nodeId, sourceControlId));
    this._startAckTimer(this.pendingLearn, 'arm-timeout');
    this._changed(nodeId);
    // openEditor is idempotent in the native host: it creates at most one
    // editor and otherwise raises the existing exact instance window. Commands
    // share the engine FIFO, so Learn is armed only after the open/front request.
    const openRequest = Promise.resolve(
      this.hub.engine.openEditor(nodeId, plugin.id, plugin.pluginId, target.generation)
    );
    const learnRequest = Promise.resolve(this.hub.engine.setVstParameterLearn(
      nodeId, plugin.id, plugin.pluginId, target.generation, learnId, true
    ));
    Promise.all([openRequest, learnRequest]).then(([openResult, learnResult]) => {
      const failure = openResult?.ok === false ? openResult : learnResult?.ok === false ? learnResult : null;
      if (failure) this._finishIfCurrent(learnId, failure.reason || 'engine-unavailable');
    }).catch(() => this._finishIfCurrent(learnId, 'ipc-write-failed'));
    return { ok: true, learnId };
  }

  cancelLearn(nodeId, sourceControlId, reason = 'cancelled') {
    if (!this.pendingLearn) return false;
    if (nodeId && this.pendingLearn.nodeId !== nodeId) return false;
    if (sourceControlId && this.pendingLearn.sourceControlId !== sourceControlId) return false;
    const pending = this.pendingLearn;
    pending.state = 'cancelling';
    pending.cancelReason = reason;
    this._startAckTimer(pending, reason);
    this._changed(pending.nodeId);
    this.hub.engine.setVstParameterLearn(
      pending.nodeId,
      pending.pluginInstanceId,
      pending.pluginId,
      pending.generation,
      pending.learnId,
      false
    ).then((result) => {
      if (result?.ok) return;
      this._finishIfCurrent(pending.learnId, reason);
    }).catch(() => this._finishIfCurrent(pending.learnId, reason));
    this._focusHub();
    return true;
  }

  /** Called before a model/native target is removed or replaced. */
  targetInvalidated(nodeId, pluginInstanceId, reason = 'target-invalidated') {
    const pending = this.pendingLearn;
    if (!pending || pending.nodeId !== nodeId || pending.pluginInstanceId !== pluginInstanceId) {
      return false;
    }
    return this.cancelLearn(nodeId, pending.sourceControlId, reason);
  }

  learnFeedback(nodeId, sourceControlId) {
    const pending = this.pendingLearn;
    if (pending?.nodeId === nodeId && pending.sourceControlId === sourceControlId) {
      return pending.state;
    }
    return this._learnFeedback.get(this._feedbackKey(nodeId, sourceControlId)) || '';
  }

  clear(nodeId, sourceControlId) {
    this.cancelLearn(nodeId, sourceControlId);
    const changed = this.hub.nodes.clearControlBinding(nodeId, sourceControlId);
    if (changed) this._changed(nodeId);
    return changed;
  }

  bindingFor(nodeId, sourceControlId) {
    return this.hub.nodes.getControlBindings(nodeId)
      .find((binding) => binding.sourceControlId === sourceControlId) || null;
  }

  /** Explain whether a persisted binding currently has a live, exact target. */
  bindingStatus(nodeId, sourceControlId) {
    const binding = this.bindingFor(nodeId, sourceControlId);
    if (!binding) return { state: 'unbound', binding: null };
    if (!this.isConnected(nodeId, sourceControlId)) return { state: 'disconnected', binding };
    const node = this.hub.nodes.get(nodeId);
    const plugin = node?.content?.plugins?.find((p) => p.id === binding.pluginInstanceId);
    if (!plugin || plugin.pluginId !== binding.pluginId) return { state: 'missing-target', binding };
    if (this.hub.engine.getInstanceStatus(nodeId, plugin.id) !== 'ready') {
      return { state: 'not-ready', binding };
    }
    if (!Number.isSafeInteger(this.hub.engine.getInstanceGeneration(nodeId, plugin.id))) {
      return { state: 'not-ready', binding };
    }
    return { state: 'active', binding };
  }

  /** Called only from a VST node's typed CTRL IN network callback. */
  route(nodeId, control) {
    if (!control || control.type !== 'control') return { ok: false, reason: 'invalid-control' };
    if (!getMiniLabControlSource(control.sourceControlId)) return { ok: false, reason: 'unknown-source' };
    if (!Number.isFinite(control.normalizedValue)
        || control.normalizedValue < 0 || control.normalizedValue > 1) {
      return { ok: false, reason: 'invalid-value' };
    }
    // While this source is waiting for native LEARN, suppress its previous
    // binding. Otherwise moving the physical source could itself become the
    // "next plugin gesture" and recapture the old target.
    if (this.pendingLearn?.nodeId === nodeId
        && this.pendingLearn.sourceControlId === control.sourceControlId) {
      return { ok: false, reason: 'learn-pending' };
    }
    const status = this.bindingStatus(nodeId, control.sourceControlId);
    if (status.state !== 'active') return { ok: false, reason: status.state };
    const binding = status.binding;
    return this.hub.engine.setVstParameter(
      nodeId,
      binding.pluginInstanceId,
      binding.pluginId,
      binding.parameterId,
      control.normalizedValue
    );
  }

  _captureLearn(msg) {
    const pending = this.pendingLearn;
    // Last-touched notifications are useful UI metadata but are never enough
    // to mutate persistence. Only the native LEARN state can mark a capture.
    if (!pending || pending.state !== 'armed' || msg?.capturedByLearn !== true) return;
    if (msg.learnId !== pending.learnId) return;
    const node = this.hub.nodes.get(pending.nodeId);
    if (!node || node.type !== 'vst' || msg.chainId !== pending.nodeId) return;
    if (!this.isConnected(pending.nodeId, pending.sourceControlId)) return;
    if (msg.instanceId !== pending.pluginInstanceId || msg.pluginId !== pending.pluginId
        || msg.generation !== pending.generation) return;
    const plugin = node.content.plugins.find((p) => p.id === pending.pluginInstanceId);
    if (!plugin || plugin.pluginId !== msg.pluginId) return;
    if (this.hub.engine.getInstanceStatus(msg.chainId, msg.instanceId) !== 'ready') return;
    const generation = this.hub.engine.getInstanceGeneration(msg.chainId, msg.instanceId);
    if (!Number.isSafeInteger(generation) || msg.generation !== generation) return;
    if (!isStableVstParameterId(msg.parameterId)) return;

    this.hub.nodes.setControlBinding(pending.nodeId, {
      version: CONTROL_BINDING_VERSION,
      sourceControlId: pending.sourceControlId,
      pluginInstanceId: plugin.id,
      pluginId: plugin.pluginId,
      parameterId: msg.parameterId,
      pluginName: plugin.name || '',
      parameterName: typeof msg.name === 'string' ? msg.name : ''
    });
    this._learnFeedback.set(this._feedbackKey(pending.nodeId, pending.sourceControlId), 'captured');
    this._clearPending();
    this._changed(pending.nodeId);
    this._focusHub();
  }

  _onLearnState(msg) {
    const pending = this.pendingLearn;
    if (!pending || msg?.learnId !== pending.learnId) return;
    if (msg.chainId !== pending.nodeId || msg.instanceId !== pending.pluginInstanceId
        || msg.pluginId !== pending.pluginId || msg.generation !== pending.generation) return;
    if (msg.armed === true) {
      if (pending.state !== 'arming') return;
      clearTimeout(pending.timer);
      pending.timer = null;
      pending.state = 'armed';
      this._changed(pending.nodeId);
      return;
    }
    const reason = pending.cancelReason || msg.reason || 'learn-ended';
    this._finishIfCurrent(pending.learnId, reason);
  }

  _onEngineState(state) {
    if (state?.state !== 'running' && this.pendingLearn) {
      this._finishIfCurrent(this.pendingLearn.learnId, `engine-${state?.state || 'stopped'}`);
    }
    this._changed();
  }

  _onInstanceStatus(msg) {
    const pending = this.pendingLearn;
    if (pending && msg?.chainId === pending.nodeId && msg.instanceId === pending.pluginInstanceId
        && (msg.status !== 'ready' || msg.generation !== pending.generation)) {
      this.cancelLearn(pending.nodeId, pending.sourceControlId, 'target-not-ready');
    }
    this._changed(msg?.chainId || null);
  }

  _onChainChanged(msg) {
    const pending = this.pendingLearn;
    if (pending && msg?.chainId === pending.nodeId) {
      const target = (msg.instances || []).find((inst) => inst.instanceId === pending.pluginInstanceId);
      if (!target || target.pluginId !== pending.pluginId || target.generation !== pending.generation
          || target.status !== 'ready') {
        this.cancelLearn(pending.nodeId, pending.sourceControlId, 'target-rebuilt');
      }
    }
    this._changed(msg?.chainId || null);
  }

  _onEditorStatus(msg) {
    const pending = this.pendingLearn;
    if (pending && msg?.chainId === pending.nodeId && msg.instanceId === pending.pluginInstanceId
        && msg.open !== true) {
      this.cancelLearn(pending.nodeId, pending.sourceControlId, 'editor-closed');
    }
    this._changed(msg?.chainId || null);
  }

  _onNetworkChange(change) {
    const pending = this.pendingLearn;
    if (pending && change?.type === 'remove' && change.nodeId === pending.nodeId) {
      this.cancelLearn(pending.nodeId, pending.sourceControlId, 'node-deleted');
    } else if (pending && change?.type === 'disconnect'
        && change.to?.nodeId === pending.nodeId && change.to?.portId === 'ctrl-in') {
      const source = getMiniLabControlSource(pending.sourceControlId);
      if (source && change.from?.nodeId === MINILAB_NODE_ID && change.from?.portId === source.portId) {
        this.cancelLearn(pending.nodeId, pending.sourceControlId, 'source-disconnected');
      }
    }
    this._changed(change?.nodeId || change?.to?.nodeId || null);
  }

  _changed(nodeId = null) {
    this.hub.events.emit('control:bindingsChanged', { nodeId });
  }

  _feedbackKey(nodeId, sourceControlId) {
    return `${nodeId || ''}\u001f${sourceControlId || ''}`;
  }

  _armFailure(nodeId, sourceControlId, reason) {
    this._learnFeedback.set(this._feedbackKey(nodeId, sourceControlId), reason);
    this._changed(nodeId);
    return { ok: false, reason };
  }

  _startAckTimer(pending, reason) {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this._finishIfCurrent(pending.learnId, reason), 5000);
  }

  _finishIfCurrent(learnId, reason) {
    const pending = this.pendingLearn;
    if (!pending || pending.learnId !== learnId) return false;
    const nodeId = pending.nodeId;
    this._learnFeedback.set(this._feedbackKey(nodeId, pending.sourceControlId), reason);
    this._clearPending();
    this._changed(nodeId);
    return true;
  }

  _clearPending() {
    if (this.pendingLearn?.timer) clearTimeout(this.pendingLearn.timer);
    this.pendingLearn = null;
  }

  _focusHub() {
    try {
      Promise.resolve(globalThis.window?.hubAPI?.focusMainWindow?.()).catch(() => {});
    } catch (_) {}
  }
}
