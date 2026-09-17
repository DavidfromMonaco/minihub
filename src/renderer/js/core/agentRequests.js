import { describeSetup, describeWindows } from './agentDescribe.js';
import { getVstParametersForNode } from './vstParameterDiscovery.js';
import { CONTROL_BINDING_VERSION } from './controlBindings.js';
import { updateMasterOutput } from './masterOutput.js';
import { handleOneRingRequest } from './oneRingRequests.js';

/**
 * The one door an outside agent knocks on.
 *
 * WHY THIS FILE OWNS NO BEHAVIOUR
 * -------------------------------
 * INTENT §8 sexies draws the line this file exists to respect: *an operation an
 * agent can ask for is one the interface can already perform.* So every branch
 * below delegates -- to `hub.nodes`, `hub.network`, `hub.sequencer`,
 * `hub.engine` -- and none of them implements anything. A branch that needed
 * its own logic would mean the operation does not exist in the application yet,
 * and the logic belongs in the module that owns it, with the interface calling
 * it too. That is why `appendPlugin` and `removePlugin` were pulled out of the
 * VST panel's click handler rather than copied here: the second copy is the one
 * that forgets `targetInvalidated`.
 *
 * WHY THE ANSWERS LOOK LIKE THE CLIP EDITOR'S
 * -------------------------------------------
 * `{ ok, reason }`, a stale project refused by `expectedProjectId`, a refusal
 * during a project transition. That protocol is not invented here: it is what
 * `SequencerController.handleClipEditorRequest` already answers to a window
 * that lives in another process. An agent is the second client of a shape that
 * already works, and `kind: 'sequencer'` hands its payload straight through to
 * it rather than restating it.
 *
 * WHY A THROW BECOMES A REASON
 * ----------------------------
 * `network.connect()` throws for everything it refuses -- an unknown port,
 * mismatched types, a feedback cycle. Those are the guard rails that make an
 * agent unable to build an illegal patch, so they must arrive as an answer it
 * can read and act on, not as a broken channel.
 */

/** Kinds that change the project, and therefore need a live project id. */
const MUTATING = new Set([
  'create-node', 'delete-node', 'connect', 'disconnect',
  'add-plugin', 'remove-plugin', 'set-parameter', 'move-plugin', 'set-plugin-bypass',
  'add-track', 'remove-track', 'set-track', 'add-clip',
  'set-node-content', 'set-binding', 'clear-binding', 'plugin', 'one-ring', 'patch-bay'
]);

/**
 * Kinds deliberately NOT gated on the project id.
 *
 * Two reasons, both about what the request is ABOUT rather than how careful it
 * is. `transport`, `set-tempo`, `set-master` and the editor windows act on the
 * instrument, not on the authored project: they are what you do WHILE something
 * is open, and refusing to stop a sound because the project changed would be
 * absurd. `project` and `devices` are about changing what is open at all, so a
 * stale id there is the normal case rather than the dangerous one.
 */
const UNGATED = new Set([
  'transport', 'set-tempo', 'set-master', 'open-editor', 'close-editor',
  'project', 'export', 'cancel-export', 'scan-plugins', 'devices',
  'show-window', 'open-clip-editor', 'close-clip-editor', 'browser'
]);

/**
 * What a `browser` request may carry to the main process, by name.
 *
 * Listed rather than spread: main validates each field again, and a request is
 * data an agent wrote, so nothing it did not mean to send should ride along.
 */
const BROWSER_FIELDS = ['operation', 'ref', 'x', 'y', 'count', 'text', 'replace', 'key', 'deltaX', 'deltaY', 'filePath'];

const failed = (reason, message) => (message ? { ok: false, reason, message } : { ok: false, reason });

/** Run a delegate that reports refusal by throwing, and answer with its message. */
function attempt(run) {
  try {
    return run() ? { ok: true } : failed('refused');
  } catch (error) {
    return failed('refused', String(error?.message || error));
  }
}

/**
 * Save, load, new -- the three that change what is open.
 *
 * WHY LOAD AND NEW ANSWER BEFORE THEY ACT
 * ---------------------------------------
 * Both end in `ProjectManager._replace()`, which stages the handoff and calls
 * `location.reload()`. The renderer that would send the answer is the renderer
 * being torn down, so a request that waited for the result would be answered by
 * nobody and would come back thirty seconds later as a timeout. This answers
 * first and acts on the next turn of the loop, saying `reloading` so the caller
 * knows to wait and read the state again -- under a NEW project id.
 *
 * WHY A DIRTY PROJECT IS REFUSED RATHER THAN CONFIRMED
 * ----------------------------------------------------
 * `_confirmDiscardChanges` is a `confirm()`, and a modal raised by a request is
 * a modal nobody was asked to answer: the renderer stops, and the caller waits
 * on a dialog it cannot see. So unsaved work is a refusal to be resolved on
 * purpose -- by saving first, or by saying `discardUnsaved`.
 */
async function projectRequest(hub, request) {
  const operation = String(request.operation || '');
  const project = hub.project;
  if (!project) return failed('unsupported-request');

  if (operation === 'save') {
    const explicit = typeof request.filePath === 'string' ? request.filePath : '';
    if (!explicit && !project.currentProjectPath) {
      return failed('no-path', 'this project has never been saved: pass filePath');
    }
    const result = explicit ? await project.saveTo(explicit) : await project._save({ interactive: false });
    return result?.ok
      ? { ok: true, filePath: project.currentProjectPath, name: project.currentProjectName }
      : { ...failed('save-failed'), message: result?.reason || '' };
  }

  if (operation === 'load' || operation === 'new') {
    if (hub.sequencer?.recording) return failed('recording-active');
    if (project.dirty && request.discardUnsaved !== true) {
      return failed('unsaved-changes', `"${project.currentProjectName}" has unsaved changes`);
    }
    if (operation === 'load' && (typeof request.filePath !== 'string' || !request.filePath)) {
      return failed('no-path', 'load needs an explicit filePath');
    }
    setTimeout(() => {
      if (operation === 'load') project.load(request.filePath, { discardApproved: true });
      else project.newProject({ discardApproved: true });
    }, 0);
    return { ok: true, reloading: true };
  }

  return failed('unsupported-request');
}

/**
 * Quit, the way Exit does.
 *
 * WHY IT ANSWERS BEFORE IT ACTS
 * -----------------------------
 * For `load` and `new` the renderer that would answer is torn down; here it is
 * the whole process. The answer goes out first and the quit follows on the next
 * turn of the loop, so the caller reads `quitting` instead of a dropped
 * connection it cannot tell from a crash.
 *
 * WHY ONLY A PROJECT WITH NO FILE IS REFUSED
 * ------------------------------------------
 * A project with a file is written on the way out, as it is for a person, and
 * `saving` says so. One that has never been saved is where Exit asks a question
 * in a modal (`projectCloseGuard.js`), with nobody there to answer it. That is
 * `unsaved-changes`, resolved by saving to a path first, or by saying
 * `discardUnsaved` -- the dialog's own "Quit without saving".
 */
function quitRequest(hub, request) {
  if (typeof hub.api?.quitApplication !== 'function') return failed('unsupported-request');
  const project = hub.project;
  const dirty = project?.dirty === true;
  const hasFile = Boolean(project?.currentProjectPath);
  if (dirty && !hasFile && request.discardUnsaved !== true) {
    return failed('unsaved-changes',
      `"${project.currentProjectName}" has never been saved: save it to a filePath, or pass discardUnsaved`);
  }
  const discardUnsaved = dirty && !hasFile;
  setTimeout(() => hub.api.quitApplication({ discardUnsaved }), 0);
  return { ok: true, quitting: true, saving: dirty && hasFile };
}

const trackSummary = (track) => ({
  id: track.id, name: track.name, type: track.type,
  outputId: track.outputId || '', muted: track.muted === true, volume: track.volume
});

const endpoint = (value) => (value && typeof value === 'object'
  ? { nodeId: String(value.nodeId || ''), portId: String(value.portId || '') }
  : { nodeId: '', portId: '' });

export async function handleAgentRequest(hub, request = {}) {
  const kind = typeof request.kind === 'string' ? request.kind : '';

  if (MUTATING.has(kind)) {
    if (hub.project?._transitionPending) return failed('project-transition');
    if (request.expectedProjectId !== (hub.project?.projectId || '')) return failed('stale-project');
  } else if (!UNGATED.has(kind) && hub.project?._transitionPending) {
    return failed('project-transition');
  }

  if (kind === 'describe') {
    const setup = describeSetup(hub);
    setup.windows = describeWindows(hub, await Promise.resolve(hub.api?.windowState?.()).catch(() => null));
    return { ok: true, projectId: hub.project?.projectId || '', setup };
  }

  if (kind === 'show-window') {
    // The page first, then the window: the person should see the window arrive
    // already on what the agent is about to work on, not a flash of the old page.
    const page = typeof request.page === 'string' ? request.page : '';
    if (page && !hub.modules?.get?.(page)) {
      return failed('unknown-page', `pages: ${describeWindows(hub).pages.map((entry) => entry.id).join(', ')}`);
    }
    if (page && !hub.modules.show(page)) return failed('page-unavailable');
    // In front, not focused: the keyboard stays with whatever the person is
    // typing in. See `window:show-main` in main.js.
    const shown = await Promise.resolve(hub.api?.showMainWindow?.()).catch(() => false);
    return { ok: true, page: hub.modules?.activeId || '', shown: shown === true };
  }

  if (kind === 'patch-bay') {
    // The Patch Bay toolbar's buttons, pressed as a person would: they lay out
    // and frame the canvas on screen, so the Patch Bay must be the page shown.
    // Undo Align lives with that page, and is gone once the page is left.
    const operation = String(request.operation || '');
    const PRESS = { align: 'align', 'undo-align': 'undoAlign', 'reset-view': 'resetView' };
    if (!Object.hasOwn(PRESS, operation)) return failed('unknown-operation', 'operations: align, undo-align, reset-view');
    const routing = hub.modules?.activeId === 'routing' ? hub.modules.get?.('routing') : null;
    const result = typeof routing?.[PRESS[operation]] === 'function' ? routing[PRESS[operation]]() : null;
    if (!result) return failed('patch-bay-not-shown', 'show-window with page "routing" first');
    if (operation === 'undo-align' && !result.restored) return failed('nothing-to-undo', 'no Align since the Patch Bay was shown');
    return { ok: true, operation, ...result };
  }

  if (kind === 'open-clip-editor') {
    // The same opening a double-click on the clip does, window reuse included.
    const clipId = String(request.clipId || '');
    if (hub.project?._transitionPending) return failed('project-transition');
    return hub.sequencer?.openClipEditor?.(clipId) ? { ok: true, clipId } : failed('clip-not-found');
  }

  if (kind === 'close-clip-editor') {
    // The window's own close button: the clip is not touched, and nothing is asked.
    const clipId = String(request.clipId || '');
    if (typeof hub.api?.clipEditorClose !== 'function') return failed('unsupported-request');
    const closed = await Promise.resolve(hub.api.clipEditorClose(clipId)).catch(() => false);
    return closed === true ? { ok: true, clipId } : failed('not-open');
  }

  if (kind === 'quit') return quitRequest(hub, request);

  if (kind === 'browser') {
    // The page lives in a plugin window drawn by the engine and is reached by
    // main, which owns sockets; this side only checks the plugin is one this
    // project holds. Whether its window is open, and what is in it, is asked of
    // the engine itself.
    const nodeId = String(request.nodeId || '');
    const pluginInstanceId = String(request.pluginInstanceId || '');
    const plugins = hub.nodes?.get?.(nodeId)?.content?.plugins;
    if (!Array.isArray(plugins) || !plugins.some((plugin) => plugin.id === pluginInstanceId)) {
      return failed('plugin-not-found');
    }
    if (typeof hub.api?.pluginBrowser !== 'function') return failed('unsupported-request');
    const payload = { nodeId, pluginInstanceId };
    for (const field of BROWSER_FIELDS) if (field in request) payload[field] = request[field];
    return hub.api.pluginBrowser(payload);
  }

  if (kind === 'create-node') {
    const typeId = String(request.typeId || '');
    let instance = null;
    try {
      instance = hub.nodes.create(typeId);
    } catch (error) {
      return failed('unknown-node-type', String(error?.message || error));
    }
    // `create` answers null for a singleton that already exists, which is not a
    // failure of the request so much as an answer to it: there is one Master
    // Output and asking for a second one changes nothing.
    return instance
      ? { ok: true, node: { id: instance.id, type: instance.type, ordinal: instance.ordinal, name: instance.name } }
      : failed('already-exists');
  }

  if (kind === 'delete-node') {
    return attempt(() => hub.nodes.delete(String(request.nodeId || '')) !== false);
  }

  if (kind === 'connect' || kind === 'disconnect') {
    const from = endpoint(request.from);
    const to = endpoint(request.to);
    const run = kind === 'connect'
      ? () => hub.network.connect(from.nodeId, from.portId, to.nodeId, to.portId)
      : () => hub.network.disconnect(from.nodeId, from.portId, to.nodeId, to.portId);
    return attempt(run);
  }

  if (kind === 'add-plugin') {
    const entry = hub.nodes.appendPlugin(String(request.nodeId || ''), String(request.pluginId || ''));
    // Two different misses, and an agent has to tell them apart to recover: a
    // plugin the catalogue does not hold is a wrong name, a node that is not a
    // VST is a wrong target.
    if (!entry) {
      return hub.engine?.getPlugin?.(String(request.pluginId || ''))
        ? failed('not-a-vst-node') : failed('unknown-plugin');
    }
    return { ok: true, plugin: { instanceId: entry.id, pluginId: entry.pluginId, name: entry.name } };
  }

  if (kind === 'remove-plugin') {
    return hub.nodes.removePlugin(String(request.nodeId || ''), String(request.pluginInstanceId || ''))
      ? { ok: true } : failed('plugin-not-found');
  }

  if (kind === 'parameters') {
    const result = await getVstParametersForNode(hub, String(request.nodeId || ''));
    return result.status === 'ok' ? { ok: true, ...result } : failed(result.status);
  }

  if (kind === 'plugin') {
    // Handed through whole, like `sequencer`: a plugin that takes requests
    // (One Ring) keeps what matters in its own state -- channels, steps, scenes
    // -- where no parameter reaches, and its vocabulary is its own. Restated
    // here it would be a second copy of One Ring inside MiniHub. What is checked
    // is only who is asked: a plugin of this project, loaded, that says it takes
    // requests. Gated on the project id because a request can reprogram it.
    const nodeId = String(request.nodeId || '');
    const pluginInstanceId = String(request.pluginInstanceId || '');
    const plugin = hub.nodes?.get?.(nodeId)?.content?.plugins?.find?.((entry) => entry.id === pluginInstanceId);
    if (!plugin) return failed('plugin-not-found');
    const body = request.request;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failed('invalid-request', 'request must be an object, such as {"kind": "describe"}');
    }
    const status = hub.engine.getInstanceStatus?.(nodeId, pluginInstanceId);
    if (status !== 'ready') return failed(status === 'error' ? 'plugin-failed' : 'plugin-not-ready');
    if (!hub.engine.acceptsRequests?.(nodeId, pluginInstanceId)) {
      return failed('requests-not-supported', `${plugin.name || 'this plugin'} takes no requests: use parameters`);
    }
    const answer = await Promise.resolve(hub.engine.pluginRequest(nodeId, pluginInstanceId, plugin.pluginId, body))
      .catch((error) => ({ status: 'engine-unavailable', message: String(error?.message || error) }));
    if (answer?.status !== 'ok') return failed(answer?.status || 'failed', answer?.message);
    const reply = answer.reply && typeof answer.reply === 'object' ? answer.reply : null;
    return reply ? { ...reply, ok: reply.ok === true } : failed('invalid-reply');
  }

  if (kind === 'one-ring') {
    // One Ring's own vocabulary, as the VST took it through `plugin`: the node
    // answers it from its content and its runtime (oneRingRequests.js), with
    // the page's own edits. Gated on the project id, as `plugin` is.
    const nodeId = String(request.nodeId || '');
    if (hub.nodes?.get?.(nodeId)?.type !== 'one-ring') return failed('node-not-found');
    return handleOneRingRequest(hub, nodeId, request.request);
  }

  if (kind === 'set-parameter') {
    const result = hub.engine.setVstParameter(
      String(request.nodeId || ''),
      String(request.pluginInstanceId || ''),
      String(request.pluginId || ''),
      String(request.parameterId || ''),
      Number(request.normalizedValue)
    );
    return result?.ok ? { ok: true } : failed(result?.reason || 'refused');
  }

  if (kind === 'add-track') {
    const track = hub.sequencer?.addTrack?.(request.type === 'audio' ? 'audio' : 'midi');
    return track
      ? { ok: true, track: { id: track.id, name: track.name, type: track.type } }
      : failed('refused');
  }

  if (kind === 'remove-track') {
    return hub.sequencer?.removeTrack?.(String(request.trackId || ''))
      ? { ok: true } : failed('track-not-found');
  }

  if (kind === 'set-track') {
    // The routing of a track -- which node it plays into -- is a `set-track`
    // like any other, because that is what the toolbar's Output field is.
    const changes = request.changes && typeof request.changes === 'object' ? request.changes : {};
    const track = hub.sequencer?.setTrack?.(String(request.trackId || ''), changes);
    if (!track) return failed('track-not-found');
    // `setTrack` answers a route it could not make by rolling the field BACK
    // and returning the track anyway. That is right for a form, which
    // re-renders and shows the old value; it is silent for an agent, which
    // would read `ok` and build on a track that plays into nothing. So the
    // answer carries what the track now IS, and a value that did not stick is
    // named rather than left to be discovered as silence.
    if ('outputId' in changes && track.outputId !== String(changes.outputId || '')) {
      return { ...failed('route-refused'), track: trackSummary(track) };
    }
    return { ok: true, track: trackSummary(track) };
  }

  if (kind === 'add-clip') {
    // The notes travel WITH the clip. A drum pattern is sixty-four notes, and
    // sixty-four round trips to place them would be sixty-four chances for the
    // project to change underneath -- `normalizeClip` already accepts them all
    // at once and clamps each one into the clip's window.
    const clip = hub.sequencer?.addMidiClip?.(
      String(request.trackId || ''),
      Number(request.startPpq) || 0,
      Number(request.lengthPpq) || 4,
      Array.isArray(request.notes) ? request.notes : []
    );
    return clip
      ? { ok: true, clip: { id: clip.id, startPpq: clip.startPpq, lengthPpq: clip.lengthPpq, noteCount: clip.notes.length } }
      : failed('refused');
  }

  if (kind === 'set-node-content') {
    // One verb for everything inside a node: a Mixer's levels, an Arpeggiator's
    // pattern, a Morpher's steps. Per-type verbs would mean a new verb every
    // time a node type is added, which is the multi-file workstream INTENT 10
    // names as a failure. `setContent` normalises by type.
    return hub.nodes.setContent(String(request.nodeId || ''), request.content)
      ? { ok: true } : failed('unchanged-or-unknown-node');
  }

  if (kind === 'move-plugin') {
    return hub.nodes.movePlugin(
      String(request.nodeId || ''), String(request.pluginInstanceId || ''), request.toIndex
    ) ? { ok: true } : failed('plugin-not-found');
  }

  if (kind === 'set-plugin-bypass') {
    return hub.nodes.setPluginBypass(
      String(request.nodeId || ''), String(request.pluginInstanceId || ''), request.bypassed === true
    ) ? { ok: true } : failed('plugin-not-found');
  }

  if (kind === 'open-editor' || kind === 'close-editor') {
    const nodeId = String(request.nodeId || '');
    const pluginInstanceId = String(request.pluginInstanceId || '');
    if (kind === 'close-editor') {
      hub.engine.closeEditor(nodeId, pluginInstanceId);
      return { ok: true };
    }
    // The engine answers "Unknown instance" for a plugin that is still loading,
    // which reads as a broken request rather than as "not yet". Ask first.
    const status = hub.engine.getInstanceStatus?.(nodeId, pluginInstanceId);
    if (status !== 'ready') return failed(status === 'error' ? 'plugin-failed' : 'plugin-not-ready');
    hub.engine.openEditor(nodeId, pluginInstanceId);
    return { ok: true };
  }

  if (kind === 'set-binding') {
    // `version` is filled in here rather than asked for: it is a fact about the
    // storage format, and a caller that had to know it would be a caller that
    // breaks when it changes.
    const ok = hub.nodes.setControlBinding(String(request.nodeId || ''), {
      version: CONTROL_BINDING_VERSION,
      sourceControlId: String(request.sourceControlId || ''),
      pluginInstanceId: String(request.pluginInstanceId || ''),
      pluginId: String(request.pluginId || ''),
      parameterId: String(request.parameterId || ''),
      pluginName: String(request.pluginName || ''),
      parameterName: String(request.parameterName || '')
    });
    return ok ? { ok: true } : failed('binding-refused');
  }

  if (kind === 'clear-binding') {
    return hub.nodes.clearControlBinding(String(request.nodeId || ''), String(request.sourceControlId || ''))
      ? { ok: true } : failed('binding-not-found');
  }

  if (kind === 'transport') {
    const operation = String(request.operation || '');
    if (operation === 'play') hub.sequencer?.playTransport?.();
    else if (operation === 'stop') hub.sequencer?.stopTransport?.();
    else if (operation === 'return-start') hub.sequencer?.goToStart?.();
    else if (operation === 'seek') hub.sequencer?.seek?.(Number(request.ppq) || 0);
    else return failed('unsupported-request');
    return { ok: true, playhead: hub.sequencer?.playheadPpq ?? null };
  }

  if (kind === 'set-tempo') {
    hub.sequencer?.setTempo?.(Number(request.bpm));
    return { ok: true, bpm: hub.sequencer?.tempo ?? null };
  }

  if (kind === 'set-master') {
    updateMasterOutput(hub, { gainDb: Number(request.gainDb) });
    return { ok: true, master: hub.settings.get('masterOutput') || null };
  }

  if (kind === 'scan-plugins') {
    hub.engine.scanVst3(true);
    // The scan answers by event, not by return: the catalogue in the next
    // `describe` is where its result shows up.
    return { ok: true, started: true };
  }

  if (kind === 'devices') {
    const operation = String(request.operation || 'list');
    if (operation === 'list') {
      return { ok: true, devices: hub.engine.devices || [], state: hub.engine.deviceState || null };
    }
    if (operation === 'select') {
      hub.engine.selectDevice(
        String(request.device || ''),
        Number(request.sampleRate) || undefined,
        Number(request.bufferSize) || undefined
      );
      return { ok: true, requested: String(request.device || '') };
    }
    return failed('unsupported-request');
  }

  if (kind === 'export') {
    if (typeof request.filePath !== 'string' || !request.filePath) {
      return failed('no-path', 'export needs an explicit filePath');
    }
    const started = await hub.sequencer?.exportMaster?.(
      request.range === 'loop' ? 'loop' : 'full',
      {
        filePath: request.filePath,
        format: request.format, bits: request.bits,
        bitrateKbps: request.bitrateKbps, tailSeconds: request.tailSeconds
      }
    );
    // `exportMaster` starts a render and reports its progress by event. `true`
    // means accepted, never finished -- the finished file appears on disk, and
    // the caller has to wait for it rather than read it from this answer.
    return started ? { ok: true, started: true, filePath: request.filePath } : failed('export-refused');
  }

  if (kind === 'cancel-export') {
    hub.engine.sequencerCancelExport();
    return { ok: true };
  }

  if (kind === 'project') return projectRequest(hub, request);

  if (kind === 'sequencer') {
    // Handed through whole: the tracks, the clips, the notes, the audition, the
    // transport and the history are already one protocol, and restating it here
    // would be the second vocabulary §8 sexies refuses.
    if (typeof hub.sequencer?.handleClipEditorRequest !== 'function') return failed('unsupported-request');
    return hub.sequencer.handleClipEditorRequest(request.request || {});
  }

  return failed('unsupported-request');
}
