import { decodeControl } from '../midi/decodeControl.js';
import { profileOfNode } from '../midi/minilabControls.js';
import { LOADED_PROFILE } from '../midi/loadedProfile.js';
import { TEMPO_MAX, TEMPO_MIN } from './tempoControl.js';

/**
 * A controller's transport keys: Play, Stop, Rec, Loop and Tap, pressed on the
 * keyboard, act as the header's buttons and the Space bar do. Asked by the
 * author on 2026-09-26 (D-058) -- the MiniLab 3 prints them over its pads, and
 * sends them with Shift held.
 *
 * WHY NO CABLE
 * ------------
 * They are the application's shortcuts, like Space: the transport is not the
 * signal path, and the header's Play is not cabled either (invariant 2 is
 * about what is heard). Nothing here names a device or a number. The profile
 * declares which binding is a transport key (`"transport": "play"` on the
 * binding that answers CC 107), so another keyboard with transport keys is a
 * profile, as data, and a keyboard without any changes nothing.
 *
 * TAKEN OFF THE MIDI PATH
 * -----------------------
 * The one exception to "CONTROL is additive" (`core/midiRouting.js`). A Rec
 * pressed on the keyboard that also reached Analog Lab as CC 108, and was
 * written into the take it started, would be a key that plays music. So a
 * transport key is neither forwarded down the controller's MIDI OUT nor
 * published as CONTROL: `transportKeyOf` is what both of those ask first.
 */

export const TRANSPORT_KEYS = Object.freeze(['play', 'stop', 'record', 'loop', 'tap']);

/** The transport key a message is, or null. */
export function transportKeyOf(msg) {
  if (!msg) return null;
  const profile = profileOfNode(msg.profileId) ?? LOADED_PROFILE;
  const key = decodeControl(profile, msg)?.binding?.transport;
  return TRANSPORT_KEYS.includes(key) ? key : null;
}

/** Taps further apart than this start a new count: a pause is not a tempo. */
const TAP_RESET_MS = 2000;
/** The intervals averaged: enough to steady a hand, few enough to follow it. */
const TAP_WINDOW = 4;

/**
 * Tap tempo: the tempo is the average of the last intervals tapped, from the
 * second tap on, like every tap button.
 */
export function createTapTempo({ now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  let taps = [];
  return function tap(at = now()) {
    if (taps.length && at - taps.at(-1) > TAP_RESET_MS) taps = [];
    taps.push(at);
    if (taps.length > TAP_WINDOW + 1) taps.shift();
    if (taps.length < 2) return null;
    const average = (taps.at(-1) - taps[0]) / (taps.length - 1);
    if (!(average > 0)) return null;
    return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(60000 / average)));
  };
}

export function installControllerTransport(hub) {
  const tap = createTapTempo();
  const act = {
    // Play and Space are one key: it starts, and stops what is running.
    play: (seq) => {
      if (seq.playing || seq.recording || seq.preCounting) seq.stopTransport();
      else seq.playTransport();
    },
    stop: (seq) => seq.stopTransport(),
    // Rec starts a take, and ends it with the transport left running -- the
    // Sequencer's RECORD_OFF. A take that cannot start says why in the
    // header, as a click does; no dialog answers a key on the keyboard.
    record: (seq) => (seq.recording ? seq.stopRecording() : seq.startRecording()),
    loop: (seq) => {
      const loop = seq.model.state.loop;
      seq.model.setLoop({ ...loop, enabled: !loop.enabled });
      seq.changed();
    },
    tap: (seq, msg) => {
      const bpm = tap(Number.isFinite(msg.hubTimestamp) ? msg.hubTimestamp : undefined);
      if (bpm !== null) seq.setTempo(bpm);
    }
  };
  return hub.events.on('midi:message', (msg) => {
    const key = transportKeyOf(msg);
    // The press, not the release: the MiniLab sends 127 then 0.
    if (!key || !(Number(msg.value) > 0)) return;
    const seq = hub.sequencer;
    if (seq?.model) act[key](seq, msg);
  });
}
