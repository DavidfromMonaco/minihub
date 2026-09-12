import { AUTHORED_KEYS } from './editHistory.js';

/**
 * Put an authored snapshot back on screen, in place.
 *
 * WHY THIS IS NOT `ProjectManager.applySnapshot`
 * ----------------------------------------------
 * Every project change in MiniHub -- New, Load, the Basic template, a
 * controller profile swap -- goes through `_replace()`, which stages the
 * project in `sessionStorage` and reloads the renderer. That is a correct and
 * cheap way to change project and an absurd way to answer `Ctrl+Z`. So this is
 * the one path that rehydrates the live objects without navigating.
 *
 * THE ORDER IS THE ORDER `app.js` BOOTS IN, AND IT IS NOT A PREFERENCE
 * --------------------------------------------------------------------
 * Nodes, then cables, then positions, then the sequencer. A cable whose node
 * does not exist yet is kept as unresolved (D-029) rather than drawn, so
 * restoring cables first would silently park half the canvas in a waiting list.
 *
 * WHAT IT DOES NOT TOUCH: everything `PERFORMED_KEYS` names -- the transport,
 * the tempo, the master fader, the viewport -- and the sequencer's own view
 * fields, which `EditHistory.forApply` has already carried over from the live
 * state. Undo puts the music back; it never moves what you are looking at.
 */

/** Bring the node set back to what the snapshot says, and no further. */
function restoreInstances(hub, persisted) {
  if (!hub.nodes) return;
  const entries = Array.isArray(persisted?.instances) ? persisted.instances : [];
  const wanted = new Map(entries
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => [entry.id, entry]));

  // Gone in the snapshot: delete. `delete()` is what tears a VST chain out of
  // the engine as well, so a node that leaves takes its plugins with it.
  for (const instance of hub.nodes.list()) {
    if (!wanted.has(instance.id)) hub.nodes.delete(instance.id);
  }

  // Present in the snapshot, absent on screen: the node you just deleted.
  for (const [id, entry] of wanted) {
    if (!hub.nodes.get(id)) hub.nodes.restoreInstance(entry);
  }
}

/**
 * Apply a snapshot. Returns what it could not do, so the caller can say so.
 *
 * The sequencer is restored through its own model rather than by writing
 * `sequencerState`: the controller is the authority while the application runs
 * (see `EditHistory.capture`), and `changed()` is what republishes the native
 * plan and invalidates the open Clip Editors.
 */
export async function applyHistorySnapshot(hub, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'no-snapshot' };

  restoreInstances(hub, snapshot.nodeInstances);

  if (typeof hub.network?.replaceConnections === 'function') {
    hub.network.replaceConnections(snapshot.networkConnections || []);
  }

  await hub.settings.set('networkLayout', snapshot.networkLayout || {});

  if (snapshot.sequencerState && typeof hub.sequencer?.restoreState === 'function') {
    hub.sequencer.restoreState(snapshot.sequencerState);
  }

  // The Patch Bay caches node positions and only fills in the ones it is
  // missing, so writing `networkLayout` moves nothing on its own. This is the
  // signal to drop that cache and redraw from the network -- invariant 2, the
  // network is the authority, and after an undo it is a different network.
  hub.events?.emit?.('history:applied', { keys: [...AUTHORED_KEYS] });
  return { ok: true };
}
