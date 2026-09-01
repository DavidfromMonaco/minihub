import { DEFAULT_MASTER_OUTPUT, MASTER_OUTPUT_KEY, normalizeMasterOutput } from './masterOutput.js';
import { PROJECT_KEYS } from './projectKeys.js';

const STAGED_KEY = 'minihub.stagedProject';
export const PROJECT_WORKSPACE_MODULE = 'routing';
const newId = () => globalThis.crypto?.randomUUID?.() || `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const shouldConsumeStagedProject = (navigationType) => navigationType === 'reload';

export class ProjectManager {
  constructor(hub, api) {
    Object.assign(this, { hub, api, currentProjectPath: null, currentProjectName: 'Untitled', projectId: newId(), createdAt: new Date().toISOString(), dirty: false, _loading: true, _transitionPending: false });
  }
  bootstrap() {
    this.hub.settings.projectMode = true;
    let staged = null;
    const navigation = performance.getEntriesByType?.('navigation')?.[0];
    const isRendererReload = shouldConsumeStagedProject(navigation?.type);
    // A staged project is an in-window handoff used only by _replace().
    // Chromium may preserve sessionStorage across a full application restart;
    // parsing a project containing multi-megabyte VST chunks blocked Home for
    // seconds and incorrectly rebuilt the last musical session. Normal launch
    // discards that stale handoff without reading or parsing it.
    if (isRendererReload) {
      try { staged = JSON.parse(sessionStorage.getItem(STAGED_KEY) || 'null'); } catch (_) {}
    }
    sessionStorage.removeItem(STAGED_KEY);
    if (staged?.project) { this.applySnapshot(staged.project, staged.filePath || null); this.initialModule = staged.targetModule || PROJECT_WORKSPACE_MODULE; if (staged.unsaved) this.dirty = true; }
    else {
      // Legacy global session snapshots are not projects and must not rebuild
      // nodes/VSTs merely because Home opened. Machine preferences and cached
      // recent-project metadata remain in the application settings object.
      for (const key of PROJECT_KEYS) delete this.hub.settings.data[key];
    }
    this.publish();
  }
  finishBootstrap() { this._loading = false; this.publish(); }
  applySnapshot(project, filePath) {
    const graph = project.graph || {};
    Object.assign(this.hub.settings.data, { nodeInstances: project.nodeInstances, graphConnections: graph.connections || [], graphLayout: graph.layout || {}, graphViewport: graph.viewport || null, transportBpm: project.transport?.bpm || 120, sequencerState: project.sequencer || null, [MASTER_OUTPUT_KEY]: normalizeMasterOutput(project.master) });
    Object.assign(this, { projectId: project.projectId, currentProjectName: project.name, createdAt: project.createdAt, currentProjectPath: filePath, dirty: false });
  }
  markDirty() { if (!this._loading && !this.dirty) { this.dirty = true; this.publish(); } }
  publish() {
    const state = { currentProjectPath: this.currentProjectPath, currentProjectName: this.currentProjectName, dirty: this.dirty };
    this.hub.events.emit('project:identity', state);
    // The BrowserWindow owns the operating-system close button. Keep its
    // close guard synchronized with the renderer's canonical project identity
    // instead of trying to infer dirty state from settings writes in main.
    try { this.api.projectSetDirty?.(state.dirty); } catch (_) {}
  }
  _blockWhileRecording(action = 'change project') {
    if (!this.hub.sequencer?.recording) return false;
    return this._notifyRecordingBlock(action);
  }
  _notifyRecordingBlock(action = 'change project') {
    const message = `Cannot ${action} while recording. Stop recording first.`;
    this.hub.events?.emit?.('project:blocked', {
      reason: 'recording-active', action, message
    });
    globalThis.alert?.(message);
    return true;
  }
  _confirmDiscardChanges(action = 'replace the current project') {
    if (!this.dirty) return true;
    const message = `"${this.currentProjectName}" has unsaved changes. Discard them and ${action}?`;
    const confirmed = typeof globalThis.confirm === 'function' && globalThis.confirm(message) === true;
    if (!confirmed) {
      this.hub.events?.emit?.('project:blocked', {
        reason: 'unsaved-changes', action, message
      });
    }
    return confirmed;
  }
  snapshot({ name = this.currentProjectName } = {}) {
    return { format: 'minihub-project', version: 1, projectId: this.projectId, name, createdAt: this.createdAt, modifiedAt: new Date().toISOString(), graph: { connections: this.hub.graph.serialize(), layout: this.hub.settings.get('graphLayout') || {}, viewport: this.hub.settings.get('graphViewport') || null }, nodeInstances: this.hub.settings.get('nodeInstances') || { instances: [], idSeq: {} }, transport: { bpm: Number(this.hub.settings.get('transportBpm')) || 120 }, master: normalizeMasterOutput(this.hub.settings.get(MASTER_OUTPUT_KEY)), sequencer: this.hub.sequencer?.model.snapshot() || this.hub.settings.get('sequencerState') || null };
  }
  async save(as = false) {
    let capture;
    try {
      capture = await this.api.capturePluginStates();
    } catch (error) {
      const message = `Could not capture VST state before saving: ${error?.message || String(error)}`;
      this.hub.events?.emit?.('project:save-error', { reason: 'plugin-state-capture-failed', message });
      globalThis.alert?.(message);
      return false;
    }
    if (capture !== true && capture?.ok !== true) {
      const reason = capture?.reason || 'audio engine did not confirm state capture';
      const message = `Could not capture VST state before saving: ${reason}`;
      this.hub.events?.emit?.('project:save-error', { reason: 'plugin-state-capture-failed', message });
      globalThis.alert?.(message);
      return false;
    }
    // Native emits every state chunk before its completion marker. Give those
    // already-enqueued renderer events one turn before taking the snapshot.
    await new Promise((r) => setTimeout(r, 80));
    let filePath = as ? null : this.currentProjectPath;
    if (!filePath) filePath = await this.api.projectPickSave(this.currentProjectName);
    if (!filePath) return false;
    const nextProjectName = (!this.currentProjectPath || as)
      ? (filePath.split(/[\\/]/).pop().replace(/\.minihub$/i, '') || this.currentProjectName)
      : this.currentProjectName;
    const result = await this.api.projectWrite(filePath, this.snapshot({ name: nextProjectName }));
    if (!result?.ok) { alert(`Could not save project: ${result?.error || 'unknown error'}`); return false; }
    this.currentProjectPath = filePath; this.currentProjectName = nextProjectName; this.dirty = false;
    await this.hub.settings.setMany({ recentProjectPath: filePath, recentProjectName: this.currentProjectName }); this.publish(); return true;
  }
  async load(filePath = null) {
    if (this._blockWhileRecording('load a project')) return false;
    if (!this._confirmDiscardChanges('load another project')) return false;
    const chosen = filePath || await this.api.projectPickOpen(); if (!chosen) return false;
    // Record may have started while the native picker was open. Do not even
    // read a candidate project once a take is active.
    if (this._blockWhileRecording('load a project')) return false;
    const result = await this.api.projectRead(chosen);
    // A direct Load can also race with Record while disk I/O is in flight.
    // Reading is harmless; staging/reloading the renderer is not.
    if (this._blockWhileRecording('load a project')) return false;
    if (!result?.ok) { if (filePath) await this.hub.settings.setMany({ recentProjectPath: null, recentProjectName: null }); alert(`Could not load project: ${result?.error || 'unknown error'}`); return false; }
    return this._replace(result.project, chosen, false, { discardApproved: true });
  }
  async newProject() {
    if (this._blockWhileRecording('create a new project')) return false;
    if (!this._confirmDiscardChanges('create a new project')) return false;
    const now = new Date().toISOString();
    return this._replace({ format: 'minihub-project', version: 1, projectId: newId(), name: 'Untitled', createdAt: now, modifiedAt: now, graph: { connections: [], layout: {}, viewport: null }, nodeInstances: { instances: [], idSeq: {} }, transport: { bpm: 120 }, master: { ...DEFAULT_MASTER_OUTPUT } }, null, true, { discardApproved: true });
  }
  async newFromBasicTemplate() {
    if (this._blockWhileRecording('create a new project')) return false;
    if (!this._confirmDiscardChanges('create a project from the Basic template')) return false;
    const now = new Date().toISOString();
    const project = { format: 'minihub-project', version: 1, projectId: newId(), name: 'Basic', createdAt: now, modifiedAt: now, graph: { connections: [], layout: {}, viewport: null }, nodeInstances: { instances: [], idSeq: {} }, transport: { bpm: 120 }, master: { ...DEFAULT_MASTER_OUTPUT } };
    return this._replace(project, null, true, { discardApproved: true });
  }
  async _replace(project, filePath, unsaved = false, { discardApproved = false } = {}) {
    if (this._blockWhileRecording()) return false;
    if (!discardApproved && !this._confirmDiscardChanges('replace the current project')) return false;
    // Stage the complete handoff before touching the current native runtime.
    // sessionStorage can fail (quota, disabled storage, serialization); in that
    // case the old project must remain fully playable rather than being left
    // on screen after its Sequencer/VST runtime has already been destroyed.
    let stagedPayload;
    try {
      stagedPayload = JSON.stringify({ project, filePath, unsaved, targetModule: PROJECT_WORKSPACE_MODULE });
      sessionStorage.setItem(STAGED_KEY, stagedPayload);
    } catch (error) {
      const message = `Could not prepare the project transition: ${error?.message || String(error)}`;
      this.hub.events?.emit?.('project:transition-error', { reason: 'project-staging-failed', message });
      globalThis.alert?.(message);
      return false;
    }
    // A project handoff reloads the renderer but deliberately keeps the native
    // engine process alive. Quiesce the project-wide Sequencer state before
    // tearing down individual chains so a recording, transport clock or
    // physical MIDI note cannot survive into the replacement project.
    // One native lifecycle command also cancels any active master export
    // without letting it restore the old project's transport afterward.
    this._transitionPending = true;
    this.hub.sequencer?.beginProjectTransition?.();
    let reloadCommitted = false;
    let quiesceAttempted = false;
    try {
      // Clip editors are views over this renderer's canonical project model.
      // Close them before the handoff so no delayed editor event can target
      // the replacement project, even if it happens to reuse a clip ID.
      await Promise.resolve(this.api.clipEditorCloseAll?.('project-transition')).catch(() => {});
      quiesceAttempted = true;
      const quiesced = await this.hub.engine.sequencerQuiesce();
      // Record may have been activated by an external/native source while the
      // quiesce acknowledgement was in flight. Never stage or reload over it.
      if (quiesced?.wasRecording) {
        this._notifyRecordingBlock();
        return false;
      }
      if (this._blockWhileRecording()) return false;
      // Ask Chromium to commit the already-staged handoff before destructive
      // teardown. reload() schedules navigation synchronously; if it throws,
      // the finally block can restore the quiesced old project with every VST
      // instance still present.
      location.reload();
      reloadCommitted = true;
      // Tear down current runtime instances after navigation is committed.
      // The current JS stack finishes before the new renderer bootstraps, so
      // old chains cannot race the replacement project's reconstruction.
      for (const node of this.hub.nodes.list()) {
        if (node.type !== 'vst') continue;
        this.hub.engine.setChainMidiEnabled(node.id, false);
        this.hub.engine.setChainOutputEnabled(node.id, false);
        for (const plugin of node.content?.plugins || []) this.hub.engine.removeInstance(node.id, plugin.id);
      }
      return true;
    } finally {
      this._transitionPending = false;
      this.hub.sequencer?.finishProjectTransition?.(reloadCommitted);
      // A late Record, native failure, or staging failure can abort after the
      // main process has latched editor creation closed. The current renderer
      // remains authoritative in that case, so explicitly reopen its editor
      // lifecycle instead of leaving Clip Editors disabled until restart.
      if (!reloadCommitted) {
        sessionStorage.removeItem?.(STAGED_KEY);
        // Quiesce clears the native Sequencer plan even when a late Record or
        // reload failure aborts the handoff. Republish the still-authoritative
        // old model before reopening editor creation.
        if (quiesceAttempted) this.hub.sequencer?.syncNative?.();
        await Promise.resolve(this.api.clipEditorReady?.()).catch(() => {});
      }
    }
  }
}
export { PROJECT_KEYS };
