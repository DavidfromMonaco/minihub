'use strict';

/**
 * The `.vstpreset` container, read and written as bytes.
 *
 * Layout, transcribed from the SDK
 * (`public.sdk/source/vst/vstpresetfile.{h,cpp}`), little-endian because
 * `BYTEORDER` is `kLittleEndian` on Windows and the SDK only byte-swaps on
 * big-endian hosts:
 *
 *     0   'VST3'                 4 bytes, header id
 *     4   version                int32, always 1
 *     8   class id               32 ASCII hex characters
 *     40  list offset            int64
 *     48  chunk payloads         written back to back
 *     ... 'List'                 4 bytes, at the list offset
 *         entry count            int32
 *         entries                count x { id 4 bytes, offset int64, size int64 }
 *
 * The chunk ids that matter are `Comp` (IComponent state) and `Cont`
 * (IEditController state) -- the same pair `plugin_host.cpp` already produces
 * and consumes. Converting between the two representations is therefore a
 * transcoding of bytes, never an interpretation of what a plugin stores.
 *
 * The class id is kept exactly as written. On Windows `COM_COMPATIBLE` is 1, so
 * `FUID::toString` and `VST3::UID::toString` emit the same 32 characters that
 * the scanner records as `classId` -- matching a preset to a plugin is a string
 * comparison with no byte reordering anywhere.
 *
 * Every parse here runs on bytes that may have come off the network, so this
 * module trusts nothing: it reports a reason instead of throwing, and never
 * reads outside the buffer it was handed.
 */

const HEADER_ID = 'VST3';
const LIST_ID = 'List';
const FORMAT_VERSION = 1;
const CLASS_ID_SIZE = 32;
/** 'VST3' + int32 version + 32 class characters + int64 list offset. */
const HEADER_SIZE = 48;
const LIST_OFFSET_POS = HEADER_SIZE - 8;
/** `kMaxEntries` in vstpresetfile.h. A larger count is a malformed file. */
const MAX_ENTRIES = 128;

const CHUNK_COMPONENT = 'Comp';
const CHUNK_CONTROLLER = 'Cont';
const CHUNK_META = 'Info';

const CLASS_ID_PATTERN = /^[0-9A-F]{32}$/;

const fail = (reason) => ({ ok: false, reason });

/** Normalized class id, or null when it is not 32 hex characters. */
function normalizeClassId(value) {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return CLASS_ID_PATTERN.test(upper) ? upper : null;
}

/**
 * A 64-bit field as a safe JS integer, or null.
 *
 * Offsets and sizes are int64 in the format. Anything negative, past the end of
 * the buffer, or beyond `Number.MAX_SAFE_INTEGER` is a malformed file rather
 * than a number to carry around: converting it silently would turn a hostile
 * value into a plausible one.
 */
function safeOffset(value, limit) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const number = Number(value);
  return number <= limit ? number : null;
}

/**
 * Parse just the 48-byte header.
 *
 * Deciding whether a preset belongs to a given plugin only needs its class id,
 * so a library scan reads 48 bytes per file instead of every byte of every
 * file. `listOffset` is returned unvalidated against a file length the caller
 * may not know yet -- `readPreset` is what bounds it.
 */
function readHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) return fail('not-a-buffer');
  if (buffer.length < HEADER_SIZE) return fail('too-short');
  if (buffer.toString('latin1', 0, 4) !== HEADER_ID) return fail('not-a-vstpreset');

  const version = buffer.readInt32LE(4);
  if (version !== FORMAT_VERSION) return fail('unsupported-version');

  const classId = normalizeClassId(buffer.toString('latin1', 8, 8 + CLASS_ID_SIZE));
  if (!classId) return fail('invalid-class-id');

  return { ok: true, header: { classId, version, listOffset: buffer.readBigInt64LE(LIST_OFFSET_POS) } };
}

/**
 * Parse a `.vstpreset` file.
 *
 * Returns `{ ok: true, preset }` where `preset` is
 * `{ classId, version, component, controller, meta }`. `component` is a Buffer;
 * `controller` and `meta` are Buffers or null. Chunks are copied, so the
 * caller can release the source buffer.
 */
function readPreset(buffer) {
  const head = readHeader(buffer);
  if (!head.ok) return head;
  const { classId, version } = head.header;

  const listOffset = safeOffset(head.header.listOffset, buffer.length);
  // The list carries at least its id and a count.
  if (listOffset === null || listOffset < HEADER_SIZE || listOffset + 8 > buffer.length) {
    return fail('invalid-list-offset');
  }
  if (buffer.toString('latin1', listOffset, listOffset + 4) !== LIST_ID) return fail('missing-chunk-list');

  const count = buffer.readInt32LE(listOffset + 4);
  if (count < 0 || count > MAX_ENTRIES) return fail('invalid-entry-count');
  const entriesEnd = listOffset + 8 + count * 20;
  if (entriesEnd > buffer.length) return fail('truncated-chunk-list');

  const chunks = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = listOffset + 8 + i * 20;
    const id = buffer.toString('latin1', at, at + 4);
    const offset = safeOffset(buffer.readBigInt64LE(at + 4), buffer.length);
    const size = safeOffset(buffer.readBigInt64LE(at + 12), buffer.length);
    if (offset === null || size === null) return fail('invalid-chunk-bounds');
    // A chunk may not start inside the header, nor run past the file: either
    // would mean reading bytes the entry does not own.
    if (offset < HEADER_SIZE || offset + size > buffer.length) return fail('invalid-chunk-bounds');
    // First occurrence wins, matching `PresetFile::getEntry`.
    if (!chunks.has(id)) chunks.set(id, Buffer.from(buffer.subarray(offset, offset + size)));
  }

  const component = chunks.get(CHUNK_COMPONENT) || null;
  // A preset with no IComponent state cannot be applied: that chunk is the one
  // `plugin_host.cpp` requires, the controller half being optional.
  if (!component) return fail('missing-component-state');

  return {
    ok: true,
    preset: {
      classId,
      version,
      component,
      controller: chunks.get(CHUNK_CONTROLLER) || null,
      meta: chunks.get(CHUNK_META) || null
    }
  };
}

function chunkBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  return undefined; // signals "wrong type" to the caller below
}

/**
 * Build a `.vstpreset` file from a class id and its state chunks.
 *
 * Chunks are written in the SDK's order -- component, controller, meta -- then
 * the list, so a file produced here round-trips through `readPreset` and
 * through any host that reads the format.
 */
function writePreset({ classId, component, controller = null, meta = null } = {}) {
  const id = normalizeClassId(classId);
  if (!id) return fail('invalid-class-id');

  const parts = [
    { id: CHUNK_COMPONENT, data: chunkBuffer(component) },
    { id: CHUNK_CONTROLLER, data: chunkBuffer(controller) },
    { id: CHUNK_META, data: chunkBuffer(meta) }
  ];
  if (parts.some((part) => part.data === undefined)) return fail('invalid-chunk');
  if (!parts[0].data || parts[0].data.length === 0) return fail('missing-component-state');

  const present = parts.filter((part) => part.data && part.data.length > 0);

  const header = Buffer.alloc(HEADER_SIZE);
  header.write(HEADER_ID, 0, 4, 'latin1');
  header.writeInt32LE(FORMAT_VERSION, 4);
  header.write(id, 8, CLASS_ID_SIZE, 'latin1');

  const entries = [];
  let offset = HEADER_SIZE;
  for (const part of present) {
    entries.push({ id: part.id, offset, size: part.data.length });
    offset += part.data.length;
  }
  header.writeBigInt64LE(BigInt(offset), LIST_OFFSET_POS);

  const list = Buffer.alloc(8 + entries.length * 20);
  list.write(LIST_ID, 0, 4, 'latin1');
  list.writeInt32LE(entries.length, 4);
  entries.forEach((entry, index) => {
    const at = 8 + index * 20;
    list.write(entry.id, at, 4, 'latin1');
    list.writeBigInt64LE(BigInt(entry.offset), at + 4);
    list.writeBigInt64LE(BigInt(entry.size), at + 12);
  });

  return {
    ok: true,
    buffer: Buffer.concat([header, ...present.map((part) => part.data), list])
  };
}

module.exports = {
  readHeader,
  readPreset,
  writePreset,
  normalizeClassId,
  HEADER_SIZE,
  CLASS_ID_SIZE,
  MAX_ENTRIES,
  CHUNK_COMPONENT,
  CHUNK_CONTROLLER,
  CHUNK_META
};
