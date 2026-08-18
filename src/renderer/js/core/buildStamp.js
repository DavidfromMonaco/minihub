/**
 * Build stamp — a visible, timestamped identifier so we can confirm the running
 * app is the exact build/code that was tested. Shown in the UI and recorded in
 * the startup diagnostic log.
 */
export const BUILD_STAMP = {
  version: '0.1.0',
  build: 'dev-20260818',
  timestamp: '2026-08-18T12:00:00Z',
  stamp: 'mlh-dev-20260818-01'
};

export function buildStampLabel() {
  return `MiniLab Hub ${BUILD_STAMP.version} · ${BUILD_STAMP.stamp}`;
}
