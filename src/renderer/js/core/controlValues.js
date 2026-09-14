/**
 * Where the parameter bound to each control stands, for the bars that draw it.
 *
 * Asked 2026-09-14: in the bindings bar, a knob dragged with the mouse moves the
 * parameter it is bound to, and the parameter moved in the plugin moves the
 * knob. So the drawing needs a position, and three things change it:
 *
 *   - MiniHub writing the parameter -- a knob turned on the keyboard, or dragged
 *     in the bar. Both go through `ControlBindingManager.route()`, which says so
 *     (`control:routed`), because the engine does not echo what the host writes.
 *   - the plugin moving it under the mouse, which the engine reports while the
 *     plugin's window is open (`engine:vstParameterTouched`);
 *   - everything else -- the value the parameter already had when the bar
 *     opened, a preset loaded in the plugin -- which is read back from the
 *     engine, for the bound parameters only.
 *
 * A read takes time, and a value written while it travels is newer than the
 * read. Every write is numbered, and a read never overwrites a write made after
 * it was asked.
 *
 * Only what an open bar shows is followed: a node with no bar costs nothing.
 */
import { getMiniLabControlSource } from '../midi/minilabControls.js';

// What a mouse can move: what turns or slides. A pad is struck, a button
// pressed; neither has a position to drag. Profile families, never ids.
const MOVABLE_FAMILIES = new Set(['knob', 'main', 'fader', 'strip']);

const keyOf = (nodeId, controlId) => `${nodeId}${controlId}`;
const clamp01 = (value) => Math.min(1, Math.max(0, value));

export class ControlValues {
  constructor(hub) {
    this.hub = hub;
    this._watchers = new Map();   // nodeId -> how many bars show it
    this._values = new Map();     // nodeId -> Map(controlId -> normalized value)
    this._signatures = new Map(); // nodeId -> which movable bindings it had
    this._writes = new Map();     // node + control -> number of its last write
    this._seq = 0;
    this._unsubs = [
      hub.events.on('control:routed', (msg) => this._write(msg?.nodeId, msg?.sourceControlId, msg?.normalizedValue)),
      hub.events.on('engine:vstParameterTouched', (msg) => this._touched(msg)),
      hub.events.on('control:bindingsChanged', (change) => this._bindingsChanged(change?.nodeId || null)),
      // A preset loaded inside the plugin changes its parameters and reports
      // none of them; its state changing is the one sign of it.
      hub.events.on('engine:pluginState', (msg) => {
        if (this._watchers.has(msg?.chainId)) this.refresh(msg.chainId);
      })
    ];
  }

  dispose() {
    for (const off of this._unsubs) if (typeof off === 'function') off();
    this._unsubs = [];
    this._watchers.clear();
    this._values.clear();
  }

  /** A bar started showing this node. The first one reads the positions. */
  watch(nodeId) {
    const count = (this._watchers.get(nodeId) || 0) + 1;
    this._watchers.set(nodeId, count);
    if (count > 1) return;
    this._signatures.set(nodeId, this._signature(nodeId));
    this.refresh(nodeId);
  }

  unwatch(nodeId) {
    const count = (this._watchers.get(nodeId) || 0) - 1;
    if (count > 0) {
      this._watchers.set(nodeId, count);
      return;
    }
    this._watchers.delete(nodeId);
    this._values.delete(nodeId);
    this._signatures.delete(nodeId);
  }

  /** `{ controlId: value }` for every movable control whose position is known. */
  snapshot(nodeId) {
    const known = this._values.get(nodeId);
    const out = {};
    for (const binding of this._movable(nodeId)) {
      const value = known?.get(binding.sourceControlId);
      if (Number.isFinite(value)) out[binding.sourceControlId] = value;
    }
    return out;
  }

  /** Read the bound parameters back from the engine. */
  async refresh(nodeId) {
    if (!this._watchers.has(nodeId) || this.hub.engine?.state !== 'running') return;
    const byInstance = new Map();
    for (const binding of this._movable(nodeId)) {
      if (!byInstance.has(binding.pluginInstanceId)) byInstance.set(binding.pluginInstanceId, []);
      byInstance.get(binding.pluginInstanceId).push(binding);
    }
    await Promise.all([...byInstance].map(async ([instanceId, bindings]) => {
      const asked = new Map(bindings.map((binding) => [
        binding.sourceControlId, this._writes.get(keyOf(nodeId, binding.sourceControlId)) ?? 0
      ]));
      let answer;
      try {
        answer = await this.hub.engine.getVstParameters(nodeId, instanceId,
          [...new Set(bindings.map((binding) => binding.parameterId))]);
      } catch (_) {
        return;
      }
      if (!this._watchers.has(nodeId) || answer?.status !== 'ok' || !Array.isArray(answer.parameters)) return;
      const read = new Map(answer.parameters.map((parameter) => [String(parameter.parameterId), Number(parameter.normalizedValue)]));
      for (const binding of this._movable(nodeId)) {
        if (binding.pluginInstanceId !== instanceId || !asked.has(binding.sourceControlId)) continue;
        if ((this._writes.get(keyOf(nodeId, binding.sourceControlId)) ?? 0) !== asked.get(binding.sourceControlId)) continue;
        const value = read.get(binding.parameterId);
        if (Number.isFinite(value)) this._set(nodeId, binding.sourceControlId, value);
      }
    }));
  }

  /** The node's bindings a mouse can move: active, and on a control that turns or slides. */
  _movable(nodeId) {
    const bindings = this.hub.nodes?.getControlBindings?.(nodeId) ?? [];
    return bindings.filter((binding) => MOVABLE_FAMILIES.has(getMiniLabControlSource(binding.sourceControlId)?.family)
      && this.hub.control?.bindingStatus(nodeId, binding.sourceControlId)?.state === 'active');
  }

  _signature(nodeId) {
    return this._movable(nodeId)
      .map((binding) => `${binding.sourceControlId}=${binding.pluginInstanceId}/${binding.parameterId}`)
      .sort()
      .join('|');
  }

  _bindingsChanged(nodeId) {
    for (const watched of [...this._watchers.keys()]) {
      if (nodeId && watched !== nodeId) continue;
      const signature = this._signature(watched);
      if (signature === this._signatures.get(watched)) continue;
      this._signatures.set(watched, signature);
      this.hub.events.emit('control:values', { nodeId: watched });
      this.refresh(watched);
    }
  }

  _touched(msg) {
    if (!this._watchers.has(msg?.chainId)) return;
    for (const binding of this._movable(msg.chainId)) {
      if (binding.pluginInstanceId === msg.instanceId && binding.parameterId === msg.parameterId) {
        this._write(msg.chainId, binding.sourceControlId, Number(msg.normalizedValue));
      }
    }
  }

  _write(nodeId, controlId, value) {
    if (!this._watchers.has(nodeId) || !Number.isFinite(value)) return;
    this._writes.set(keyOf(nodeId, controlId), ++this._seq);
    this._set(nodeId, controlId, value);
  }

  _set(nodeId, controlId, value) {
    const normalized = clamp01(value);
    let known = this._values.get(nodeId);
    if (!known) this._values.set(nodeId, known = new Map());
    if (known.get(controlId) === normalized) return;
    known.set(controlId, normalized);
    this.hub.events.emit('control:value', { nodeId, sourceControlId: controlId, normalizedValue: normalized });
  }
}
