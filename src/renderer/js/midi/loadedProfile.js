/**
 * Which controller profile this session is running.
 *
 * One decision, in one place, and it exists so that there is exactly one of it.
 * Three files need the profile -- the port resolver's binding, the control
 * surface, and the node id -- and each of them used to say
 * `./profiles/minilab-3.json` in its own import. That is the same decision
 * written three times: a fourth reader would have made it four, and the day a
 * profile stops shipping with the application and starts being chosen, every one
 * of them has to change together or the application decodes with one profile and
 * names its node after another.
 *
 * WHY THE CHOICE IS MADE AT LAUNCH AND NOT LIVE
 * ---------------------------------------------
 * `MINILAB_NODE_ID` in `core/systemNodes.js` is a module-level constant derived
 * from this one, and it is evaluated when the ES module graph loads -- which is
 * BEFORE `main()` in `app.js` reaches `await hub.settings.load()`. A profile
 * fetched through an asynchronous IPC call would arrive after every consumer has
 * already frozen its value. So the profile has to be present before the first
 * module evaluates, and only `preload.js` can put it there: it runs before page
 * scripts and it has Node.
 *
 * The consequence is the design and not a compromise: **changing profile reloads
 * the window**. That is what keeps `MINILAB_NODE_ID` a constant and leaves its
 * thirty-odd consumers untouched, which is exactly what the previous version of
 * this file asked for. The application already survives a renderer reload --
 * `core/chainSync.js` rebuilds the engine's chains afterwards.
 *
 * WHY IT IS VALIDATED HERE NOW, WHEN IT USED NOT TO BE
 * ---------------------------------------------------
 * This file used to say that validation bought a guarantee already bought, and
 * that was true while the only profile that could load was the one that shipped
 * with the application and `test/minilabProfile.test.mjs` held it against the
 * format. It stops being true the moment a foreign file can arrive: nothing
 * stands between a hand-edited JSON and the decoder except this call. The
 * shipped profile is trusted as before -- it is the fallback, not the input.
 *
 * WHAT HAPPENS WHEN IT GOES WRONG
 * -------------------------------
 * The application never launches without a controller. An absent, unreadable or
 * invalid choice falls back to the profile that ships, and `PROFILE_ORIGIN`
 * records which of those happened so the Settings panel can say so out loud.
 * Falling back silently would be the worst of both: a user whose keyboard has
 * quietly become a MiniLab 3, with every cable pointing at a node named after a
 * device he does not own.
 */
import profile from './profiles/minilab-3.json' with { type: 'json' };
import { validateControllerProfile } from './controllerProfile.js';

/**
 * Decide which profile runs, given what the main process handed over.
 *
 * Exported and pure so the decision can be RUN in a test rather than asserted
 * about: the alternative is a module-level constant nothing can swap, which is
 * the trap this whole workstream exists to get out of.
 *
 * `handover` is what `preload.js` injects, and its `source` says what main found:
 * `none` (nothing chosen), `file` (read, with `profile` parsed), or `unreadable`
 * (chosen and gone, or not JSON).
 */
export function resolveProfile(handover, shipped) {
  const fallback = (reason, detail = null) => ({
    profile: shipped,
    origin: 'shipped',
    fileName: handover?.fileName ?? null,
    reason,
    detail
  });

  if (!handover || handover.source === 'none') return fallback(null);
  if (handover.source === 'unreadable') return fallback('unreadable', handover.error ?? null);
  if (handover.source !== 'file' || !handover.profile || typeof handover.profile !== 'object') {
    return fallback('unreadable', 'the main process sent no profile');
  }

  const { ok, errors } = validateControllerProfile(handover.profile);
  // Every fault, not the first: a profile is fixed in one pass or it is fixed one
  // round trip at a time. The validator accumulates for that reason and throwing
  // the list away here would undo it.
  if (!ok) return fallback('invalid', errors);

  return {
    profile: handover.profile,
    origin: 'file',
    fileName: handover.fileName ?? null,
    reason: null,
    detail: null
  };
}

const resolution = resolveProfile(globalThis.hubProfile ?? null, profile);

export const LOADED_PROFILE = resolution.profile;

/**
 * Where the running profile came from, and why it is not the one that was asked
 * for. Read by the Settings panel; nothing routes on it.
 *
 * `origin` is `file` or `shipped`. When it is `shipped` and `reason` is set, a
 * choice was made and could not be honoured -- `unreadable` (the file is gone or
 * is not JSON) or `invalid` (`detail` then holds the validator's every error).
 */
export const PROFILE_ORIGIN = Object.freeze({
  origin: resolution.origin,
  fileName: resolution.fileName,
  reason: resolution.reason,
  detail: resolution.detail
});
