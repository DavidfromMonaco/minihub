/**
 * Normalize raw MIDI bytes into a structured, channel-aware message object.
 *
 * Returns null for messages we don't care about (system real-time, etc.).
 *
 * Result shape (channel is 1-based):
 *   { type, channel, note, velocity, controller, value, bend, raw }
 */
export function parseMidiMessage(data) {
  if (!data || data.length < 1) return null;

  const status = data[0];
  const high = status & 0xf0;
  const channel = (status & 0x0f) + 1; // 1-based
  const raw = Array.from(data);

  switch (high) {
    case 0x80: { // Note Off
      return { type: 'noteoff', channel, note: data[1], velocity: data[2], raw };
    }
    case 0x90: { // Note On (velocity 0 == note off)
      const velocity = data[2];
      if (velocity === 0) {
        return { type: 'noteoff', channel, note: data[1], velocity: 0, raw };
      }
      return { type: 'noteon', channel, note: data[1], velocity, raw };
    }
    case 0xa0: { // Polyphonic Aftertouch
      return { type: 'polyaftertouch', channel, note: data[1], value: data[2], raw };
    }
    case 0xb0: { // Control Change
      return { type: 'cc', channel, controller: data[1], value: data[2], raw };
    }
    case 0xc0: { // Program Change
      return { type: 'programchange', channel, value: data[1], raw };
    }
    case 0xd0: { // Channel Pressure
      return { type: 'channelpressure', channel, value: data[1], raw };
    }
    case 0xe0: { // Pitch Bend (14-bit, center 8192)
      const lsb = data[1] & 0x7f;
      const msb = data[2] & 0x7f;
      return { type: 'pitchbend', channel, bend: (msb << 7) | lsb, raw };
    }
    default:
      return null; // system messages / real-time
  }
}

/** Human-readable summary for the monitor. */
export function describeMessage(msg) {
  switch (msg.type) {
    case 'noteon':
      return `Note On  ${noteName(msg.note)}  vel ${msg.velocity}`;
    case 'noteoff':
      return `Note Off ${noteName(msg.note)}`;
    case 'cc':
      return `CC ${msg.controller}  value ${msg.value}`;
    case 'pitchbend':
      return `Pitch Bend  ${msg.bend} (${((msg.bend - 8192) / 8192).toFixed(3)})`;
    case 'programchange':
      return `Program Change  ${msg.value}`;
    case 'channelpressure':
      return `Aftertouch  ${msg.value}`;
    case 'polyaftertouch':
      return `Poly Aftertouch  note ${noteName(msg.note)}  ${msg.value}`;
    default:
      return msg.type;
  }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(note) {
  const name = NOTE_NAMES[note % 12];
  const octave = Math.floor(note / 12) - 1;
  return `${name}${octave}`;
}
