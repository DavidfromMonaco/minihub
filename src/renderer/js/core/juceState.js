/**
 * A plugin's saved state, as a project holds it, opened in the renderer.
 *
 * WHAT THE STRING IS
 * ------------------
 * native plugin_host.cpp wraps a VST3's two state streams in XML and hands the
 * result over the way JUCE writes a memory block:
 * `MemoryBlock::toBase64Encoding()` of `AudioProcessor::copyXmlToBinary()`.
 * JUCE's base64 is its own -- the length, a dot, then six bits a character
 * from its own alphabet, least significant bit first -- so a standard decoder
 * reads garbage. The binary block is a magic number, a length, the XML and a
 * terminating zero; the XML holds each stream, in JUCE's base64 again.
 *
 * Only reading lives here: a plugin's state is written by the engine alone.
 * test/juceState.test.mjs and the native tests check this against JUCE.
 */

const ALPHABET = '.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+';
const XML_MAGIC = 0x21324356;
// A state is loaded whole into memory: beyond this, it is not a state.
const MAX_BYTES = 64 * 1024 * 1024;

/** The bytes of a JUCE base64 string, or null when it is not one. */
export function decodeJuceBase64(text) {
  if (typeof text !== 'string') return null;
  const dot = text.indexOf('.');
  if (dot <= 0 || !/^\d+$/.test(text.slice(0, dot))) return null;
  const size = Number(text.slice(0, dot));
  if (!Number.isSafeInteger(size) || size > MAX_BYTES) return null;
  const bytes = new Uint8Array(size);
  let bit = 0;
  for (let i = dot + 1; i < text.length; i += 1) {
    const value = ALPHABET.indexOf(text[i]);
    if (value < 0) return null;
    for (let k = 0; k < 6; k += 1, bit += 1) {
      const index = bit >> 3;
      if (index < size && ((value >> k) & 1)) bytes[index] |= 1 << (bit & 7);
    }
  }
  return bytes;
}

/**
 * The streams of a VST3 state string, as `{ component, controller }` bytes
 * (either may be null), or null when the string is not such a state.
 */
export function readVst3State(state) {
  const block = decodeJuceBase64(state);
  if (!block || block.length < 9) return null;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  if (view.getUint32(0, true) !== XML_MAGIC) return null;
  const length = view.getUint32(4, true);
  if (length > block.length - 8) return null;
  const xml = new TextDecoder().decode(block.subarray(8, 8 + length)).replace(/\0+$/, '');
  if (!/<VST3PluginState\b/.test(xml)) return null;
  const stream = (name) => {
    const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
    return match ? decodeJuceBase64(match[1].trim()) : null;
  };
  return { component: stream('IComponent'), controller: stream('IEditController') };
}
