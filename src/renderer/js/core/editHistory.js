import { PROJECT_KEYS } from './projectKeys.js';

/**
 * One linear, in-session history of project EDITS.
 *
 * DECISIONS.md D-032 and INTENT.md §8 quinquies are the bounds, and the line
 * they draw is the only thing that matters here: the history owns what you
 * AUTHORED and never what you PERFORMED. Rewinding an instrument is not undoing
 * an edit.
 *
 * WHY THE SCOPE IS A SUBSET OF PROJECT_KEYS AND NOT ALL OF IT
 * -----------------------------------------------------------
 * `projectKeys.js` already declares what a project is made of, once. Three of
 * those keys are on the wrong side of D-032's line and are listed below with
 * the reason, because "we only kept four of the seven" is exactly the kind of
 * thing that gets silently 'fixed' later.
 *
 * WHY SNAPSHOTS AND NOT INVERSE OPERATIONS
 * ----------------------------------------
 * D-032 settles it: two thirds of the model is already snapshot-shaped, and an
 * inverse-operation history would need a correct inverse for every mutation in
 * `nodeInstances.js` (1,145 lines) and `routingModule.js` (1,496 lines) -- the
 * two files ROADMAP item 4 exists because they are already too entangled to
 * change safely. A snapshot needs none of that: it needs one way to put the
 * state back, which is a single code path instead of forty.
 */

/**
 * The project keys the history owns.
 *
 * Derived from PROJECT_KEYS rather than typed out, so a key added to the
 * project has to be classified here on purpose instead of being forgotten.
 */
export const PERFORMED_KEYS = Object.freeze({
  // The canvas you are looking through, not the canvas you built. Undoing an
  // edit must never pan or zoom the Patch Bay under the cursor.
  networkViewport: 'view state, not authorship',
  // The transport. INTENT §8 quinquies names it: "not a knob turned during a
  // take". Undoing a cable must not change the tempo you are playing at.
  transportBpm: 'the transport',
  // The master fader. Same sentence, same reason.
  masterOutput: 'a performed level'
});

export const AUTHORED_KEYS = Object.freeze(
  PROJECT_KEYS.filter((key) => !Object.hasOwn(PERFORMED_KEYS, key))
);

/**
 * Fields of `sequencerState` that describe the VIEW rather than the music.
 *
 * The sequencer keeps its tracks and its zoom in one object, so a snapshot of
 * it carries both. Restoring the zoom and the scroll on every undo would throw
 * the timeline around while you are reading it, and restoring the selection
 * would fight the mouse. They are carried over from the live state instead.
 */
const SEQUENCER_VIEW_FIELDS = Object.freeze([
  'zoom', 'scrollPpq', 'snap',
  'selectedClipId', 'selectedClipIds', 'selectionAnchorClipId', 'focusedTrackId'
]);

/**
 * How many steps back the history goes.
 *
 * A snapshot is the whole authored project, so depth costs memory in proportion
 * to the size of the project rather than to the size of the edit. Fifty is
 * chosen to be more than any editing session reaches by hand and small enough
 * that a large project cannot make the renderer's heap the problem this feature
 * is remembered for.
 */
export const HISTORY_DEPTH = 50;

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export class EditHistory {
  constructor(hub, { depth = HISTORY_DEPTH } = {}) {
    this.hub = hub;
    this.depth = Math.max(1, depth);
    this.past = [];
    this.future = [];
    /** The state the history believes is on screen. Never null after start(). */
    this.present = null;
    /** True while a restore is being applied, so it does not record itself. */
    this.applying = false;
  }

  /** The authored half of the current state, detached from the live objects. */
  capture() {
    const snapshot = {};
    for (const key of AUTHORED_KEYS) snapshot[key] = clone(this.hub.settings.get(key)) ?? null;
    // The sequencer's model is the authority on its own state while the
    // application runs: `sequencerState` in settings is written after the fact
    // and can be one microtask behind.
    const live = this.hub.sequencer?.model?.snapshot?.();
    if (live) snapshot.sequencerState = clone(live);
    return snapshot;
  }

  /** Begin from what is on screen now, with nothing to undo. */
  start() {
    this.present = this.capture();
    this.past = [];
    this.future = [];
    return this;
  }

  /** Forget everything. A project switch never leaves a step pointing at the old one. */
  clear() {
    this.past = [];
    this.future = [];
    this.present = null;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  /**
   * Record that the authored state has settled on something new.
   *
   * Takes the CURRENT state as the new present and pushes the previous one
   * onto the past -- so `past` holds the states you can go back to, which is
   * what makes undo a move rather than a computation.
   *
   * A record while applying is the restore observing itself, and is ignored.
   */
  record() {
    if (this.applying) return false;
    const next = this.capture();
    if (this.present && !this.changed(this.present, next)) {
      // Nothing the history steps on moved -- but something inside a node may
      // have (see `_nodeIdentity`). The present is refreshed anyway so it stays
      // TRUE: a node deleted later and restored has to come back with the
      // content it had when it was deleted, not the content it had the last
      // time a step was recorded.
      this.present = next;
      return false;
    }
    if (this.present) {
      this.past.push(this.present);
      if (this.past.length > this.depth) this.past.shift();
    }
    this.present = next;
    // Doing something new is what ends a redo chain. Anything else would make
    // the "forward" of one line mean two different futures.
    this.future = [];
    return true;
  }

  /**
   * Is there a difference the history steps on?
   *
   * WHAT IS DELIBERATELY NOT A STEP, AND WHY
   * ----------------------------------------
   * A node's CONTENT -- the plugins in a VST chain, an arpeggiator's pattern,
   * a mixer's levels. Only the node SET is compared: which nodes exist, of what
   * type, under what number.
   *
   * The reason is not that content does not matter, it is that putting it back
   * is not the same problem. A VST chain lives half in the renderer and half in
   * the engine as running plugin instances; restoring it means reconciling with
   * the engine -- creating, removing and re-stating native instances -- which
   * is a workstream of its own with its own failure modes. Recording a step the
   * restore could not honour would be worse than not recording it: `Ctrl+Z`
   * would say it had undone something it had not.
   *
   * So the bound is stated rather than discovered: the history undoes what you
   * did to the CANVAS and to the ARRANGEMENT. What happens inside a node is not
   * in it yet. Deleting a node and bringing it back is complete -- it returns
   * with its content -- because that path restores the whole entry.
   */
  changed(a, b) {
    for (const key of AUTHORED_KEYS) {
      if (key === 'nodeInstances') {
        if (this._nodeIdentity(a[key]) !== this._nodeIdentity(b[key])) return true;
        continue;
      }
      if (key === 'sequencerState') {
        if (JSON.stringify(this._authoredSequencer(a[key])) !== JSON.stringify(this._authoredSequencer(b[key]))) return true;
        continue;
      }
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return true;
    }
    return false;
  }

  /** Which nodes exist, as a comparable string. Content is not part of it. */
  _nodeIdentity(persisted) {
    const entries = Array.isArray(persisted?.instances) ? persisted.instances : [];
    return entries
      .map((entry) => `${entry?.id}${entry?.type}${entry?.ordinal}`)
      .sort()
      .join('');
  }

  /** A sequencer snapshot with its view fields dropped. */
  _authoredSequencer(state) {
    if (!state || typeof state !== 'object') return state ?? null;
    const authored = { ...state };
    for (const field of SEQUENCER_VIEW_FIELDS) delete authored[field];
    return authored;
  }

  /**
   * The snapshot to apply, with the live view fields carried over.
   *
   * This is what keeps an undo from scrolling the timeline: the music comes
   * from the past, the place you are looking at comes from the present.
   */
  forApply(snapshot) {
    const applied = { ...snapshot };
    const live = this.hub.sequencer?.model?.snapshot?.() || this.hub.settings.get('sequencerState');
    if (applied.sequencerState && live && typeof live === 'object') {
      applied.sequencerState = { ...applied.sequencerState };
      for (const field of SEQUENCER_VIEW_FIELDS) {
        if (Object.hasOwn(live, field)) applied.sequencerState[field] = clone(live[field]);
      }
    }
    return applied;
  }

  /**
   * Step back. Returns the snapshot to put on screen, or null when there is
   * nothing behind.
   *
   * The caller applies it -- the history knows what the state WAS, not how to
   * rebuild a VST chain from it.
   */
  undo() {
    if (!this.canUndo || !this.present) return null;
    this.future.push(this.present);
    this.present = this.past.pop();
    return this.forApply(this.present);
  }

  /** Step forward. Null when there is nothing ahead. */
  redo() {
    if (!this.canRedo || !this.present) return null;
    this.past.push(this.present);
    this.present = this.future.pop();
    return this.forApply(this.present);
  }

  /**
   * Run `fn` without the history observing the writes it makes.
   *
   * Applying a snapshot writes the same settings keys an edit writes. Without
   * this, restoring the past would record the restore as a new edit and the
   * first undo would be the last one that worked.
   */
  async duringApply(fn) {
    this.applying = true;
    try {
      return await fn();
    } finally {
      this.applying = false;
    }
  }
}

/**
 * How long the history waits for the edit to stop before recording a step.
 *
 * A slider emits one `input` per pixel of a drag, a node drag emits one write
 * per frame. Without this, dragging a fader across its travel is two hundred
 * undo steps and `Ctrl+Z` becomes useless at the exact moment it is most
 * wanted. `engineSync.js` separates a topology change from a value change for
 * the same reason.
 *
 * The cost, stated: two deliberate edits made within this window collapse into
 * one step. 400 ms is longer than a gesture's own pauses and shorter than the
 * gap between two decisions.
 */
export const QUIET_MS = 400;

/**
 * Wire the history to the application: what counts as an edit, when a step is
 * recorded, and what `Ctrl+Z` actually does.
 *
 * WHY NOTHING CLEARS IT ON A PROJECT SWITCH
 * -----------------------------------------
 * Every project change -- New, Load, the Basic template, even a controller
 * profile swap -- goes through `ProjectManager._replace()`, which stages the
 * project in `sessionStorage` and reloads the renderer. The history dies with
 * the window it was recorded in, so "one linear history, one project"
 * (INTENT §8 quinquies) holds by construction rather than by a listener that
 * could be forgotten. `clear()` exists for the day that stops being true.
 */
export function setupEditHistory(hub, { apply, quietMs = QUIET_MS } = {}) {
  const history = new EditHistory(hub);
  let timer = null;

  const publish = () => hub.events.emit('history:changed', {
    canUndo: history.canUndo, canRedo: history.canRedo
  });

  const settle = () => {
    timer = null;
    if (history.record()) publish();
  };

  /** Record now rather than at the end of the quiet window. */
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    settle();
  };

  hub.history = {
    history,
    get canUndo() { return history.canUndo; },
    get canRedo() { return history.canRedo; },

    /** Called by `settings.onSet` for every write, authored or not. */
    observe(key) {
      if (history.applying || !AUTHORED_KEYS.includes(key)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(settle, quietMs);
    },

    /** Begin from what is on screen, with nothing behind. */
    start() {
      history.start();
      publish();
    },

    async undo() {
      // The edit that is still inside the quiet window has not been recorded
      // yet. Undoing before it settles would step over it and land one state
      // too far back -- which reads as Ctrl+Z doing nothing, then doing two
      // things at once.
      flush();
      const snapshot = history.undo();
      if (!snapshot) return false;
      await history.duringApply(() => apply(hub, snapshot));
      publish();
      return true;
    },

    async redo() {
      flush();
      const snapshot = history.redo();
      if (!snapshot) return false;
      await history.duringApply(() => apply(hub, snapshot));
      publish();
      return true;
    },

    clear() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      history.clear();
      publish();
    }
  };
  return hub.history;
}
