import { validateControllerProfile, computeCompleteness } from '../midi/controllerProfile.js';

/**
 * Reading a profile file the user has just chosen, before anything is stored.
 *
 * WHY THE JUDGING HAPPENS HERE AND NOT IN THE MAIN PROCESS
 * -------------------------------------------------------
 * `src/main/` is CommonJS and cannot import `midi/controllerProfile.js`, which is
 * an ES module the `module boundary` check rule keeps that way. So main reads
 * bytes and the renderer decides. That split has a second, better consequence:
 * the file is refused BEFORE it reaches the profiles folder, so a bad import
 * leaves nothing behind to find and delete later.
 *
 * WHY EVERY FAULT IS CARRIED BACK
 * -------------------------------
 * The validator accumulates deliberately -- a profile is fixed in one pass or it
 * is fixed one round trip per mistake, and the person fixing it is usually the
 * person who wrote it by hand. Showing the first fault only would throw that
 * away at the last moment.
 */

/** How many faults a panel shows before it stops being a list and becomes a wall. */
const SHOWN_FAULTS = 8;

/**
 * Judge one profile file.
 *
 * Returns `{ ok, profile, faults, summary }`. `faults` is a flat list of strings
 * ready to read; `summary` is what the profile says about itself once it is known
 * to be legal -- the device, and how much of it was actually observed rather than
 * guessed (specification section 4.5).
 */
export function reviewProfileText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, profile: null, faults: ['The file is empty.'], summary: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // The parser's message names a position, which is the one thing a person
    // editing JSON by hand can act on immediately.
    return { ok: false, profile: null, faults: [`This is not valid JSON — ${error.message}`], summary: null };
  }

  const { ok, errors } = validateControllerProfile(parsed);
  if (!ok) {
    const faults = errors.slice(0, SHOWN_FAULTS).map((error) => `${error.path} ${error.message}`);
    if (errors.length > SHOWN_FAULTS) {
      faults.push(`…and ${errors.length - SHOWN_FAULTS} more.`);
    }
    return { ok: false, profile: null, faults, summary: null };
  }

  const completeness = computeCompleteness(parsed);
  return {
    ok: true,
    profile: parsed,
    faults: [],
    summary: {
      profileId: parsed.profileId,
      name: parsed.name,
      vendor: parsed.device?.vendor ?? null,
      model: parsed.device?.model ?? null,
      author: parsed.author || null,
      declared: completeness.declared,
      observed: completeness.observed,
      untested: completeness.untested,
      silent: completeness.silent,
      placed: parsed.controls.some((control) => control.layout)
    }
  };
}
