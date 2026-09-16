/**
 * Plugin states as the engine writes them, for tests.
 *
 * `encodeJuceBase64` is JUCE's `MemoryBlock::toBase64Encoding`, bit for bit:
 * native_tests.cpp ([core] juce-base64) checks one of its outputs against JUCE
 * itself. The renderer only ever reads these (core/juceState.js).
 */

const ALPHABET = '.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+';
const XML_MAGIC = 0x21324356;

export function encodeJuceBase64(bytes) {
  const size = bytes.length;
  const characters = Math.floor((size * 8 + 5) / 6);
  let out = `${size}.`;
  for (let i = 0; i < characters; i += 1) {
    let value = 0;
    for (let k = 0; k < 6; k += 1) {
      const bit = i * 6 + k;
      const index = bit >> 3;
      if (index < size && ((bytes[index] >> (bit & 7)) & 1)) value |= 1 << k;
    }
    out += ALPHABET[value];
  }
  return out;
}

/** A plugin state string holding `component` (and `controller`) bytes, as plugin_host.cpp builds it. */
export function vst3StateString(component, controller = null) {
  const streams = [['IComponent', component], ['IEditController', controller]]
    .filter(([, bytes]) => bytes && bytes.length)
    .map(([name, bytes]) => `<${name}>${encodeJuceBase64(bytes)}</${name}>`)
    .join('');
  const xml = new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?> <VST3PluginState>${streams}</VST3PluginState>`
  );
  const block = new Uint8Array(8 + xml.length + 1);
  const view = new DataView(block.buffer);
  view.setUint32(0, XML_MAGIC, true);
  view.setUint32(4, block.length - 9, true);
  block.set(xml, 8);
  return encodeJuceBase64(block);
}

/**
 * The component stream the One Ring VST writes: its JSON, then what JUCE's
 * wrapper appends -- eight zero bytes, private data, its size, a marker.
 */
export function oneRingComponent(state) {
  const json = new TextEncoder().encode(JSON.stringify(state));
  const marker = new TextEncoder().encode('JUCEPrivateData');
  const privateData = [0x03, 0x00, 0x00, 0x00, 0x7b, 0x7d, 0x01, 0x00];
  const block = new Uint8Array(json.length + 8 + privateData.length + 8 + marker.length);
  block.set(json, 0);
  block.set(privateData, json.length + 8);
  block.set([privateData.length, 0, 0, 0, 0, 0, 0, 0], json.length + 8 + privateData.length);
  block.set(marker, block.length - marker.length);
  return block;
}
