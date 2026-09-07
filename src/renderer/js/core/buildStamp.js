/**
 * Build stamp — a visible, timestamped identifier so we can confirm the running
 * app is the exact build/code that was tested. Shown in the UI and recorded in
 * the startup diagnostic log.
 */
export const BUILD_STAMP = {
  version: '0.2.0',
  build: 'release-0.2.0',
  timestamp: '2026-09-07T10:11:05Z',
  stamp: 'mlh-release-0.2.0-20260907'
};

export function buildStampLabel() {
  return `MiniLab Hub ${BUILD_STAMP.version} · ${BUILD_STAMP.stamp}`;
}
