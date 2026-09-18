'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shippedTemplateFiles, installShippedTemplates } = require('../src/main/shippedTemplates');
const { validateProject } = require('../src/main/projectFiles');

const SHIPPED_DIR = path.resolve(__dirname, '../src/main/templates');

/** A temporary folder that cleans itself up, whatever the test does to it. */
function inTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-templates-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('every template MiniHub ships is a project it can open', () => {
  const names = shippedTemplateFiles(SHIPPED_DIR);
  assert.ok(names.length > 0, 'MiniHub ships at least one template');
  for (const name of names) {
    const project = JSON.parse(fs.readFileSync(path.join(SHIPPED_DIR, name), 'utf8'));
    validateProject(project);
    // A shipped file goes to every machine. A plugin inside it would carry a
    // path from the machine it was saved on, to a plugin the user may not own,
    // and the template would open with a node that cannot be filled.
    const plugins = project.nodeInstances.instances.flatMap((node) => node.content?.plugins || []);
    assert.equal(plugins.length, 0, `${name} ships a VST instance`);
    assert.equal(project.name, path.basename(name, '.minihub'),
      'the name inside the file is the name the dialog shows');
  }
});

test('a missing shipped-templates folder is a build without them, not a failure', () => {
  assert.deepEqual(shippedTemplateFiles(path.join(SHIPPED_DIR, 'nowhere')), []);
  assert.deepEqual(installShippedTemplates(path.join(SHIPPED_DIR, 'nowhere'), SHIPPED_DIR), []);
});

test('the first launch furnishes an empty templates folder', () => {
  inTempDir((dir) => {
    const target = path.join(dir, 'Templates');
    const written = installShippedTemplates(SHIPPED_DIR, target);

    assert.deepEqual(written, shippedTemplateFiles(SHIPPED_DIR), 'every shipped template is there');
    assert.deepEqual(fs.readdirSync(target).sort(), written, 'and nothing else');
  });
});

test('a template the user has edited under the same name is never overwritten', () => {
  inTempDir((dir) => {
    const name = shippedTemplateFiles(SHIPPED_DIR)[0];
    const mine = path.join(dir, name);
    fs.writeFileSync(mine, '{"mine":true}', 'utf8');

    assert.deepEqual(installShippedTemplates(SHIPPED_DIR, dir), [],
      'nothing is written over a file that is already there');
    assert.equal(fs.readFileSync(mine, 'utf8'), '{"mine":true}', 'the user\'s version survives');
  });
});

test('a templates folder that cannot be written to still lets MiniHub start', () => {
  const io = {
    readdirSync: () => ['Broken.minihub'],
    existsSync: () => false,
    mkdirSync() { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
    copyFileSync() { throw new Error('never reached'); }
  };
  assert.deepEqual(installShippedTemplates('anywhere', 'E:/gone', io), [],
    'the failure is answered with an empty list, not thrown at the launch path');
});

test('main writes the shipped templates into the folder the user actually uses', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /installShippedTemplates\(SHIPPED_TEMPLATES_DIR, effectiveDirectory\('template'\)\)/,
    'a hard-coded path here would ignore a templates folder the user moved');

  // Before the window: Home offers Templates as soon as it is on screen.
  const ready = main.slice(main.indexOf('app.whenReady()'));
  assert.ok(ready.indexOf('installShippedTemplates') < ready.indexOf('createWindow()'),
    'the folder is furnished before anything can open it');
});
