import { MASTER_OUTPUT_KEY } from './masterOutput.js';

/**
 * Settings keys owned by the PROJECT, not by the application.
 *
 * Two independent things need this exact list, and they used to keep private
 * copies of it:
 *
 *   - `ProjectManager.bootstrap()` deletes these keys so an ordinary launch
 *     starts on an empty workspace instead of resurrecting the last session.
 *   - `SettingsStore.applicationData()` strips them before writing
 *     `settings.json`, so project state never leaks into machine preferences.
 *
 * A key added to one copy and forgotten in the other fails quietly and in
 * opposite directions: forgotten in the first, a stale value survives into a
 * new project; forgotten in the second, project data is written into the
 * global preferences file and then reloaded by every other project.
 *
 * Anything NOT listed here is application-scoped and persists across projects
 * (selected MIDI ports, audio device, VST catalog, recent project). See
 * `DEFAULTS` in `src/main/settings.js`, which is the main-process counterpart
 * and must stay free of the keys below.
 */
export const PROJECT_KEYS = [
  'nodeInstances',
  'networkConnections',
  'networkLayout',
  'networkViewport',
  'transportBpm',
  'sequencerState',
  MASTER_OUTPUT_KEY
];

/** Same list, for membership tests on the settings write path. */
export const PROJECT_KEY_SET = new Set(PROJECT_KEYS);

/**
 * Names these keys carried before D-019 renamed `graph` to `network`.
 *
 * They exist only to be deleted. A `settings.json` written by an earlier build
 * still holds them, and they are no longer in PROJECT_KEYS -- so `bootstrap()`
 * would stop purging them and `applicationData()` would stop stripping them.
 * The result is precisely the failure this file was written to prevent:
 * project state surviving into a new project, and leaking into machine
 * preferences where every other project would read it back.
 *
 * Nothing reads their values. Loading an old project goes through
 * `ProjectManager.applySnapshot`, which accepts the old `graph` block of a
 * `.minihub` file and writes the new keys.
 */
export const LEGACY_PROJECT_KEYS = [
  'graphConnections',
  'graphLayout',
  'graphViewport'
];

/** Purge list: current keys plus the ones a previous build may have left. */
export const PURGEABLE_PROJECT_KEYS = [...PROJECT_KEYS, ...LEGACY_PROJECT_KEYS];
