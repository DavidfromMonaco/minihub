/**
 * Which controller profile this build is running.
 *
 * One line of substance, and it exists so that there is exactly one of it.
 * Three files needed the profile -- the port resolver's binding, the control
 * surface, and the node id -- and each of them said `./profiles/minilab-3.json`
 * in its own import. That is the same decision written three times: a fourth
 * reader would have made it four, and the day a profile stops shipping with the
 * application and starts being chosen, every one of them has to change together
 * or the application decodes with one profile and names its node after another.
 *
 * DECISIONS.md D-022 is why this is a constant and not a setting. There is one
 * controller, chosen at build time, and `selectedInputId` stays singular until a
 * second keyboard exists to justify the cost. What changes when that day comes
 * is this file and its callers' import shape -- not thirty call sites.
 *
 * The profile is NOT validated here. It ships with the application and
 * `test/minilabProfile.test.mjs` holds it against the format; paying for
 * validation on every launch buys a guarantee already bought. A profile arriving
 * from anywhere else goes through `validateControllerProfile()`.
 */
import profile from './profiles/minilab-3.json' with { type: 'json' };

export const LOADED_PROFILE = profile;
