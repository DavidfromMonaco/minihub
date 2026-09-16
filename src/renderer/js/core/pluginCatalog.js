/**
 * One catalogue entry per plugin, whichever path the scanner reached it by.
 *
 * A VST3 plugin shipped as a folder keeps its module inside it:
 * `Splice INSTRUMENT.vst3\Contents\x86_64-win\Splice INSTRUMENT.vst3`. The
 * scanner used to walk into the folder and list that file as a second plugin,
 * so Splice INSTRUMENT, ONE RING and Airwindows Consolidated each appeared
 * twice (DECISIONS D-044). The two copies did not even agree: a folder is
 * described from its moduleinfo.json, which names no audio bus, so ONE RING's
 * folder entry read "unknown" and people picked the other one. Saved projects
 * therefore name either path, and both have to keep finding the entry that
 * remains.
 *
 * The folder is the entry kept: it is the path JUCE's own host lists, and the
 * only one a scan reports now that it stops at a plugin's folder.
 */

/**
 * The folder a plugin lives in -- or the plugin file itself when it has no
 * folder: the id up to its first path segment named `*.vst3`. Empty for an id
 * that is not such a path.
 */
export function bundlePathOf(pluginId) {
  const match = /^(.*?\.vst3)(?:[\\/]|$)/i.exec(String(pluginId || ''));
  return match ? match[1] : '';
}

// Windows paths: one separator, no case.
function pathKey(path) {
  return path.replace(/\//g, '\\').toLowerCase();
}

function idOf(entry) {
  return String(entry?.pluginId || entry?.path || '');
}

/** The kept entry, completed with what only another path to it measured. */
function completedWith(kept, other) {
  const merged = { ...kept };
  if ((!merged.role || merged.role === 'unknown') && other.role && other.role !== 'unknown') {
    merged.role = other.role;
  }
  const knowsNoBus = !(merged.numInputChannels > 0) && !(merged.numOutputChannels > 0);
  if (knowsNoBus && (other.numInputChannels > 0 || other.numOutputChannels > 0)) {
    merged.numInputChannels = other.numInputChannels || 0;
    merged.numOutputChannels = other.numOutputChannels || 0;
  }
  if (!merged.classId && other.classId) merged.classId = other.classId;
  return merged;
}

/**
 * The catalogue with every plugin once, in the order it was found.
 *
 * Two entries are one plugin when they sit in the same `.vst3` folder under
 * the same name. Two names in one folder stay two plugins: invariant 12 is
 * that a catalogue never loses a plugin on its own, and a second path to the
 * same plugin is not a plugin. Entries that need no merge are returned as
 * they came.
 */
export function oneEntryPerPlugin(entries) {
  const result = [];
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const bundle = bundlePathOf(idOf(entry));
    if (!bundle) {
      result.push(entry);
      continue;
    }
    const key = `${pathKey(bundle)}\n${String(entry.name || '').trim().toLowerCase()}`;
    const group = groups.get(key);
    if (group) {
      group.members.push(entry);
      continue;
    }
    groups.set(key, { index: result.length, bundle, members: [entry] });
    result.push(entry);
  }
  for (const { index, bundle, members } of groups.values()) {
    if (members.length === 1) continue;
    const kept = members.find((entry) => pathKey(idOf(entry)) === pathKey(bundle)) || members[0];
    result[index] = members.filter((entry) => entry !== kept).reduce(completedWith, kept);
  }
  return result;
}

/**
 * A lookup by the id a project or an agent gives: the entry's own id first,
 * then any path inside the same `.vst3` folder, so the module's path finds a
 * plugin listed by its folder and the other way round. A folder that holds
 * plugins under several names answers nothing this way: which one was meant
 * cannot be told.
 */
export function pluginLookup(entries) {
  const byId = new Map();
  const byBundle = new Map();
  const ambiguous = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    byId.set(entry.pluginId, entry);
    const bundle = bundlePathOf(entry.pluginId);
    if (!bundle) continue;
    const key = pathKey(bundle);
    if (byBundle.has(key)) ambiguous.add(key);
    else byBundle.set(key, entry);
  }
  for (const key of ambiguous) byBundle.delete(key);
  return (pluginId) => {
    const exact = byId.get(pluginId);
    if (exact) return exact;
    const bundle = bundlePathOf(pluginId);
    return (bundle && byBundle.get(pathKey(bundle))) || null;
  };
}
