/**
 * What a module's CTRL IN accepts: typed commands, described by the module that
 * owns them.
 *
 * WHY A MODULE DESCRIBES ITS OWN COMMANDS
 * ---------------------------------------
 * A plugin that sequences MiniHub (One Ring is the first) must never learn what
 * an arpeggiator is. It is handed a list -- targets, commands, value types,
 * ranges, choices -- and it sends back a target id, a command id and a value.
 * So the list is written where the behaviour lives: `controlCommands()` on the
 * module, beside its routing node. A module added later is commandable the day
 * it declares one, with no change to `commandBus.js` and none to the plugin.
 *
 * WHY THE CHECKS ARE THIS STRICT
 * ------------------------------
 * The plugin rejects a whole registry for one malformed entry -- an empty label,
 * an id longer than its fixed buffer, a duplicate choice -- and a rejected
 * registry leaves it with no target at all. A provider's mistake has to fail
 * here, where a test sees it and where it costs that provider its own targets
 * instead of every module's.
 */

/** The value a command carries. The numbers are the plugin's wire format. */
export const VALUE_TYPE = Object.freeze({ none: 0, boolean: 1, integer: 2, number: 3, choice: 4 });

// The plugin copies ids into fixed buffers of these sizes, terminator included.
const TARGET_ID_BYTES = 256;
const COMMAND_ID_BYTES = 128;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const encoder = new TextEncoder();
const fitsId = (id, bytes) => typeof id === 'string' && id.length > 0
  && !id.includes('\0') && encoder.encode(id).length < bytes;
const labelOr = (label, fallback) => (typeof label === 'string' && label.trim() ? label : fallback);

/** A command with no value. `release` names the command that undoes it -- PLAY's is STOP. */
export function action(id, label, execute, release) {
  return { id, label, type: VALUE_TYPE.none, execute, ...(release ? { release } : {}) };
}

export function toggle(id, label, execute) {
  return { id, label, type: VALUE_TYPE.boolean, execute };
}

export function integer(id, label, minimum, maximum, execute) {
  return { id, label, type: VALUE_TYPE.integer, minimum, maximum, execute };
}

export function number(id, label, minimum, maximum, execute) {
  return { id, label, type: VALUE_TYPE.number, minimum, maximum, execute };
}

/**
 * A pick among fixed values. The wire carries the position in `values`, and
 * `execute` receives the value itself, so a provider never decodes an index.
 */
export function choice(id, label, values, execute, labelOf = String) {
  return {
    id,
    label,
    type: VALUE_TYPE.choice,
    choices: values.map((value, index) => ({ id: index, label: String(labelOf(value)) })),
    execute: (index) => execute(values[index])
  };
}

function describeCommand(command) {
  if (!command || !fitsId(command.id, COMMAND_ID_BYTES) || typeof command.execute !== 'function'
      || !Number.isInteger(command.type) || command.type < VALUE_TYPE.none || command.type > VALUE_TYPE.choice) {
    throw new Error(`invalid command "${command?.id}"`);
  }
  const descriptor = { id: command.id, label: labelOr(command.label, command.id), type: command.type };
  if (command.type === VALUE_TYPE.integer || command.type === VALUE_TYPE.number) {
    const { minimum, maximum } = command;
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
      throw new Error(`invalid range on command "${command.id}"`);
    }
    if (command.type === VALUE_TYPE.integer && (!Number.isInteger(minimum) || !Number.isInteger(maximum)
        || minimum < INT32_MIN || maximum > INT32_MAX)) {
      throw new Error(`invalid integer range on command "${command.id}"`);
    }
    descriptor.minimum = minimum;
    descriptor.maximum = maximum;
  }
  if (command.type === VALUE_TYPE.choice) {
    if (!Array.isArray(command.choices) || command.choices.length === 0) {
      throw new Error(`command "${command.id}" offers no choice`);
    }
    const seen = new Set();
    descriptor.choices = command.choices.map((item) => {
      if (!Number.isInteger(item?.id) || item.id < INT32_MIN || item.id > INT32_MAX || seen.has(item.id)) {
        throw new Error(`invalid choice on command "${command.id}"`);
      }
      seen.add(item.id);
      return { id: item.id, label: labelOr(item.label, String(item.id)) };
    });
  }
  if (command.release !== undefined) {
    if (command.type !== VALUE_TYPE.none || !fitsId(command.release, COMMAND_ID_BYTES)) {
      throw new Error(`invalid release on command "${command.id}"`);
    }
    descriptor.releaseCommand = command.release;
    descriptor.releaseValue = { type: VALUE_TYPE.none };
  }
  return descriptor;
}

/**
 * A provider's targets, checked, as `{ id, label, lifetime, descriptor, commands }`.
 *
 * `descriptor` is what the plugin receives; `commands` maps a command id to its
 * descriptor plus `execute`, which never leaves the renderer. `lifetime` says
 * which runtime object the target is -- a plugin instance's generation -- so a
 * release is never sent to its replacement. Throws on the first defect.
 */
export function compileTargets(targets) {
  const compiled = [];
  const ids = new Set();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!fitsId(target?.id, TARGET_ID_BYTES) || ids.has(target.id)) {
      throw new Error(`invalid or duplicate command target "${target?.id}"`);
    }
    ids.add(target.id);
    const commands = new Map();
    const descriptors = [];
    for (const command of Array.isArray(target.commands) ? target.commands : []) {
      const descriptor = describeCommand(command);
      if (commands.has(descriptor.id)) throw new Error(`duplicate command "${descriptor.id}" on "${target.id}"`);
      commands.set(descriptor.id, { ...descriptor, execute: command.execute });
      descriptors.push(descriptor);
    }
    for (const command of commands.values()) {
      if (command.releaseCommand && commands.get(command.releaseCommand)?.type !== VALUE_TYPE.none) {
        throw new Error(`command "${command.id}" releases with "${command.releaseCommand}", which "${target.id}" lacks`);
      }
    }
    const label = labelOr(target.label, target.id);
    compiled.push({
      id: target.id,
      label,
      lifetime: JSON.stringify(target.lifetime ?? null),
      descriptor: { id: target.id, label, commands: descriptors },
      commands
    });
  }
  return compiled;
}

/** Does `value` fit what `command` declared? */
export function acceptsValue(command, value) {
  switch (command?.type) {
    case VALUE_TYPE.none: return value === undefined;
    case VALUE_TYPE.boolean: return typeof value === 'boolean';
    case VALUE_TYPE.integer:
      return Number.isInteger(value) && value >= command.minimum && value <= command.maximum;
    case VALUE_TYPE.number:
      return Number.isFinite(value) && value >= command.minimum && value <= command.maximum;
    case VALUE_TYPE.choice:
      return Number.isInteger(value) && command.choices.some((item) => item.id === value);
    default: return false;
  }
}

/** The value a packet's `valueType` and `number` stand for, or `{ ok: false }`. */
export function packetValue(valueType, value) {
  if (valueType === VALUE_TYPE.none) return { ok: true, value: undefined };
  if (!Number.isFinite(value)) return { ok: false };
  if (valueType === VALUE_TYPE.boolean) {
    return value === 0 || value === 1 ? { ok: true, value: value === 1 } : { ok: false };
  }
  return { ok: true, value };
}

/**
 * What a command's `execute` returned, as `{ ok, reason?, message? }`.
 *
 * `false` and `null` are refusals -- `focusTrack` answers null for a track that
 * is gone. A promise is refused too: the bus answers the plugin in the same
 * turn, and a command that finishes later would be reported as done before it
 * had done anything.
 */
export function outcomeOf(result) {
  if (result && typeof result.then === 'function') return { ok: false, reason: 'asynchronous-command' };
  if (result === false || result === null) return { ok: false, reason: 'refused' };
  if (result && typeof result === 'object' && result.ok === false) {
    return {
      ok: false,
      reason: String(result.reason || 'refused'),
      ...(result.message ? { message: String(result.message) } : {})
    };
  }
  return { ok: true };
}
