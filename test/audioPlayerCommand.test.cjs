'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidSyncAudioPlayersCommand, isValidAudioPlayerTransportCommand } = require('../src/main/audioPlayerCommand');
const { ALLOWED_ENGINE_COMMANDS } = require('../src/main/engineCommandPolicy');
const { PERIODIC_EVENTS, createEngineEventTrace } = require('../src/main/engineEventTrace');

test('the two commands of the Audio Players are on the allow-list, and their events are not', () => {
  for (const type of ['syncAudioPlayers', 'audioPlayerTransport']) {
    assert.equal(ALLOWED_ENGINE_COMMANDS.has(type), true, type);
  }
  for (const type of ['audioPlayerFile', 'audioPlayerStatus', 'audioPlayerTransportResult']) {
    assert.equal(ALLOWED_ENGINE_COMMANDS.has(type), false, `${type} comes from the engine, never to it`);
  }
});

test('where a player is, ten times a second, is a stream the startup log does not write down', () => {
  assert.equal(PERIODIC_EVENTS.has('audioPlayerStatus'), true);
  const trace = createEngineEventTrace();
  assert.equal(trace({ type: 'audioPlayerStatus' }), null);
  assert.equal(trace({ type: 'audioPlayerFile' }), 'engine:event audioPlayerFile', 'a file loaded is worth a line');
});

test('the list goes to the engine only as named players with a path and a loop', () => {
  const player = { nodeId: 'audio-player-001', filePath: 'C:\\Loops\\drums.wav', loop: false };
  const sync = { v: 1, type: 'syncAudioPlayers', players: [player] };
  assert.equal(isValidSyncAudioPlayersCommand(sync), true);
  assert.equal(isValidSyncAudioPlayersCommand({ ...sync, players: [] }), true, 'no player is a list too');
  assert.equal(isValidSyncAudioPlayersCommand({ ...sync, players: [{ ...player, filePath: '' }] }), true);
  assert.equal(isValidSyncAudioPlayersCommand({ ...sync, players: [{ ...player, describe: true, reload: false }] }), true);
  for (const broken of [
    { ...sync, v: 2 },
    { ...sync, players: undefined },
    { ...sync, players: Array.from({ length: 65 }, (_, i) => ({ ...player, nodeId: `audio-player-${i + 1}` })) },
    { ...sync, players: [{ ...player, nodeId: '../x' }] },
    { ...sync, players: [{ ...player, filePath: 7 }] },
    { ...sync, players: [{ ...player, filePath: 'C:\\a\0.wav' }] },
    { ...sync, players: [{ ...player, filePath: 'x'.repeat(32768) }] },
    { ...sync, players: [{ ...player, loop: 'yes' }] },
    { ...sync, players: [{ ...player, describe: 1 }] },
    { ...sync, players: [null] }
  ]) assert.equal(isValidSyncAudioPlayersCommand(broken), false, JSON.stringify(broken).slice(0, 120));
});

test('a player is played, paused, stopped or placed, and placed only at a position', () => {
  const base = { v: 1, type: 'audioPlayerTransport', nodeId: 'audio-player-001' };
  for (const action of ['play', 'pause', 'stop']) {
    assert.equal(isValidAudioPlayerTransportCommand({ ...base, action }), true, action);
    assert.equal(isValidAudioPlayerTransportCommand({ ...base, action, seconds: 1 }), false, `${action} takes no position`);
  }
  assert.equal(isValidAudioPlayerTransportCommand({ ...base, action: 'seek', seconds: 2.5 }), true);
  assert.equal(isValidAudioPlayerTransportCommand({ ...base, action: 'seek', seconds: 0 }), true);
  for (const broken of [
    { ...base, action: 'seek' },
    { ...base, action: 'seek', seconds: -1 },
    { ...base, action: 'seek', seconds: Infinity },
    { ...base, action: 'rewind' },
    { ...base, action: 'play', nodeId: '' },
    { ...base, action: 'play', v: 0 }
  ]) assert.equal(isValidAudioPlayerTransportCommand(broken), false, JSON.stringify(broken));
});
