import { bindTempoInput } from '../core/tempoControl.js';

/**
 * Header device status. Reflects MiniLab connection state.
 */
export function buildHeader(hub, statusEl) {
  const projectEl = document.getElementById('project-identity');
  const renderProject = (state) => { if (projectEl) projectEl.textContent = `${state.currentProjectName}${state.dirty ? ' •' : ''}`; };
  hub.events.on('project:identity', renderProject);
  renderProject(hub.project);
  document.getElementById('project-save')?.addEventListener('click', () => hub.project.save(false));
  document.getElementById('project-save-as')?.addEventListener('click', () => hub.project.save(true));
  const playEl = document.getElementById('transport-play');
  const stopEl = document.getElementById('transport-stop');
  const bpmEl = document.getElementById('transport-bpm');
  let playing = false;
  if (bpmEl) bpmEl.value = String(hub.sequencer.tempo);
  const renderTransport = () => {
    playEl?.classList.toggle('playing', playing);
    if (playEl) playEl.textContent = 'Play';
    if (stopEl) stopEl.disabled = !playing && hub.sequencer?.recording !== true;
  };
  playEl?.addEventListener('click', () => {
    hub.sequencer?.playTransport();
  });
  stopEl?.addEventListener('click', () => {
    hub.sequencer?.stopTransport();
  });
  hub.events.on('sequencer:recording', (active) => {
    if (active === true) playing = true;
    renderTransport();
  });
  hub.events.on('sequencer:transport', (state) => {
    if (typeof state?.playing !== 'boolean') return;
    playing = state.playing;
    renderTransport();
  });
  bindTempoInput(bpmEl, (tempo) => hub.sequencer.setTempo(tempo));
  hub.events.on('sequencer:tempo', (tempo) => {
    if (bpmEl && bpmEl.value !== String(tempo)) bpmEl.value = String(tempo);
  });
  hub.events.on('engine:transport',(state)=>{if(typeof state?.playing!=='boolean')return;playing=state.playing;renderTransport();});
  renderTransport();
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
