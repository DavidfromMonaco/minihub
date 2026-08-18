/**
 * Header device status. Reflects MiniLab connection state.
 */
export function buildHeader(hub, statusEl) {
  const update = () => {
    const connected = hub.midi.isMiniLabConnected();
    if (hub.midi.state === 'unavailable') {
      statusEl.textContent = 'MIDI unavailable';
      statusEl.className = 'device-status idle';
    } else if (connected) {
      statusEl.textContent = 'MiniLab 3 connected';
      statusEl.className = 'device-status ok';
    } else {
      statusEl.textContent = 'No MiniLab 3 detected';
      statusEl.className = 'device-status idle';
    }
  };

  hub.events.on('midi:ports', update);
  hub.events.on('midi:state', update);
  update();
}
