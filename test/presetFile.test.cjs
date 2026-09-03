'use strict';

/**
 * The `.vstpreset` container.
 *
 * A round-trip through our own writer and reader would pass even if the layout
 * were wrong in both, so the fixtures below are laid out byte by byte from the
 * SDK specification instead. That is what proves a file written here is
 * readable by a real host, and a file downloaded from one is readable here.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  readPreset,
  writePreset,
  normalizeClassId,
  HEADER_SIZE,
  MAX_ENTRIES
} = require('../src/main/presetFile.js');

const CLASS_ID = '5653544E6924486D6173736976652078'; // Massive X, as scanned
const COMPONENT = Buffer.from('component-state-bytes', 'latin1');
const CONTROLLER = Buffer.from('controller-state', 'latin1');

/**
 * Hand-built container, written straight from the specification: header id,
 * int32 version, 32 class characters, int64 list offset, payloads, then the
 * chunk list. It shares no code with `writePreset`.
 */
function handBuilt(chunks, { classId = CLASS_ID, version = 1 } = {}) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('VST3', 0, 4, 'latin1');
  header.writeInt32LE(version, 4);
  header.write(classId, 8, 32, 'latin1');

  const entries = [];
  let offset = HEADER_SIZE;
  for (const chunk of chunks) {
    entries.push({ id: chunk.id, offset, size: chunk.data.length });
    offset += chunk.data.length;
  }
  header.writeBigInt64LE(BigInt(offset), 40);

  const list = Buffer.alloc(8 + entries.length * 20);
  list.write('List', 0, 4, 'latin1');
  list.writeInt32LE(entries.length, 4);
  entries.forEach((entry, index) => {
    const at = 8 + index * 20;
    list.write(entry.id, at, 4, 'latin1');
    list.writeBigInt64LE(BigInt(entry.offset), at + 4);
    list.writeBigInt64LE(BigInt(entry.size), at + 12);
  });

  return Buffer.concat([header, ...chunks.map((c) => c.data), list]);
}

// ---- Reading a file laid out from the specification -------------------------

test('a hand-built container parses into its chunks', () => {
  const file = handBuilt([
    { id: 'Comp', data: COMPONENT },
    { id: 'Cont', data: CONTROLLER }
  ]);
  const result = readPreset(file);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.preset.classId, CLASS_ID);
  assert.equal(result.preset.version, 1);
  assert.deepEqual(result.preset.component, COMPONENT);
  assert.deepEqual(result.preset.controller, CONTROLLER);
  assert.equal(result.preset.meta, null);
});

test('the controller half is optional, as it is for plugin_host setState', () => {
  const result = readPreset(handBuilt([{ id: 'Comp', data: COMPONENT }]));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.preset.controller, null);
});

test('chunks we do not model are ignored, not treated as corruption', () => {
  // Real files carry `Info` (XML metadata) and sometimes `Prog`.
  const result = readPreset(handBuilt([
    { id: 'Comp', data: COMPONENT },
    { id: 'Prog', data: Buffer.from('program') },
    { id: 'Info', data: Buffer.from('<MetaInfo/>') }
  ]));
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.preset.component, COMPONENT);
  assert.equal(result.preset.meta.toString(), '<MetaInfo/>');
});

test('a lowercase class id is normalized, so matching stays a string compare', () => {
  const result = readPreset(handBuilt([{ id: 'Comp', data: COMPONENT }],
    { classId: CLASS_ID.toLowerCase() }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.preset.classId, CLASS_ID);
  assert.equal(normalizeClassId('  ' + CLASS_ID.toLowerCase() + '  '), CLASS_ID);
  assert.equal(normalizeClassId('not hex'), null);
  assert.equal(normalizeClassId(CLASS_ID.slice(0, 31)), null);
});

test('the parsed chunk does not alias the source buffer', () => {
  const file = handBuilt([{ id: 'Comp', data: COMPONENT }]);
  const result = readPreset(file);
  file.fill(0);
  assert.deepEqual(result.preset.component, COMPONENT, 'chunks are copied, not viewed');
});

// ---- Refusing malformed and hostile input -----------------------------------

test('malformed containers are refused with a reason, never thrown on', () => {
  const good = handBuilt([{ id: 'Comp', data: COMPONENT }]);

  assert.equal(readPreset(null).reason, 'not-a-buffer');
  assert.equal(readPreset('VST3').reason, 'not-a-buffer');
  assert.equal(readPreset(Buffer.alloc(10)).reason, 'too-short');

  const wrongMagic = Buffer.from(good);
  wrongMagic.write('VST2', 0, 4, 'latin1');
  assert.equal(readPreset(wrongMagic).reason, 'not-a-vstpreset');

  const wrongVersion = Buffer.from(good);
  wrongVersion.writeInt32LE(2, 4);
  assert.equal(readPreset(wrongVersion).reason, 'unsupported-version');

  const badClass = Buffer.from(good);
  badClass.write('zz'.repeat(16), 8, 32, 'latin1');
  assert.equal(readPreset(badClass).reason, 'invalid-class-id');
});

test('a list offset pointing outside the file is refused', () => {
  const good = handBuilt([{ id: 'Comp', data: COMPONENT }]);

  const past = Buffer.from(good);
  past.writeBigInt64LE(BigInt(good.length + 1000), 40);
  assert.equal(readPreset(past).reason, 'invalid-list-offset');

  const negative = Buffer.from(good);
  negative.writeBigInt64LE(-1n, 40);
  assert.equal(readPreset(negative).reason, 'invalid-list-offset');

  // Into the header, where the list id cannot possibly be.
  const intoHeader = Buffer.from(good);
  intoHeader.writeBigInt64LE(8n, 40);
  assert.equal(readPreset(intoHeader).reason, 'invalid-list-offset');

  const huge = Buffer.from(good);
  huge.writeBigInt64LE(0x7fffffffffffffffn, 40);
  assert.equal(readPreset(huge).reason, 'invalid-list-offset');
});

test('a chunk entry may not reach outside the bytes it owns', () => {
  const good = handBuilt([{ id: 'Comp', data: COMPONENT }]);
  const listOffset = Number(good.readBigInt64LE(40));

  // Size stretched past the end of the file: the classic over-read.
  const oversized = Buffer.from(good);
  oversized.writeBigInt64LE(BigInt(good.length), listOffset + 8 + 12);
  assert.equal(readPreset(oversized).reason, 'invalid-chunk-bounds');

  // Offset inside the header, which the entry does not own.
  const intoHeader = Buffer.from(good);
  intoHeader.writeBigInt64LE(0n, listOffset + 8 + 4);
  assert.equal(readPreset(intoHeader).reason, 'invalid-chunk-bounds');

  const negativeOffset = Buffer.from(good);
  negativeOffset.writeBigInt64LE(-8n, listOffset + 8 + 4);
  assert.equal(readPreset(negativeOffset).reason, 'invalid-chunk-bounds');
});

test('an absurd entry count is refused before any allocation', () => {
  const good = handBuilt([{ id: 'Comp', data: COMPONENT }]);
  const listOffset = Number(good.readBigInt64LE(40));

  const tooMany = Buffer.from(good);
  tooMany.writeInt32LE(MAX_ENTRIES + 1, listOffset + 4);
  assert.equal(readPreset(tooMany).reason, 'invalid-entry-count');

  const negative = Buffer.from(good);
  negative.writeInt32LE(-1, listOffset + 4);
  assert.equal(readPreset(negative).reason, 'invalid-entry-count');

  // A plausible count whose entries are not actually there.
  const truncated = Buffer.from(good);
  truncated.writeInt32LE(MAX_ENTRIES, listOffset + 4);
  assert.equal(readPreset(truncated).reason, 'truncated-chunk-list');
});

test('a container without component state cannot be applied and is refused', () => {
  const result = readPreset(handBuilt([{ id: 'Info', data: Buffer.from('<MetaInfo/>') }]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-component-state');
});

// ---- Writing ---------------------------------------------------------------

test('a written container has the exact bytes the specification calls for', () => {
  const result = writePreset({ classId: CLASS_ID, component: COMPONENT, controller: CONTROLLER });
  assert.equal(result.ok, true, result.reason);
  const file = result.buffer;

  assert.equal(file.toString('latin1', 0, 4), 'VST3');
  assert.equal(file.readInt32LE(4), 1);
  assert.equal(file.toString('latin1', 8, 40), CLASS_ID);

  const listOffset = Number(file.readBigInt64LE(40));
  assert.equal(listOffset, HEADER_SIZE + COMPONENT.length + CONTROLLER.length);
  assert.equal(file.toString('latin1', listOffset, listOffset + 4), 'List');
  assert.equal(file.readInt32LE(listOffset + 4), 2);

  // First entry: Comp, straight after the header.
  assert.equal(file.toString('latin1', listOffset + 8, listOffset + 12), 'Comp');
  assert.equal(Number(file.readBigInt64LE(listOffset + 12)), HEADER_SIZE);
  assert.equal(Number(file.readBigInt64LE(listOffset + 20)), COMPONENT.length);

  // Second entry: Cont, straight after Comp.
  assert.equal(file.toString('latin1', listOffset + 28, listOffset + 32), 'Cont');
  assert.equal(Number(file.readBigInt64LE(listOffset + 32)), HEADER_SIZE + COMPONENT.length);
});

test('what we write is byte-identical to a hand-built container', () => {
  const written = writePreset({ classId: CLASS_ID, component: COMPONENT, controller: CONTROLLER });
  const expected = handBuilt([
    { id: 'Comp', data: COMPONENT },
    { id: 'Cont', data: CONTROLLER }
  ]);
  assert.deepEqual(written.buffer, expected);
});

test('a preset survives write then read unchanged', () => {
  const meta = Buffer.from('<MetaInfo><Attribute id="MediaType" value="VstPreset"/></MetaInfo>');
  const written = writePreset({ classId: CLASS_ID, component: COMPONENT, controller: CONTROLLER, meta });
  const back = readPreset(written.buffer);
  assert.equal(back.ok, true, back.reason);
  assert.equal(back.preset.classId, CLASS_ID);
  assert.deepEqual(back.preset.component, COMPONENT);
  assert.deepEqual(back.preset.controller, CONTROLLER);
  assert.deepEqual(back.preset.meta, meta);
});

test('writing refuses what cannot produce a loadable preset', () => {
  assert.equal(writePreset().reason, 'invalid-class-id');
  assert.equal(writePreset({ classId: 'nope', component: COMPONENT }).reason, 'invalid-class-id');
  assert.equal(writePreset({ classId: CLASS_ID }).reason, 'missing-component-state');
  assert.equal(writePreset({ classId: CLASS_ID, component: Buffer.alloc(0) }).reason, 'missing-component-state');
  assert.equal(writePreset({ classId: CLASS_ID, component: 'not a buffer' }).reason, 'invalid-chunk');
  assert.equal(writePreset({ classId: CLASS_ID, component: COMPONENT, controller: 42 }).reason, 'invalid-chunk');
});

test('an omitted optional chunk gets no entry at all', () => {
  const file = writePreset({ classId: CLASS_ID, component: COMPONENT }).buffer;
  const listOffset = Number(file.readBigInt64LE(40));
  assert.equal(file.readInt32LE(listOffset + 4), 1, 'only the component chunk is listed');
  assert.equal(listOffset, HEADER_SIZE + COMPONENT.length);
});

// ---- Against a container written by the SDK itself --------------------------

test('a container written by the Steinberg SDK parses exactly as expected', () => {
  // Regenerate with:
  //   mlh_native_tests.exe --preset-fixture test/fixtures/sdk-written.vstpreset
  // This is the check the module's own round-trip cannot make: reader and
  // writer here could agree on a wrong layout and never notice. The authority
  // wrote these bytes.
  const file = fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-written.vstpreset'));
  const result = readPreset(file);

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.preset.classId, CLASS_ID, 'the scanner class id round-trips through the SDK');
  assert.equal(result.preset.version, 1);
  assert.equal(result.preset.component.toString('latin1'), 'minihub-component-chunk');
  assert.equal(result.preset.controller.toString('latin1'), 'minihub-controller-chunk');
});

test('our writer produces the same bytes the SDK does', () => {
  const sdk = fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-written.vstpreset'));
  const ours = writePreset({
    classId: CLASS_ID,
    component: Buffer.from('minihub-component-chunk', 'latin1'),
    controller: Buffer.from('minihub-controller-chunk', 'latin1')
  });
  assert.equal(ours.ok, true, ours.reason);
  assert.deepEqual(ours.buffer, sdk, 'byte-for-byte identical to the SDK container');
});
