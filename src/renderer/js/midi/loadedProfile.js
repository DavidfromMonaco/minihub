/**
 * Which controller profiles this session is running.
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
 * `CONTROLLER_NODE_IDS` in `core/systemNodes.js` is a module-level constant
 * derived from this one, and it is evaluated when the ES module graph loads -- which is
 * BEFORE `main()` in `app.js` reaches `await hub.settings.load()`. A profile
 * fetched through an asynchronous IPC call would arrive after every consumer has
 * already frozen its value. So the profile has to be present before the first
 * module evaluates, and only `preload.js` can put it there: it runs before page
 * scripts and it has Node.
 *
 * The consequence is the design and not a compromise: **changing profile reloads
 * the window**. That is what keeps `CONTROLLER_NODE_IDS` a constant and leaves
 * its thirty-odd consumers untouched, which is exactly what the previous version of
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
 * invalid choice falls back to the profile that ships, and `PROFILE_ORIGINS`
 * records which of those happened so the controller page can say so out loud.
 * Falling back silently would be the worst of both: a user whose keyboard has
 * quietly become a MiniLab 3, with every cable pointing at a node named after a
 * device he does not own.
 *
 * WHY IT IS A LIST
 * ----------------
 * Two keyboards on one desk are two profiles running together, not a choice
 * between them -- `plans/active/two-controllers-at-once.md`. Identities are
 * already prefixed by profile (a node id IS a `profileId`, a control source is
 * `<profileId>:<controlId>`), so `minilab-3:k1` and `arturia-beatstep:k1` cannot
 * collide; what was missing was a handover that could carry more than one.
 *
 * The fallback does NOT repeat per entry. One unreadable file among three is
 * reported as `missing` and leaves the other two alone: standing the shipped
 * profile in for it would register `minilab-3` a second time, which is a node id
 * reused (invariant 4) and an `unregister` that cannot be symmetric (invariant
 * 5). The shipped profile stands in once, when NOTHING loaded.
 */
import profile from './profiles/minilab-3.json' with { type: 'json' };
import { validateControllerProfile } from './controllerProfile.js';

/**
 * Judge ONE handover entry: is there a usable profile in it, and if not, why not.
 *
 * `entry` is one element of what `preload.js` injects, and its `source` says what
 * main found: `file` (read, with `profile` parsed) or `unreadable` (chosen and
 * gone, or not JSON). Anything else is treated as a failure rather than as a
 * profile -- a handover that makes no sense is not a keyboard.
 */
function resolveEntry(entry) {
  const failed = (reason, detail = null) => ({
    profile: null, origin: 'missing', fileName: entry?.fileName ?? null, reason, detail
  });

  if (!entry || entry.source === 'none') return failed(null);
  if (entry.source === 'unreadable') return failed('unreadable', entry.error ?? null);
  if (entry.source !== 'file' || !entry.profile || typeof entry.profile !== 'object') {
    return failed('unreadable', 'the main process sent no profile');
  }

  const { ok, errors } = validateControllerProfile(entry.profile);
  // Every fault, not the first: a profile is fixed in one pass or it is fixed one
  // round trip at a time. The validator accumulates for that reason and throwing
  // the list away here would undo it.
  if (!ok) return failed('invalid', errors);

  return {
    profile: entry.profile,
    origin: 'file',
    fileName: entry.fileName ?? null,
    reason: null,
    detail: null
  };
}

/**
 * Decide which profiles run, given what the main process handed over.
 *
 * Exported and pure so the decision can be RUN in a test rather than asserted
 * about: the alternative is a module-level constant nothing can swap, which is
 * the trap this whole workstream exists to get out of.
 *
 * Returns one entry per keyboard asked for, in the order they were chosen, each
 * carrying its profile or the reason there is none. At least one entry always
 * has a profile: MiniHub does not launch without a controller.
 */
/**
 * The name the shipped profile answers to.
 *
 * It has no file in the profiles folder -- it is compiled into the application --
 * so `main` can only ever report it as `unreadable`, and until this existed
 * there was NO WAY TO ASK FOR IT ALONGSIDE ANOTHER KEYBOARD. Selecting a
 * BeatStep did not add a second controller, it replaced the only one: the
 * shipped profile was the fallback for an empty list and never a member of it.
 * That made "a MiniLab and a BeatStep at once" impossible, which is the whole
 * point of this workstream.
 *
 * `<profileId>.json` and not a special token, because that is exactly what
 * `storeProfile` names an imported file (D-025: a profile is identified by the
 * hardware it describes). So the day a user imports a newer `minilab-3.json`,
 * the file simply wins -- it resolves before this substitution is reached -- and
 * nothing has to know it took over.
 */
export const shippedFileName = (shipped) => `${shipped.profileId}.json`;

export function resolveProfiles(handover, shipped) {
  // A bare object is a list of one. That is not politeness towards old callers:
  // `test/profileIpc.test.cjs` pins that preload passes the handover through
  // VERBATIM, so the shape that arrives is whatever main sent, and a main
  // process that predates the list is a main process that sends one object.
  const list = Array.isArray(handover) ? handover : (handover ? [handover] : []);
  const entries = list.map((entry) => {
    const resolved = resolveEntry(entry);
    // A selection naming the shipped profile: main could not read it because
    // there is no file to read, and this is where it becomes the keyboard it
    // names rather than a missing one.
    if (resolved.profile === null && entry?.fileName === shippedFileName(shipped)) {
      return { profile: shipped, origin: 'shipped', fileName: entry.fileName, reason: null, detail: null };
    }
    return resolved;
  });
  if (entries.some((entry) => entry.profile !== null)) return entries;

  // Nothing loaded, so the shipped profile takes the place -- and it takes the
  // place OF THE FIRST FAILURE rather than being appended, so that a single
  // unreadable choice still reports its own file name and reason, which is what
  // the controller page prints. Any further failure stays `missing`: there is
  // one shipped profile and it cannot stand in for two keyboards at once.
  const [first, ...rest] = entries;
  return [{
    profile: shipped,
    origin: 'shipped',
    fileName: first?.fileName ?? null,
    reason: first?.reason ?? null,
    detail: first?.detail ?? null
  }, ...rest];
}

/** The one-keyboard decision, for the consumers that still know of one. */
export function resolveProfile(handover, shipped) {
  const entries = resolveProfiles(handover, shipped);
  return entries.find((entry) => entry.profile !== null);
}

const resolution = resolveProfiles(globalThis.hubProfiles ?? null, profile);
const running = resolution.filter((entry) => entry.profile !== null);

const asOrigin = (entry) => Object.freeze({
  origin: entry.origin, fileName: entry.fileName, reason: entry.reason, detail: entry.detail
});

/** Every profile this session runs, in the order they were chosen. Never empty. */
export const LOADED_PROFILES = Object.freeze(running.map((entry) => entry.profile));

/** The profile compiled into the application, and the name it answers to. It is
 *  a keyboard like any other now, not only the fallback for an empty list. */
export const SHIPPED_PROFILE = profile;
export const SHIPPED_FILE_NAME = shippedFileName(profile);

/**
 * One entry per keyboard that was asked for: where it came from, and why it is
 * not the one asked for. Read by the controller page; nothing routes on it.
 *
 * `origin` is `file` (loaded from a profile file), `shipped` (nothing loaded, so
 * the profile that ships stands in) or `missing` (this keyboard did not load and
 * others did, so nothing stands in for it). When `reason` is set it says what
 * went wrong -- `unreadable` (the file is gone or is not JSON) or `invalid`
 * (`detail` then holds the validator's every error).
 *
 * It is therefore LONGER than `LOADED_PROFILES` when a choice failed; the two
 * are matched by `fileName`, not by index.
 */
export const PROFILE_ORIGINS = Object.freeze(resolution.map(asOrigin));

/** The first running profile, and where it came from. Both go as the rest of
 *  the workstream lands; until then five files still read them. */
export const LOADED_PROFILE = LOADED_PROFILES[0];
export const PROFILE_ORIGIN = asOrigin(running[0]);
