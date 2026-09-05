/**
 * Importing a profile, from the file the user picked to the window reload.
 *
 * The property this locks: **a refused file leaves nothing behind.** Judging
 * happens in the renderer, before anything reaches the profiles folder, so a
 * profile that does not validate is never stored, never listed, and never has to
 * be found and deleted later. The other half is that a refusal SAYS WHY, with
 * every fault the validator found — a hand-written profile is fixed in one pass
 * or one round trip per mistake, and the person fixing it is usually the person
 * who wrote it.
 *
 * The panel is checked in two halves, because `test/domShim.mjs` is not a
 * browser and does not parse HTML: the markup as text, and the binding against
 * buttons built by hand. Pretending to have a DOM would prove less, not more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reviewProfileText } from '../src/renderer/js/core/profileImport.js';
import {
  controllerProfileSectionHtml,
  bindControllerProfileSection
} from '../src/renderer/js/ui/controllerProfileSection.js';

const vegaText = () => fs.readFileSync(new URL('./conformance/vega-49.json', import.meta.url), 'utf8');

// ---------------------------------------------------------------- judging ---

test('a legal profile is read, and says what it is before it is trusted', () => {
  const review = reviewProfileText(vegaText());
  assert.equal(review.ok, true);
  assert.deepEqual(review.faults, []);
  assert.equal(review.summary.profileId, 'vega-49');
  // Specification 4.5: a profile does not get to grade itself, so the summary is
  // computed. It is what tells a user the file he just found is half-guessed.
  assert.equal(review.summary.declared, 10);
  assert.equal(typeof review.summary.observed, 'number');
  assert.equal(review.summary.placed, true, 'this one carries coordinates');
});

test('what is not JSON is refused where a person can act on it', () => {
  const review = reviewProfileText('{ "formatVersion": 1,');
  assert.equal(review.ok, false);
  assert.match(review.faults[0], /not valid JSON/);
  assert.equal(reviewProfileText('').ok, false);
  assert.equal(reviewProfileText(null).ok, false);
});

test('an invalid profile comes back with its faults, not with the first one', () => {
  const broken = JSON.parse(vegaText());
  broken.controls[0].id = 'Dial One';
  broken.controls[1].bindings[0].mode = 'wat';
  broken.profileId = 'Vega 49';

  const review = reviewProfileText(JSON.stringify(broken));
  assert.equal(review.ok, false);
  assert.equal(review.profile, null, 'nothing usable comes out of a refusal');
  assert.ok(review.faults.length >= 3, 'every fault, so the file is fixed in one pass');
  for (const fault of review.faults) assert.match(fault, /^profile\./, 'each fault names its field');
});

test('a wall of faults is cut short rather than shown whole', () => {
  const broken = JSON.parse(vegaText());
  for (const control of broken.controls) control.id = 'NOT AN ID';
  const review = reviewProfileText(JSON.stringify(broken));
  assert.equal(review.ok, false);
  assert.ok(review.faults.length <= 9);
  assert.match(review.faults.at(-1), /more\.$/);
});

// ----------------------------------------------------------------- markup ---

const listed = [{ fileName: 'vega-49.json', profileId: 'vega-49', name: 'Vega 49', controls: 10, error: null }];

test('the built-in profile is an entry, not a special case', () => {
  const html = controllerProfileSectionHtml({ selected: 'vega-49.json', profiles: listed });
  assert.match(html, /Built in/);
  assert.match(html, /data-profile-use=""/, 'going back to the shipped profile is one click, like any other');
  assert.match(html, /reloads the window/, 'said before the click, or a reload reads as a crash');
});

test('the profile in use is marked rather than offered again, and cannot be removed from here', () => {
  const html = controllerProfileSectionHtml({ selected: 'vega-49.json', profiles: listed });
  assert.match(html, /In use/);
  assert.doesNotMatch(html, /data-profile-use="vega-49\.json"/);
  // Removing it is refused by main; not offering it here is the same answer,
  // one step earlier.
  assert.doesNotMatch(html, /data-profile-forget="vega-49\.json"/);
});

test('a profile file that will not parse is listed so it can be removed', () => {
  const html = controllerProfileSectionHtml({
    selected: null,
    profiles: [{ fileName: 'broken-one.json', profileId: null, name: null, controls: null, error: 'Unexpected token' }]
  });
  assert.match(html, /broken-one\.json/);
  assert.match(html, /Unreadable/);
  assert.match(html, /data-profile-forget="broken-one\.json"/,
    'a file the panel hides is a file the user cannot delete');
});

test('faults and outcomes reach the panel rather than the console', () => {
  const html = controllerProfileSectionHtml({
    selected: null,
    profiles: [],
    faults: ['profile.controls[0].id must be lowercase letters, digits and single hyphens'],
    message: { ok: false, text: 'broken.json was not imported.' }
  });
  assert.match(html, /profile-faults/);
  assert.match(html, /must be lowercase/);
  assert.match(html, /was not imported/);
});

// ---------------------------------------------------------------- binding ---

/** A button the binder can attach to, and the test can press. */
function button(dataset = {}) {
  const handlers = [];
  return {
    dataset,
    addEventListener: (_type, handler) => handlers.push(handler),
    press: () => handlers[0]()
  };
}

/** The three queries `bindControllerProfileSection` makes, and nothing else. */
function fakeRoot({ importButton = null, use = [], forget = [] }) {
  return {
    querySelector: (selector) => (selector === '#profile-import' ? importButton : null),
    querySelectorAll: (selector) => {
      if (selector === '[data-profile-use]') return use;
      if (selector === '[data-profile-forget]') return forget;
      return [];
    }
  };
}

function fakeHub({ pick, imported = { ok: true }, selected = { ok: true }, forgotten = { ok: true } }) {
  const calls = [];
  return {
    calls,
    hub: {
      api: {
        profilePick: async () => { calls.push(['pick']); return pick; },
        profileImport: async (text) => { calls.push(['import', text.length]); return imported; },
        profileSelect: async (fileName) => { calls.push(['select', fileName]); return selected; },
        profileForget: async (fileName) => { calls.push(['forget', fileName]); return forgotten; }
      }
    }
  };
}

test('a profile that fails validation is never handed to main', async () => {
  const importButton = button();
  const outcomes = [];
  const { hub, calls } = fakeHub({ pick: { fileName: 'broken.json', text: '{ nope', error: null } });
  let reloaded = false;

  bindControllerProfileSection(fakeRoot({ importButton }), hub, {
    refresh: (outcome) => outcomes.push(outcome),
    reload: () => { reloaded = true; }
  });
  await importButton.press();

  assert.deepEqual(calls, [['pick']], 'nothing reached the profiles folder');
  assert.equal(reloaded, false, 'and nothing was restarted');
  assert.ok(outcomes[0].faults.length, 'the faults are what the user gets instead');
  assert.equal(outcomes[0].message.ok, false);
});

test('a legal profile is stored, and the window is restarted', async () => {
  const importButton = button();
  const { hub, calls } = fakeHub({ pick: { fileName: 'vega-49.json', text: vegaText(), error: null } });
  let reloaded = false;

  bindControllerProfileSection(fakeRoot({ importButton }), hub, {
    refresh: () => {}, reload: () => { reloaded = true; }
  });
  await importButton.press();

  assert.equal(calls[0][0], 'pick');
  assert.equal(calls[1][0], 'import');
  assert.equal(reloaded, true, 'the profile is resolved at launch, so nothing else can apply it');
});

test('a cancelled picker is not a failure', async () => {
  const importButton = button();
  const outcomes = [];
  const { hub, calls } = fakeHub({ pick: null });
  bindControllerProfileSection(fakeRoot({ importButton }), hub, {
    refresh: (outcome) => outcomes.push(outcome), reload: () => {}
  });
  await importButton.press();
  assert.deepEqual(calls, [['pick']]);
  assert.deepEqual(outcomes, [], 'changing your mind deserves no message at all');
});

test('a file main could not even read is reported without being judged', async () => {
  const importButton = button();
  const outcomes = [];
  const { hub, calls } = fakeHub({ pick: { fileName: 'gone.json', text: null, error: 'EACCES' } });
  bindControllerProfileSection(fakeRoot({ importButton }), hub, {
    refresh: (outcome) => outcomes.push(outcome), reload: () => {}
  });
  await importButton.press();
  assert.deepEqual(calls, [['pick']]);
  assert.deepEqual(outcomes[0].faults, ['EACCES']);
});

test('an empty value means the built-in profile, not a file called ""', async () => {
  const builtIn = button({ profileUse: '' });
  const { hub, calls } = fakeHub({});
  let reloaded = false;
  bindControllerProfileSection(fakeRoot({ use: [builtIn] }), hub, {
    refresh: () => {}, reload: () => { reloaded = true; }
  });
  await builtIn.press();
  assert.deepEqual(calls, [['select', null]]);
  assert.equal(reloaded, true);
});

test('a refusal from main is reported rather than assumed away', async () => {
  const forget = button({ profileForget: 'vega-49.json' });
  const outcomes = [];
  const { hub } = fakeHub({ forgotten: { ok: false, error: 'this profile is the one in use' } });
  bindControllerProfileSection(fakeRoot({ forget: [forget] }), hub, {
    refresh: (outcome) => outcomes.push(outcome), reload: () => {}
  });

  await forget.press();
  assert.equal(outcomes[0].message.ok, false);
  assert.match(outcomes[0].message.text, /in use/);
});

test('removing a profile redraws the list instead of restarting the window', async () => {
  const forget = button({ profileForget: 'vega-49.json' });
  const outcomes = [];
  const { hub, calls } = fakeHub({});
  let reloaded = false;
  bindControllerProfileSection(fakeRoot({ forget: [forget] }), hub, {
    refresh: (outcome) => outcomes.push(outcome), reload: () => { reloaded = true; }
  });

  await forget.press();
  assert.deepEqual(calls, [['forget', 'vega-49.json']]);
  assert.equal(reloaded, false, 'nothing about the running profile changed, so nothing restarts');
  assert.equal(outcomes[0].message.ok, true);
});

/**
 * The way out of the Learn panel.
 *
 * The controls it draws come from the loaded profile, so a user whose keyboard
 * is not the one on the drawing is looking at a dead end: nothing on that page
 * said where a profile is chosen. It points at the device's own page now — which
 * is also where the section above lives, so there is one place and not two.
 */
test('the Learn panel offers a way to the controller page', async () => {
  const { renderControlBindings } = await import('../src/renderer/js/core/nodeInstances.js');
  const hub = { control: null, network: { listNodes: () => [] } };
  const html = renderControlBindings({ id: 'vst-001', content: { controlBindings: [] } }, hub);
  assert.match(html, /id="control-open-controller"/,
    'a panel drawn from a profile must say where a profile is chosen');
});

/**
 * The button was there and did nothing, on the first real run.
 *
 * It navigated to the controller's NODE id while the module system is keyed by
 * the controller's PAGE id, and those are two different strings.
 * `ModuleSystem.activate()` answers `false` for an id it does not know and says
 * nothing at all, so a wrong identity here is invisible to every test that does
 * not join the two ends. This joins them.
 *
 * The answer was not a better constant but a question: the shell asks which
 * module owns the controller's routing node, the way it already asks the network
 * what the controller is called. A shell that spells a page id is a shell that
 * can spell the wrong one.
 */
test('the shell finds the controller page by asking, and finds the right one', async () => {
  const { controllerModuleId } = await import('../src/renderer/js/core/controllerNode.js');
  const { createMiniLabModule } = await import('../src/renderer/js/modules/minilab/minilabModule.js');
  const hub = { settings: { get: () => null }, events: { on: () => () => {} }, midi: {}, api: {} };
  const controller = createMiniLabModule(hub);

  const modules = {
    list: () => [
      { id: 'home' },
      { id: 'audio-output', routingNode: { type: 'audio-output', outputs: [] } },
      controller
    ]
  };
  assert.equal(controllerModuleId(modules), controller.id);
  assert.notEqual(controllerModuleId(modules), controller.routingNode.id,
    'the page is deliberately not the node, which is what made the button dead');

  // Nothing to open, rather than something wrong to open.
  assert.equal(controllerModuleId({ list: () => [{ id: 'home' }] }), null);
  assert.equal(controllerModuleId(undefined), null);
});

test('the Learn panel opens the page it was told, and nothing when there is none', async () => {
  const source = fs.readFileSync(
    new URL('../src/renderer/js/core/nodeInstances.js', import.meta.url), 'utf8'
  );
  // Read from the source deliberately: the navigation lives in a delegated click
  // handler built inside `mount()`, and reaching it means standing up the whole
  // VST editor against a shim that does not parse HTML. What broke was one
  // identifier, and this is what pins it.
  const branch = /control-open-controller[\s\S]{0,260}?activate\(\s*([^,\s]+)/.exec(source)?.[1];
  assert.equal(branch, 'page',
    'the panel must navigate to what controllerModuleId() answered, not to a name it knows');
  assert.match(source, /const page = controllerModuleId\(hub\.modules\)/);
});
