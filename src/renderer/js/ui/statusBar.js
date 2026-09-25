/**
 * The status bar: whether the audio engine runs, and on what.
 *
 * The controller's line beside it is written by `ui/header.js`, which has
 * always owned it; it moved down here with the title bar (D-055) because the
 * header became the top of the window and has room for the transport only.
 *
 * Both values arrive on events the engine client already emits -- its state on
 * `engine:state`, the device on `engine:deviceState` -- and are read once at
 * start, since the engine may be running before the shell is built. Written
 * with `textContent`: a device name is a string Windows made up (invariant 9).
 */
export function engineStatusText(state, deviceState) {
  if (state === 'running' && deviceState?.running !== false) return { text: 'Audio engine running', level: 'ok' };
  if (state === 'running') return { text: 'Audio engine running, no audio device', level: 'warn' };
  if (state === 'starting') return { text: 'Audio engine starting', level: 'idle' };
  if (state === 'error') return { text: 'Audio engine stopped on an error', level: 'danger' };
  return { text: 'Audio engine stopped', level: 'idle' };
}

/** "Speakers (Realtek) · 48 kHz · 256 samples", or '' when nothing is open. */
export function audioDeviceText(deviceState) {
  if (!deviceState?.running || !deviceState.device) return '';
  const parts = [String(deviceState.device)];
  const rate = Number(deviceState.sampleRate);
  if (Number.isFinite(rate) && rate > 0) {
    const khz = rate / 1000;
    parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`);
  }
  const buffer = Number(deviceState.bufferSize);
  if (Number.isSafeInteger(buffer) && buffer > 0) parts.push(`${buffer} samples`);
  return parts.join(' · ');
}

export function buildStatusBar(hub, { engineEl, deviceEl } = {}) {
  const render = () => {
    const status = engineStatusText(hub.engine?.state, hub.engine?.deviceState);
    if (engineEl) {
      engineEl.textContent = status.text;
      engineEl.className = `engine-status ${status.level}`;
      engineEl.title = hub.engine?.error ? `${status.text}: ${hub.engine.error}` : status.text;
    }
    if (deviceEl) {
      const text = audioDeviceText(hub.engine?.deviceState);
      deviceEl.textContent = text;
      deviceEl.title = text;
    }
  };
  const off = ['engine:state', 'engine:deviceState'].map((name) => hub.events.on(name, render));
  render();
  return () => off.forEach((dispose) => (typeof dispose === 'function' ? dispose() : undefined));
}
