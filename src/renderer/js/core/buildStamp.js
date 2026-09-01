/**
 * Build stamp — a visible, timestamped identifier so we can confirm the running
 * app is the exact build/code that was tested. Shown in the UI and recorded in
 * the startup diagnostic log.
 */
export const BUILD_STAMP = {
  version: '0.1.0',
  build: 'full-application-gauntlet-20260824',
  timestamp: '2026-08-24T02:10:52Z',
  stamp: 'mlh-full-application-gauntlet-20260824-01'
};

export function buildStampLabel() {
  return `MiniLab Hub ${BUILD_STAMP.version} · ${BUILD_STAMP.stamp}`;
}
