'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { audioExportFormat, audioExportFilePath } = require('../src/main/audioExportPath');

test('audio export dialog canonicalizes one codec extension', () => {
  assert.equal(audioExportFormat('MP3'), 'mp3');
  assert.equal(audioExportFormat('unknown'), 'wav');
  assert.equal(audioExportFilePath('C:\\Music\\track.mp3.wav', 'mp3'), 'C:\\Music\\track.mp3');
  assert.equal(audioExportFilePath('C:\\Music\\track.wav', 'ogg'), 'C:\\Music\\track.ogg');
  assert.equal(audioExportFilePath('C:\\Music\\track', 'wav'), 'C:\\Music\\track.wav');
});
