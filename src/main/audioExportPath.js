'use strict';

const path = require('node:path');

const FORMATS = Object.freeze({
  wav: { label: 'WAV Audio', extension: 'wav' },
  mp3: { label: 'MP3 Audio', extension: 'mp3' },
  ogg: { label: 'OGG Vorbis Audio', extension: 'ogg' }
});

function audioExportFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return Object.hasOwn(FORMATS, format) ? format : 'wav';
}

function audioExportFilePath(filePath, requestedFormat) {
  const format = audioExportFormat(requestedFormat);
  const parsed = path.parse(String(filePath || ''));
  let stem = parsed.name || 'MiniHub Mix';
  // Electron may append the selected filter extension to a user-entered codec
  // extension. Strip every known trailing codec suffix before adding exactly
  // one canonical extension (track.mp3.wav -> track.mp3 for MP3 export).
  while (/\.(wav|mp3|ogg)$/i.test(stem)) stem = stem.replace(/\.(wav|mp3|ogg)$/i, '');
  return path.join(parsed.dir, `${stem}.${FORMATS[format].extension}`);
}

module.exports = { FORMATS, audioExportFormat, audioExportFilePath };
