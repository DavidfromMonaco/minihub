/**
 * The renderer half of the application menu.
 *
 * The menu (`src/main/appMenu.js`) knows only the name of a command; this is
 * where the name becomes an action, right on top of `hub.project`, which is the
 * one place that knows whether the action is allowed at all -- a project being
 * recorded into refuses to be replaced, a dirty one asks before it is dropped.
 * Putting the mapping here rather than in the shell keeps the menu working on
 * every page, including the ones with no header controls of their own.
 */

const ACTIONS = new Map([
  ['project:new', (hub) => hub.project.newProject()],
  ['project:template', (hub) => hub.project.newFromBasicTemplate()],
  ['project:open', (hub) => hub.project.load()],
  ['project:save', (hub) => hub.project.save(false)],
  ['project:save-as', (hub) => hub.project.save(true)]
]);

/** The commands answered here, in the order the menu lists them. */
export const MENU_COMMANDS = Object.freeze([...ACTIONS.keys()]);

/**
 * Subscribe to the menu. Returns the unsubscribe the caller keeps.
 *
 * A command with no action is dropped in silence: that state means the menu and
 * this map have drifted apart, and guessing which action was meant is worse
 * than doing nothing. The pairing is checked by test/menuCommands.test.mjs.
 */
export function bindMenuCommands(hub, api = globalThis.hubAPI) {
  if (typeof api?.onMenuCommand !== 'function') return () => {};
  return api.onMenuCommand((command) => {
    const run = ACTIONS.get(command);
    if (run) run(hub);
  });
}
