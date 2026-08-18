/**
 * Minimal HTML escaping for untrusted text injected into `innerHTML`.
 *
 * Plugin names, vendors and MIDI device names come from disk / hardware, not
 * from us: a plugin called `<img src=x onerror=...>` must render as text, never
 * as markup. Used everywhere such a value reaches a template string.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
