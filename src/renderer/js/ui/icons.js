/** Minimal inline SVG icon set (stroke-based, currentColor). */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  keyboard:
    '<rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 11h.01M10 11h.01M14 11h.01M18 11h.01M8 14h8"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  cable:
    '<path d="M4 12h4l2-5 4 10 2-5h4"/><circle cx="4" cy="12" r="1.6"/><circle cx="20" cy="12" r="1.6"/>',
  chip:
    '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  video:
    '<rect x="2" y="6" width="13" height="12" rx="2"/><path d="m15 10 5-3v10l-5-3"/>',
  image:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-5-5-5 5-3-3-5 5"/>',
  sequencer:
    '<path d="M2 12h3l2-7 4 14 2-7 3 0"/>',
  instrument:
    '<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 11h.01M11 11h.01M15 11h.01M19 11h.01M9 14h6"/>',
  'audio-effect':
    '<path d="M3 12h3l2-5 3 10 2-7 3 2"/>',
  'midi-effect':
    '<circle cx="6" cy="12" r="2"/><path d="M8 12h8M14 9l4 3-4 3"/>',
  utility:
    '<path d="M4 20V10M9 20V6M14 20V13M19 20V4"/>',
  unknown:
    '<path d="M9 9a3 3 0 1 1 4 2.83c-.6.3-1 .9-1 1.67"/><path d="M12 17h.01"/>',
  speaker:
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 10v4M12 8v8M15 10v4M18 8v8"/>',
  preset: '<path d="M6 3h12v18l-6-4-6 4Z"/><path d="M9 8h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 12v4"/>'
};

export function icon(name, size = 18) {
  const body = ICONS[name] || ICONS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
