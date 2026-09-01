export const MASTER_OUTPUT_KEY = 'masterOutput';
export const DEFAULT_MASTER_OUTPUT = Object.freeze({ gainDb: 0 });

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeMasterOutput(value) {
  return {
    // Legacy ceiling fields are discarded: they represented hidden dynamic
    // processing, not user-authored mix gain.
    gainDb: clamp(finite(value?.gainDb, DEFAULT_MASTER_OUTPUT.gainDb), -60, 12)
  };
}

/** Publish the project-owned Master independently of whether its editor is
 *  currently mounted. Engine restarts always receive the same state. */
export function setupMasterOutput(hub) {
  const publish = () => hub.engine?.setMasterOutput(
    normalizeMasterOutput(hub.settings.get(MASTER_OUTPUT_KEY)));
  hub.events.on('engine:state', (state) => {
    if (state?.state === 'running') publish();
  });
  publish();
  return publish;
}

/** Update project memory and dirtiness without writing a project field into
 *  global application preferences. The project file remains authoritative. */
export function updateMasterOutput(hub, changes) {
  const next = normalizeMasterOutput({
    ...normalizeMasterOutput(hub.settings.get(MASTER_OUTPUT_KEY)),
    ...(changes || {})
  });
  hub.settings.data[MASTER_OUTPUT_KEY] = next;
  hub.settings.onSet?.(MASTER_OUTPUT_KEY, next);
  hub.engine?.setMasterOutput(next);
  hub.events.emit('master:changed', next);
  return next;
}
