import { bindTempoInput } from '../core/tempoControl.js';
import { controllerName } from '../core/controllerNode.js';
import { barBeat, normalizeSignature } from '../core/musicalTime.js';
import { installExportPanel } from './exportPanel.js';

/**
 * Header device status. Reflects the controller's connection state.
 */
export function buildHeader(hub, statusEl) {
  /**
   * The open project's name, where the product's name used to be.
   *
   * It was a second, grey label at the far right while the left said
   * "MiniHub" -- the one thing on screen that never changes. A workstation's
   * top left names the work. The tooltip carries the whole name, since a long
   * one is cut short to leave the transport its room.
   */
  const projectEl = document.getElementById('project-identity');
  const renderProject = (state) => {
    if (!projectEl) return;
    projectEl.textContent = `${state.currentProjectName}${state.dirty ? ' •' : ''}`;
    projectEl.title = state.dirty ? `${state.currentProjectName} — unsaved changes` : state.currentProjectName;
  };
  hub.events.on('project:identity', renderProject);
  renderProject(hub.project);
  /**
   * Undo and Redo, disabled when there is nothing behind or ahead.
   *
   * The shell is the one surface that is on screen whatever page you are on, so
   * it is where the history becomes VISIBLE -- the keyboard answers everywhere
   * but says nothing about whether there is anything to answer with. The state
   * arrives on `history:changed`, which the history already emits on every step,
   * every undo and every redo.
   */
  const undoEl = document.getElementById('history-undo');
  const redoEl = document.getElementById('history-redo');
  const renderHistory = (state) => {
    if (undoEl) undoEl.disabled = state?.canUndo !== true;
    if (redoEl) redoEl.disabled = state?.canRedo !== true;
  };
  undoEl?.addEventListener('click', () => hub.history?.undo());
  redoEl?.addEventListener('click', () => hub.history?.redo());
  hub.events.on('history:changed', renderHistory);
  // The history starts before the shell is built, so its first announcement is
  // already past. Read it once rather than waiting for the next edit.
  renderHistory(hub.history);

  /**
   * The transport, and why the whole cluster is in the shell.
   *
   * Play and Stop were here already; moving the playhead was not, and it is
   * needed exactly where the arrangement is not on screen -- inside a One Ring
   * node, a plugin's page, the Patch Bay. A workstation's transport bar is
   * global for that reason, and it carries the position for the same one:
   * "where am I" has no other answer once you have left the timeline.
   *
   * Play doubles as Pause while it plays, which is what every transport does
   * and what keeps a crowded header to two text buttons. The two are not the
   * same command: a pause holds the arrangement and leaves a One Ring running
   * on its own clock, a Stop stops both.
   */
  const playEl = document.getElementById('transport-play');
  const stopEl = document.getElementById('transport-stop');
  const recordEl = document.getElementById('transport-record');
  const bpmEl = document.getElementById('transport-bpm');
  const numeratorEl = document.getElementById('transport-signature-numerator');
  const denominatorEl = document.getElementById('transport-signature-denominator');
  const positionEl = document.getElementById('transport-position');
  const scopeEl = document.getElementById('transport-scope');
  const navEls = {
    start: document.getElementById('transport-start'),
    back: document.getElementById('transport-back'),
    forward: document.getElementById('transport-forward'),
    end: document.getElementById('transport-end')
  };
  let playing = false;
  // A One Ring node plays on when a sequence stops the transport, and runs
  // alone from its own RUN. Stop stays pressable while one plays, and stops it.
  let oneRingPlaying = false;
  // So does an Audio Player started from its own page: Stop takes it back to
  // its start.
  let playerPlaying = false;
  if (bpmEl) bpmEl.value = String(hub.sequencer.tempo);
  const renderTransport = () => {
    playEl?.classList.toggle('playing', playing);
    // Drawn, not written: the button holds a play and a pause glyph and the
    // `playing` class shows one. Its name moves to aria-label with the state.
    if (playEl) {
      playEl.title = playing ? 'Pause — a One Ring keeps running' : 'Play';
      playEl.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      playEl.setAttribute('aria-pressed', String(playing));
    }
    if (stopEl) stopEl.disabled = !playing && hub.sequencer?.recording !== true && !oneRingPlaying && !playerPlaying;
    positionEl?.classList.toggle('playing', playing);
  };
  /**
   * The position, at the engine's own 10 Hz, written only when it changes.
   *
   * `sequencer:playhead` fires on every transport event, so this runs ten
   * times a second for as long as MiniHub is open. Comparing before writing
   * keeps that to four writes a bar at 120 BPM -- and nothing here logs, which
   * on a periodic event is what buries a startup log (see engineEventTrace).
   */
  let lastPpq = hub.sequencer?.playheadPpq ?? 0;
  const renderPosition = (ppq) => {
    lastPpq = ppq;
    if (!positionEl) return;
    const text = barBeat(ppq, hub.sequencer?.signature);
    if (positionEl.textContent !== text) positionEl.textContent = text;
  };
  const renderOneRing = () => {
    const now = hub.oneRing?.anyPlaying?.() === true;
    if (now === oneRingPlaying) return;
    oneRingPlaying = now;
    renderTransport();
  };
  for (const name of ['oneRing:status', 'oneRing:ready', 'oneRing:gone']) hub.events.on(name, renderOneRing);
  const renderPlayers = () => {
    const now = hub.audioPlayers?.anyPlaying?.() === true;
    if (now === playerPlaying) return;
    playerPlaying = now;
    renderTransport();
  };
  for (const name of ['audioPlayer:status', 'audioPlayer:gone']) hub.events.on(name, renderPlayers);
  /**
   * Record, beside Play and Stop, reachable from every page.
   *
   * It lived in the Sequencer's own toolbar, which only exists while that page
   * is on screen: arming a track on the Sequencer and then going to a VST's
   * page to play left no Record in reach. The author moved it here on
   * 2026-09-24, with the Sequencer's other transport buttons removed.
   *
   * It keeps what the Sequencer's button said. Red while a take runs. Amber,
   * and still pressable, when a take cannot start -- pressing it is how the
   * reason is shown -- with that reason as its tooltip. The reason depends on
   * tracks, cables, MIDI ports and the audio device, so it is asked again
   * whenever any of those moves.
   */
  const renderRecord = () => {
    if (!recordEl) return;
    const recording = hub.sequencer?.recording === true;
    const blocked = recording ? '' : (hub.sequencer?.recordBlockReason?.() || '');
    recordEl.classList.toggle('recording', recording);
    recordEl.classList.toggle('blocked', Boolean(blocked));
    recordEl.disabled = recording;
    recordEl.title = recording ? 'Recording — press Stop to finish and keep the take' : (blocked || 'Start recording');
    recordEl.setAttribute('aria-pressed', String(recording));
  };
  recordEl?.addEventListener('click', () => hub.sequencer?.startRecording({ notify: true }));
  for (const name of ['sequencer:recording', 'sequencer:changed', 'sequencer:count-in', 'network:change',
    'midi:ports', 'midi:preference', 'engine:deviceState']) hub.events.on(name, renderRecord);
  playEl?.addEventListener('click', () => {
    if (playing) hub.sequencer?.pauseTransport();
    else hub.sequencer?.playTransport();
  });
  stopEl?.addEventListener('click', () => {
    hub.sequencer?.stopTransport();
  });
  // Seeking is allowed stopped or playing: the engine releases what it holds on
  // a seek, so stepping through an arrangement cannot leave a note sounding.
  navEls.start?.addEventListener('click', () => hub.sequencer?.goToStart());
  navEls.back?.addEventListener('click', () => hub.sequencer?.nudgeBars(-1));
  navEls.forward?.addEventListener('click', () => hub.sequencer?.nudgeBars(1));
  navEls.end?.addEventListener('click', () => hub.sequencer?.goToEnd());
  hub.events.on('sequencer:playhead', renderPosition);
  hub.events.on('sequencer:recording', (active) => {
    if (active === true) playing = true;
    renderTransport();
  });
  hub.events.on('sequencer:transport', (state) => {
    if (typeof state?.playing !== 'boolean') return;
    playing = state.playing;
    renderTransport();
  });
  /**
   * What Play plays. Anything but All is marked, so a Play that leaves half
   * the project silent is never a mystery the next day.
   */
  const renderScope = (scope) => {
    if (!scopeEl) return;
    if (scopeEl.value !== scope) scopeEl.value = scope;
    scopeEl.classList.toggle('scoped', scope !== 'all');
  };
  scopeEl?.addEventListener('change', () => renderScope(hub.sequencer?.setPlayScope(scopeEl.value) ?? 'all'));
  hub.events.on('sequencer:playScope', renderScope);
  renderScope(hub.sequencer?.playScope ?? 'all');
  // Export, after what Play plays: it prints exactly that (D-056).
  installExportPanel(hub, document.getElementById('transport-export'));
  bindTempoInput(bpmEl, (tempo) => hub.sequencer.setTempo(tempo));
  hub.events.on('sequencer:tempo', (tempo) => {
    if (bpmEl && bpmEl.value !== String(tempo)) bpmEl.value = String(tempo);
  });
  /**
   * The project's time signature (D-059), beside the tempo as other
   * workstations put it. It is the arrangement's, so it is saved, reopened
   * and undone with the project; the two lists only show and send it. A
   * value that is not a signature -- which the lists cannot offer, but a
   * stale page could send -- puts them back on the one in force rather than
   * being repaired into another.
   */
  const renderSignature = (signature = hub.sequencer?.signature) => {
    const { numerator, denominator } = normalizeSignature(signature);
    if (numeratorEl && numeratorEl.value !== String(numerator)) numeratorEl.value = String(numerator);
    if (denominatorEl && denominatorEl.value !== String(denominator)) denominatorEl.value = String(denominator);
    // The position is written in bars: new bars, new position.
    renderPosition(lastPpq);
  };
  const commitSignature = () => {
    const next = normalizeSignature(
      { numerator: Number(numeratorEl?.value), denominator: Number(denominatorEl?.value) },
      hub.sequencer?.signature
    );
    renderSignature(hub.sequencer?.setSignature?.(next) ?? next);
  };
  numeratorEl?.addEventListener('change', commitSignature);
  denominatorEl?.addEventListener('change', commitSignature);
  hub.events.on('sequencer:signature', renderSignature);
  renderSignature();
  hub.events.on('engine:transport',(state)=>{if(typeof state?.playing!=='boolean')return;playing=state.playing;renderTransport();});
  renderTransport();
  renderRecord();
  // The engine's first position report is 100 ms away at best, and a reload
  // lands on whatever the transport already holds -- not necessarily bar one.
  renderPosition(hub.sequencer?.playheadPpq ?? 0);
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
  // "Is any keyboard MiniHub knows about listening?" -- `isMiniLabConnected()`
  // asks whether a port LOOKS LIKE a MiniLab, which answers no for every other
  // device ever profiled. `midiManager` arms one cable per loaded profile, so an
  // armed cable is a keyboard answering, whatever it is called. The old call
  // stays as the fallback for a manager that predates the arming.
  const update = () => {
    const connected = hub.midi.armedByProfile
      ? hub.midi.armedByProfile.size > 0
      : hub.midi.isMiniLabConnected();
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
    // A narrow window cuts the pill short; the tooltip keeps the whole sentence.
    statusEl.title = statusEl.textContent;
  };

  hub.events.on('midi:ports', update);
  hub.events.on('midi:state', update);
  update();
}
