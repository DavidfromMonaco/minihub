import { isMiniLabName, isPerformanceInputName } from './minilab.js';

const source = (value) => Object.freeze(value);

/** Stable physical CONTROL identities; original MIDI is never consumed. */
export const MINILAB_CONTROL_SOURCES = Object.freeze([
  source({ id: 'minilab-3:k1', key: 'k1', label: 'K1', family: 'knob', semantics: 'continuous-absolute', cc: 74, ccs: [74, 86], portId: 'control-k1' }),
  source({ id: 'minilab-3:k2', key: 'k2', label: 'K2', family: 'knob', semantics: 'continuous-absolute', cc: 71, ccs: [71, 87], portId: 'control-k2' }),
  source({ id: 'minilab-3:k3', key: 'k3', label: 'K3', family: 'knob', semantics: 'continuous-absolute', cc: 76, ccs: [76, 89], portId: 'control-k3' }),
  source({ id: 'minilab-3:k4', key: 'k4', label: 'K4', family: 'knob', semantics: 'continuous-absolute', cc: 77, ccs: [77, 90], portId: 'control-k4' }),
  source({ id: 'minilab-3:k5', key: 'k5', label: 'K5', family: 'knob', semantics: 'continuous-absolute', cc: 93, ccs: [93, 110], portId: 'control-k5' }),
  source({ id: 'minilab-3:k6', key: 'k6', label: 'K6', family: 'knob', semantics: 'continuous-absolute', cc: 18, ccs: [18, 111], portId: 'control-k6' }),
  source({ id: 'minilab-3:k7', key: 'k7', label: 'K7', family: 'knob', semantics: 'continuous-absolute', cc: 19, ccs: [19, 116], portId: 'control-k7' }),
  source({ id: 'minilab-3:k8', key: 'k8', label: 'K8', family: 'knob', semantics: 'continuous-absolute', cc: 16, ccs: [16, 117], portId: 'control-k8' }),
  source({ id: 'minilab-3:f1', key: 'f1', label: 'F1', family: 'fader', semantics: 'continuous-absolute', cc: 82, ccs: [82, 14], portId: 'control-f1' }),
  source({ id: 'minilab-3:f2', key: 'f2', label: 'F2', family: 'fader', semantics: 'continuous-absolute', cc: 83, ccs: [83, 15], portId: 'control-f2' }),
  source({ id: 'minilab-3:f3', key: 'f3', label: 'F3', family: 'fader', semantics: 'continuous-absolute', cc: 85, ccs: [85, 30], portId: 'control-f3' }),
  source({ id: 'minilab-3:f4', key: 'f4', label: 'F4', family: 'fader', semantics: 'continuous-absolute', cc: 17, ccs: [17, 31], portId: 'control-f4' }),
  source({ id: 'minilab-3:main-encoder', key: 'main-encoder', label: 'Main', family: 'main', semantics: 'continuous-absolute', cc: 114, ccs: [114, 112, 28, 29], portId: 'control-main-encoder' }),
  source({ id: 'minilab-3:main-click', key: 'main-click', label: 'Main Click', family: 'main-click', semantics: 'momentary-or-toggle', cc: 115, ccs: [115, 113, 118, 119], portId: 'control-main-click' }),
  source({ id: 'minilab-3:pitch-bend', key: 'pitch-bend', label: 'Pitch', family: 'strip', semantics: 'bipolar', portId: 'control-pitch-bend' }),
  source({ id: 'minilab-3:modulation', key: 'modulation', label: 'Mod', family: 'strip', semantics: 'continuous-absolute', cc: 1, ccs: [1], portId: 'control-modulation' }),
  source({ id: 'minilab-3:shift', key: 'shift', label: 'Shift', family: 'utility', semantics: 'momentary', cc: 9, ccs: [9, 27], portId: 'control-shift' }),
  ...Array.from({ length: 8 }, (_, index) => source({
    id: `minilab-3:p${index + 1}`, key: `p${index + 1}`, label: `P${index + 1}`,
    family: 'pad', semantics: 'velocity-momentary-pressure', notes: [36 + index, 44 + index],
    ccs: [102 + index], portId: `control-p${index + 1}`
  }))
]);

const BY_ID = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.id, item]));
const BY_PORT = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.portId, item]));
const BY_CC = new Map();
for (const item of MINILAB_CONTROL_SOURCES) for (const cc of item.ccs || []) BY_CC.set(cc, item);
const PAD_SOURCES = MINILAB_CONTROL_SOURCES.filter((item) => item.family === 'pad');

export function getMiniLabControlSource(id) { return BY_ID.get(id) || null; }
export function getMiniLabControlSourceByPort(id) { return BY_PORT.get(id) || null; }

function result(item, msg, normalizedValue, extra = {}) {
  return { type: 'control', sourceControlId: item.id, sourceNodeId: 'minilab-3',
    sourcePortId: item.portId, label: item.label, semantics: item.semantics,
    normalizedValue, rawValue: msg.value ?? msg.velocity ?? msg.bend, ...extra };
}

/** Additively project one documented physical message into CONTROL. */
export function decodeMiniLabControl(msg) {
  if (!msg || !isMiniLabName(msg.sourceName) || !isPerformanceInputName(msg.sourceName)) return null;
  if (msg.type === 'pitchbend' && Number.isInteger(msg.bend) && msg.bend >= 0 && msg.bend <= 16383) {
    const item = BY_ID.get('minilab-3:pitch-bend');
    return result(item, msg, msg.bend / 16383, { bipolarValue: Math.max(-1, (msg.bend - 8192) / 8191) });
  }
  if (msg.type === 'cc' && Number.isInteger(msg.value) && msg.value >= 0 && msg.value <= 127) {
    const item = BY_CC.get(msg.controller);
    return item ? result(item, msg, msg.value / 127) : null;
  }
  if ((msg.type === 'noteon' || msg.type === 'noteoff' || msg.type === 'polyaftertouch')
      && msg.channel === 10 && Number.isInteger(msg.note)) {
    const item = PAD_SOURCES.find((pad) => pad.notes.includes(msg.note));
    if (!item) return null;
    const raw = msg.type === 'noteoff' ? 0 : (msg.velocity ?? msg.value);
    if (!Number.isInteger(raw) || raw < 0 || raw > 127) return null;
    return result(item, msg, raw / 127, { phase: msg.type, note: msg.note });
  }
  return null;
}
