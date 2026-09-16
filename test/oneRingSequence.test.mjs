import test from 'node:test';
import assert from 'node:assert/strict';
import { VALUE_TYPE } from '../src/renderer/js/core/commandRegistry.js';
import {
  CHANNEL_COUNT, CONDITION, MAX_STEPS, MUTABLE, SCENE_POSITION, SCENE_TIMING, STEP_MODE, VALUE_MODE,
  cellAt, cellsOf, clearCells, createSequence, defaultSource, emptyCell, emptyChannel, emptySource,
  fromVstState, mutateChannel, mutateSequence, parseSeed, readSequence, reseed, retarget, sequenceErrors,
  setCell, storeScene, targetFinder, toVstState, withCells
} from '../src/renderer/js/core/oneRingSequence.js';

const int = (value) => ({ type: VALUE_TYPE.integer, value });
const num = (value) => ({ type: VALUE_TYPE.number, value });
const velocity = { id: 'VELOCITY', label: 'Velocity', type: VALUE_TYPE.integer, minimum: 0, maximum: 127 };
const play = { id: 'PLAY', label: 'Play', type: VALUE_TYPE.none, releaseCommand: 'STOP' };
const fire = { id: 'FIRE', label: 'Fire', type: VALUE_TYPE.none };
const external = [{
  id: 'mixer-2:master',
  commands: new Map([[velocity.id, velocity], [play.id, play], [fire.id, fire]])
}];

// A VST state as One Ring 0.4 writes it, every cell out, with a few programmed.
function vstState() {
  const state = toVstState(createSequence());
  const channel = state.scenes[1].channels[4];
  channel.target = { target: 'mixer-2:master', command: 'VELOCITY', value: emptySource() };
  channel.length = 32;
  channel.steps = channel.steps.map((cell) => ({ ...cell, value: { ...emptySource(), fixed: int(0) } }));
  channel.steps[3] = { ...channel.steps[3], enabled: true, probability: 60,
    conditions: [{ kind: CONDITION.everyNth, interval: 3, channel: 0 }] };
  channel.steps[9] = { ...channel.steps[9], enabled: true,
    value: { ...emptySource(), mode: VALUE_MODE.range, min: int(10), max: int(90) } };
  state.scenes[0].channels[0].follow = [{ target: 'one-ring:channel:2', command: 'START', value: emptySource() }];
  state.seed = '18446744073709551615';
  state.mutation = '12';
  state.selectedScene = 1;
  state.sceneTiming = SCENE_TIMING.nextBar;
  state.scenePosition = SCENE_POSITION.keep;
  return state;
}

test('a new sequence is four empty scenes, valid, and small', () => {
  const content = createSequence();
  assert.equal(content.scenes.length, 4);
  assert.ok(content.scenes.every((scene) => scene.channels.length === CHANNEL_COUNT));
  assert.deepEqual(content.scenes.map((scene) => scene.name), ['Scene A', 'Scene B', 'Scene C', 'Scene D']);
  assert.deepEqual(sequenceErrors(content, targetFinder(content)), []);
  assert.ok(JSON.stringify(content).length < 40000, `${JSON.stringify(content).length} characters`);
});

test('a VST state comes in sparse and goes back out unchanged', () => {
  const state = vstState();
  const content = fromVstState(state);
  assert.deepEqual(toVstState(content), state);
  const typed = content.scenes[1].channels[4];
  assert.deepEqual(typed.blank.value.fixed, int(0), 'the command\'s default value is the blank');
  assert.deepEqual(typed.steps.map((step) => step.index), [3, 9], 'only the two programmed cells are listed');
  assert.ok(JSON.stringify(content).length * 10 < JSON.stringify(state).length,
    `${JSON.stringify(content).length} characters for ${JSON.stringify(state).length}`);
  assert.equal(content.seed, '18446744073709551615');
  assert.equal(content.selectedScene, 1);
});

test('the content reads back as itself, and a channel\'s cells come from its blank and its list', () => {
  const content = fromVstState(vstState());
  assert.deepEqual(readSequence(JSON.parse(JSON.stringify(content))), content);
  const typed = content.scenes[1].channels[4];
  assert.deepEqual(cellAt(typed, 0), typed.blank);
  assert.equal(cellAt(typed, 3).probability, 60);
  assert.equal(cellsOf(typed).length, MAX_STEPS);
  assert.equal(cellsOf(typed)[9].value.mode, VALUE_MODE.range);
});

test('the same cells always give the same channel, the empty cell winning a tie', () => {
  const half = Array.from({ length: MAX_STEPS }, (_, i) => (i % 2 ? { ...emptyCell(), enabled: true } : emptyCell()));
  const channel = withCells(emptyChannel(), half);
  assert.deepEqual(channel.blank, emptyCell());
  assert.equal(channel.steps.length, 32);
  assert.deepEqual(withCells(emptyChannel(), cellsOf(channel)), channel);
});

test('what the engine refuses to read is refused here first, naming the field', () => {
  const state = vstState();
  const broken = [
    [{ ...state, version: 2 }, /version/],
    [{ ...state, seed: '18446744073709551616' }, /seed/],
    [{ ...state, seed: '12abc' }, /seed/],
    [{ ...state, sceneTiming: 2 }, /scene behavior/],
    [{ ...state, scenes: [] }, /missing scenes/]
  ];
  for (const [raw, message] of broken) assert.throws(() => readSequence(raw), message);

  const fewer = structuredClone(state);
  fewer.scenes[2].channels.pop();
  assert.throws(() => readSequence(fewer), /scenes\[2\]: a scene must contain 16 channels/);
  const truncated = structuredClone(state);
  truncated.scenes[0].channels[1].steps.pop();
  assert.throws(() => readSequence(truncated), /64 authored cells/);
  const badValue = structuredClone(state);
  badValue.scenes[0].channels[1].steps[5].value.fixed = { type: VALUE_TYPE.integer, value: 1.5 };
  assert.throws(() => readSequence(badValue), /scenes\[0\]\.channels\[1\]\.steps\[5\]\.value\.fixed/);

  const content = fromVstState(state);
  const past = structuredClone(content);
  past.scenes[1].channels[4].steps[0].index = 64;
  assert.throws(() => readSequence(past), /index from 0 to 63/);
  const twice = structuredClone(content);
  twice.scenes[1].channels[4].steps[1].index = 3;
  assert.throws(() => readSequence(twice), /listed twice/);
  assert.throws(() => readSequence('not a state'), /is an object/);
});

test('the VST\'s checks: lengths, timing, legato, values, conditions', () => {
  const base = fromVstState(vstState());
  const find = targetFinder(base, external);
  assert.deepEqual(sequenceErrors(base, find), []);
  const edit = (change) => {
    const content = structuredClone(base);
    change(content.scenes[1].channels[4], content);
    return sequenceErrors(content, targetFinder(content, external));
  };
  assert.deepEqual(edit((channel) => { channel.length = 5; }), ['Channel length must be 4, 8, 16, 32 or 64']);
  assert.deepEqual(edit((channel) => { channel.swing = 1; }), ['Invalid timing parameters']);
  assert.deepEqual(edit((channel) => { channel.repeats = 5; }), ['Invalid repeat count']);
  assert.deepEqual(edit((channel) => { channel.mode = STEP_MODE.legato; }), ['Target has not declared a legato release']);
  assert.deepEqual(edit((channel) => { channel.steps[1].value.max = int(128); }), ['Invalid step value']);
  assert.deepEqual(edit((channel) => { channel.blank.value.fixed = int(-1); }), ['Invalid step value'],
    'a blank out of range is every unlisted cell out of range');
  assert.deepEqual(edit((channel) => { channel.steps[0].conditions[0].interval = 0; }), ['Loop interval must be positive']);
  assert.deepEqual(edit((channel) => { channel.steps[0].conditions = [{ kind: CONDITION.ifActive, interval: 2, channel: 16 }]; }),
    ['Condition channel is outside CH1-CH16']);
  assert.deepEqual(edit((channel) => { channel.steps[0].probability = 101; }), ['Probability must be between 0 and 100']);
  assert.deepEqual(edit((_, content) => { content.selectedScene = 4; }), ['Missing selected scene']);
  assert.deepEqual(edit((_, content) => { content.scenes[3].id = 'A'; }), ['Missing or duplicate scene ID']);
  assert.deepEqual(edit((_, content) => {
    content.scenes[0].channels[0].follow = [{ target: 'one-ring:scenes', command: 'RECALL', value: { ...emptySource(), fixed: { type: VALUE_TYPE.choice, value: 4 } } }];
  }), ['Invalid follow action'], 'a recall of a fifth scene is refused');
  assert.deepEqual(edit((channel) => {
    channel.target = { target: 'arpeggiator-9:rate', command: 'RATE', value: emptySource() };
  }), [], 'a target nothing answers for stays authored');
  const legato = edit((channel) => {
    channel.target.command = 'PLAY';
    channel.blank.value = emptySource();
    channel.steps.forEach((step) => { step.value = emptySource(); });
    channel.mode = STEP_MODE.legato;
  });
  assert.deepEqual(legato, [], 'legato on a command with a release');
});

test('MUTATE draws what the engine draws', () => {
  // The same channel, seed, count and index as [core] one-ring-mutation.
  const cells = Array.from({ length: MAX_STEPS }, () => emptyCell());
  cells[1].value = { ...emptySource(), mode: VALUE_MODE.range, min: int(50), max: int(90) };
  cells[2].value = { ...emptySource(), mode: VALUE_MODE.choice, choices: [int(20), int(70), int(90)] };
  cells[3].value = { ...emptySource(), mode: VALUE_MODE.range, min: num(0.1), max: num(0.9) };
  Object.assign(cells[4], { locked: true, enabled: true, probability: 30 });
  Object.assign(cells[5], { lockedFields: MUTABLE.probability, probability: 35 });
  cells[6].value = { ...emptySource(), mode: VALUE_MODE.range, min: int(10), max: int(20) };
  cells[6].lockedFields = MUTABLE.value;
  const channel = withCells({ ...emptyChannel(), length: 8 }, cells);
  const before = structuredClone(channel);
  const out = cellsOf(mutateChannel(channel, '123456789', '2', 5));
  assert.deepEqual(channel, before, 'the channel given is left alone');
  assert.deepEqual(out.slice(0, 8).map((cell) => cell.enabled), [true, true, true, false, true, false, true, true]);
  assert.deepEqual(out.slice(0, 8).map((cell) => cell.probability), [19, 8, 84, 85, 30, 35, 75, 34]);
  assert.deepEqual([out[1].value.min, out[1].value.max], [int(62), int(88)]);
  assert.deepEqual(out[2].value.choices, [int(70), int(90), int(20)]);
  assert.deepEqual([out[3].value.min, out[3].value.max], [num(0.37355332308359285), num(0.67537876894130189)]);
  assert.deepEqual([out[6].value.min, out[6].value.max], [int(10), int(20)]);
  assert.deepEqual(out[8], emptyCell(), 'nothing past the channel\'s length');
});

test('MUTATE counts once per press, on one channel or all of a scene', () => {
  const content = fromVstState(vstState());
  const one = mutateSequence(content, { scene: 1, channel: 4 });
  assert.equal(one.mutation, '13');
  assert.notDeepEqual(one.scenes[1].channels[4], content.scenes[1].channels[4]);
  assert.deepEqual(one.scenes[1].channels[3], content.scenes[1].channels[3]);
  assert.deepEqual(one.scenes[0], content.scenes[0]);
  const all = mutateSequence(content, { scene: 0 });
  assert.equal(all.mutation, '13');
  assert.ok(all.scenes[0].channels.every((channel, c) => channel !== content.scenes[0].channels[c]));
  const wrapped = mutateSequence({ ...content, mutation: '18446744073709551615' }, { scene: 0, channel: 0 });
  assert.equal(wrapped.mutation, '0', 'the count wraps as the VST\'s 64-bit counter does');
  assert.throws(() => mutateSequence(content, { scene: 4 }), RangeError);
  assert.throws(() => mutateSequence(content, { scene: 0, channel: 16 }), RangeError);
});

test('NEW SEED picks a 64-bit seed or takes the one given, and restarts the count', () => {
  const content = fromVstState(vstState());
  const given = reseed(content, ' 42 ');
  assert.equal(given.seed, '42');
  assert.equal(given.mutation, '0');
  const drawn = reseed(content);
  assert.match(drawn.seed, /^\d{1,20}$/);
  assert.ok(BigInt(drawn.seed) < 1n << 64n);
  assert.throws(() => reseed(content, '-1'), RangeError);
  assert.equal(parseSeed('18446744073709551616'), null);
  assert.equal(parseSeed('007'), '7');
});

test('a command change gives every cell its default and keeps which cells are active', () => {
  const content = fromVstState(vstState());
  const channel = content.scenes[1].channels[4];
  const legato = { ...channel, mode: STEP_MODE.legato };
  const aimed = retarget(legato, 'mixer-2:master', 'PLAY', play);
  assert.equal(aimed.mode, STEP_MODE.trigger);
  assert.deepEqual(aimed.target, { target: 'mixer-2:master', command: 'PLAY', value: emptySource() });
  assert.deepEqual(aimed.blank.value, emptySource());
  assert.deepEqual(aimed.steps.map((step) => [step.index, step.enabled]), [[3, true], [9, true]]);
  assert.ok(aimed.steps.every((step) => step.value.mode === VALUE_MODE.fixed && step.value.fixed.type === VALUE_TYPE.none));
  assert.deepEqual(defaultSource(velocity).fixed, int(0));
  assert.deepEqual(defaultSource({ type: VALUE_TYPE.number, minimum: 20.5, maximum: 300 }).fixed, num(20.5));
  assert.deepEqual(defaultSource({ type: VALUE_TYPE.boolean }).fixed, { type: VALUE_TYPE.boolean, value: false });
  assert.deepEqual(defaultSource({ type: VALUE_TYPE.choice, choices: [{ id: 9, label: 'Down' }] }).fixed,
    { type: VALUE_TYPE.choice, value: 9 });
  assert.deepEqual(defaultSource(null), emptySource());
  const cleared = clearCells(channel, velocity);
  assert.deepEqual(cleared.steps, []);
  assert.deepEqual(cleared.blank, { ...emptyCell(), value: defaultSource(velocity) });
});

test('a cell set, and a scene stored into another, leave the content they came from alone', () => {
  const content = fromVstState(vstState());
  const channel = content.scenes[1].channels[4];
  const before = structuredClone(content);
  const set = setCell(channel, 20, { ...cellAt(channel, 20), enabled: true });
  assert.deepEqual(set.steps.map((step) => step.index), [3, 9, 20]);
  assert.throws(() => setCell(channel, 64, emptyCell()), RangeError);
  const stored = storeScene(content, 1, 3);
  assert.deepEqual(stored.scenes[3].channels, content.scenes[1].channels);
  assert.equal(stored.scenes[3].id, 'D');
  assert.equal(stored.scenes[3].name, 'Scene D');
  assert.equal(storeScene(content, 2, 2), content);
  assert.throws(() => storeScene(content, 0, 4), RangeError);
  assert.deepEqual(content, before);
});
