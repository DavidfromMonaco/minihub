/**
 * VST role registry + internal plugin chain model.
 *
 * A VST node is a container for an ordered chain of plugin instances. The
 * chain lives inside the owning node's `content` (`{ plugins: [] }`) and is
 * owned exclusively by that VST node — plugins are NOT Hub modules and NOT
 * Patch Bay nodes.
 *
 * VST_ROLES is the single centralized registry for the internal role color
 * code. `color` is the canonical hex (source of truth, testable); `accent` is
 * the matching CSS variable used by the UI. The role is visual metadata only —
 * it must never be assumed to determine real plugin routing capability.
 */

export const VST_ROLES = {
  instrument: {
    id: 'instrument',
    label: 'Instrument',
    accent: '--vst-role-instrument',
    color: '#F5C451',
    badge: 'VSTi',
    icon: 'instrument'
  },
  audioEffect: {
    id: 'audio-effect',
    label: 'Audio Effect',
    accent: '--vst-role-audio-effect',
    color: '#EF6A5B',
    badge: 'FX',
    icon: 'audio-effect'
  },
  midiEffect: {
    id: 'midi-effect',
    label: 'MIDI Effect',
    accent: '--vst-role-midi-effect',
    color: '#A78BFA',
    badge: 'MIDI',
    icon: 'midi-effect'
  },
  utility: {
    id: 'utility',
    label: 'Utility',
    accent: '--vst-role-utility',
    color: '#48B8CC',
    badge: 'UTIL',
    icon: 'utility'
  },
  unknown: {
    id: 'unknown',
    label: 'Unknown',
    accent: '--vst-role-unknown',
    color: '#94A3B8',
    badge: '?',
    icon: 'unknown'
  }
};

/** Resolve a role by key (e.g. `audioEffect`) or by its hyphenated id (e.g.
 *  `audio-effect`, as reported by the native engine). Falls back to `unknown`. */
export function getVstRole(roleId) {
  if (VST_ROLES[roleId]) return VST_ROLES[roleId];
  for (const key of Object.keys(VST_ROLES)) {
    if (VST_ROLES[key].id === roleId) return VST_ROLES[key];
  }
  return VST_ROLES.unknown;
}

/**
 * Deterministic family grouping for the VST picker.
 *
 * Families are ordered INSTRUMENTS, AUDIO EFFECTS, MIDI EFFECTS,
 * UTILITIES/ANALYZERS, OTHER/UNKNOWN. Classification is driven by the
 * scanner-provided `role` metadata — never by filename. Each family is sorted
 * alphabetically by plugin name, and empty families are dropped so the picker
 * only shows categories that actually contain plugins.
 */
export const PLUGIN_FAMILIES = [
  { id: 'instruments', label: 'INSTRUMENTS', roles: ['instrument'] },
  { id: 'audio-effects', label: 'AUDIO EFFECTS', roles: ['audio-effect'] },
  { id: 'midi-effects', label: 'MIDI EFFECTS', roles: ['midi-effect'] },
  { id: 'utilities', label: 'UTILITIES / ANALYZERS', roles: ['utility', 'analyzer'] },
  { id: 'other', label: 'OTHER / UNKNOWN', roles: [] }
];

/** Group scanned plugins into ordered, alphabetized, non-empty families. */
export function groupPluginsByFamily(plugins) {
  const buckets = PLUGIN_FAMILIES.map((f) => ({ ...f, plugins: [] }));
  const other = buckets[buckets.length - 1];
  for (const p of plugins || []) {
    const role = String((p && p.role) || '').toLowerCase();
    let placed = false;
    for (const bucket of buckets) {
      if (bucket.roles.includes(role)) {
        bucket.plugins.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) other.plugins.push(p);
  }
  for (const bucket of buckets) {
    bucket.plugins.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return buckets.filter((b) => b.plugins.length > 0);
}

/**
 * Deep-duplicate a VST chain `content` object ({ plugins: [] }) for a new
 * node. Preserves plugin order, role, bypass and configuration state, but
 * generates NEW internal plugin-instance IDs so the copy is fully independent.
 * Runtime/native plugin handles are never copied (only serializable state).
 */
export function duplicateVstContent(content) {
  const src = content && Array.isArray(content.plugins) ? content.plugins : [];
  // External CONTROL cables are not duplicated, and copied plugins receive
  // fresh instance ids. Starting without bindings prevents the new node from
  // inheriting a stale target that only looks similar to the source chain.
  const copy = { plugins: [], controlBindings: [] };
  const chain = new VstChain(copy);
  // Seed the copy's ID sequence above the source's max so every copied plugin
  // gets a fresh, distinct instance ID (never reused from the source).
  let maxSeq = 0;
  for (const p of src) {
    const m = /^plugin-(\d+)$/.exec(String(p.id));
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  if (Number.isSafeInteger(content?.nextPluginInstanceSeq)) {
    maxSeq = Math.max(maxSeq, content.nextPluginInstanceSeq);
  }
  chain._seq = maxSeq;
  for (const p of src) {
    const plugin = chain.append({
      pluginId: p.pluginId ?? null,
      name: p.name ?? 'Plugin',
      role: p.role,
      state: p.state ? JSON.parse(JSON.stringify(p.state)) : null
    });
    plugin.bypassed = !!p.bypassed;
  }
  return copy;
}

/**
 * Ordered plugin chain bound to a VST node's `content` object.
 *
 * Mutations affect only the internal chain and never touch `hub.graph`.
 * `onChange` (optional) is invoked after each mutation so the owner can
 * persist. Plugin instance IDs are stable and unique within the chain; the
 * counter is derived from existing plugins so reloads never collide.
 */
export class VstChain {
  constructor(content, onChange) {
    if (!content || typeof content !== 'object') {
      throw new Error('VstChain requires a content object');
    }
    if (!Array.isArray(content.plugins)) content.plugins = [];
    this.content = content;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this._seq = Number.isSafeInteger(this.content.nextPluginInstanceSeq)
      && this.content.nextPluginInstanceSeq >= 0
      ? this.content.nextPluginInstanceSeq
      : 0;
    for (const p of this.content.plugins) {
      const m = /^plugin-(\d+)$/.exec(String(p.id));
      if (m) this._seq = Math.max(this._seq, Number(m[1]));
    }
  }

  get plugins() {
    return this.content.plugins;
  }

  count() {
    return this.plugins.length;
  }

  append(opts) {
    const plugin = this._makePlugin(opts);
    this.plugins.push(plugin);
    this._changed();
    return plugin;
  }

  insert(index, opts) {
    const plugin = this._makePlugin(opts);
    const i = this._clampIndex(index);
    this.plugins.splice(i, 0, plugin);
    this._changed();
    return plugin;
  }

  remove(id) {
    const i = this.plugins.findIndex((p) => p.id === id);
    if (i === -1) return false;
    this.plugins.splice(i, 1);
    this._changed();
    return true;
  }

  reorder(id, toIndex) {
    const from = this.plugins.findIndex((p) => p.id === id);
    if (from === -1) return false;
    const [plugin] = this.plugins.splice(from, 1);
    const i = this._clampIndex(toIndex);
    this.plugins.splice(i, 0, plugin);
    this._changed();
    return true;
  }

  setBypass(id, bypassed) {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) return false;
    p.bypassed = !!bypassed;
    this._changed();
    return true;
  }

  _makePlugin({ pluginId, name, role, state } = {}) {
    this._seq += 1;
    return {
      id: `plugin-${this._seq}`,
      pluginId: pluginId ?? null,
      name: name ?? 'Plugin',
      role: getVstRole(role).id,
      bypassed: false,
      state: state ?? null
    };
  }

  _clampIndex(i) {
    return Math.max(0, Math.min(this.plugins.length, Number.isFinite(i) ? i : this.plugins.length));
  }

  _changed() {
    // Persist the high-water mark independently of the live plugin list. This
    // is the tombstone that prevents a deleted highest-numbered ID from being
    // reused after a remount or application restart.
    this.content.nextPluginInstanceSeq = this._seq;
    if (this.onChange) this.onChange();
  }
}
