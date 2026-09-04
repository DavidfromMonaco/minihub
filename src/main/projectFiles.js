'use strict';

const fs = require('fs');
const path = require('path');

const FORMAT = 'minihub-project';
const VERSION = 1;

function validateProject(value) {
  if (!value || typeof value !== 'object') throw new Error('Project file is not an object');
  if (value.format !== FORMAT) throw new Error('Not a MiniHub project');
  if (value.version !== VERSION) throw new Error(`Unsupported MiniHub project version: ${value.version}`);
  if (!value.projectId || typeof value.projectId !== 'string') throw new Error('Project is missing projectId');
  if (!value.name || typeof value.name !== 'string') throw new Error('Project is missing name');
  if (!value.network || typeof value.network !== 'object') throw new Error('Project is missing network state');
  if (!Array.isArray(value.nodeInstances?.instances)) throw new Error('Project is missing node instances');
  return value;
}

function readProject(filePath) {
  return validateProject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeProjectAtomic(filePath, project, io = fs) {
  validateProject(project);
  const dir = path.dirname(filePath);
  io.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    io.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf8');
    io.renameSync(tmp, filePath);
  } catch (error) {
    try { io.rmSync(tmp, { force: true }); } catch (_) {}
    throw error;
  }
  return filePath;
}

module.exports = { FORMAT, VERSION, validateProject, readProject, writeProjectAtomic };
