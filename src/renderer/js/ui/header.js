import { bindTempoInput } from '../core/tempoControl.js';
import { controllerName } from '../core/controllerNode.js';

/**
 * Header device status. Reflects the controller's connection state.
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
  // The device is named by its Patch Bay node, never by this file: a header
  // that spells a model tells every other keyboard it is not detected. It is
  // also the same string the sequencer's blocking messages use, which is the
  // whole point of taking it from the same place -- one name, or the user is
  // sent to look for a card that is called something else.
  //
  // `controllerName` answers null when there is no single node to name, and the
  // generic wording is what a shell says when it has no name to say. Written
  // with `textContent`, which is what keeps a name that now comes from a
  // profile file out of the parser (invariant 9).
  const update = () => {
    const connected = hub.midi.isMiniLabConnected();
    const device = controllerName(hub.network);
    if (hub.midi.state === 'unavailable') {
      statusEl.textContent = 'MIDI unavailable';
      statusEl.className = 'device-status idle';
    } else if (connected) {
      statusEl.textContent = device ? `${device} connected` : 'Controller connected';
      statusEl.className = 'device-status ok';
    } else {
      statusEl.textContent = device ? `No ${device} detected` : 'No controller detected';
      statusEl.className = 'device-status idle';
    }
  };

  hub.events.on('midi:ports', update);
  hub.events.on('midi:state', update);
  update();
}
