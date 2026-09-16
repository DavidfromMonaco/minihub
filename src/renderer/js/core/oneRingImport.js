import { readVst3State } from './juceState.js';
import { sequenceFromComponentState } from './oneRingSequence.js';

/**
 * A One Ring VST's sequence, moved into a One Ring node.
 *
 * WHAT MOVES
 * ----------
 * The sequence is copied; the VST stays in its chain, untouched. Its CTRL OUT
 * cables move to the new node, so the two never command the same modules at
 * once, and the targets the sequence names -- node ids, the cable's far ends --
 * are reached again through the same cables. The whole move is one edit, one
 * undo step.
 *
 * WHICH STATE
 * -----------
 * The live one when the plugin runs: a sequence changed since the last save is
 * the one that counts. The one saved with the project otherwise.
 */

const STATE_TIMEOUT_MS = 3000;
const COMMAND_OUT_PORT = 'ctrl-out';

/** Is this chain entry the One Ring VST? By its bundle, or by its name. */
export function isOneRingPlugin(plugin) {
  const path = String(plugin?.pluginId || '');
  return /(^|[\\/])ONE RING\.vst3([\\/]|$)/i.test(path) || String(plugin?.name || '').trim().toUpperCase() === 'ONE RING';
}

function liveState(hub, chainId, instanceId) {
  if (hub.engine?.state !== 'running' || hub.engine.getInstanceStatus?.(chainId, instanceId) !== 'ready') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let off = () => {};
    const finish = (state) => {
      clearTimeout(timer);
      off();
      resolve(state);
    };
    const timer = setTimeout(() => finish(null), STATE_TIMEOUT_MS);
    off = hub.events.on('engine:pluginState', (msg) => {
      if (msg?.chainId === chainId && msg.instanceId === instanceId && typeof msg.state === 'string') finish(msg.state);
    });
    Promise.resolve(hub.engine.getState(chainId, instanceId)).catch(() => finish(null));
  });
}

/**
 * Copy the sequence of the One Ring VST `pluginInstanceId` in VST node
 * `vstNodeId` into a new One Ring node, and move the VST node's CTRL OUT cables
 * there. Answers `{ ok, nodeId, moved }`, or `{ ok: false, reason, message? }`.
 */
export async function copyOneRingToNode(hub, vstNodeId, pluginInstanceId) {
  const vst = hub.nodes.get(vstNodeId);
  const plugin = vst?.type === 'vst' ? vst.content?.plugins?.find((item) => item.id === pluginInstanceId) : null;
  if (!plugin || !isOneRingPlugin(plugin)) return { ok: false, reason: 'not-one-ring' };
  const state = (await liveState(hub, vstNodeId, pluginInstanceId)) ?? plugin.state;
  const streams = typeof state === 'string' ? readVst3State(state) : null;
  if (!streams?.component) {
    return { ok: false, reason: 'no-state', message: 'no saved sequence to read yet' };
  }
  let content;
  try {
    content = sequenceFromComponentState(streams.component);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: String(error?.message || error) };
  }
  if (!hub.nodes.get(vstNodeId)) return { ok: false, reason: 'not-one-ring' };
  const node = hub.nodes.createFromSnapshot({ type: 'one-ring', content });
  if (!node) return { ok: false, reason: 'not-created' };
  const cables = hub.network.connectionsFrom(vstNodeId, COMMAND_OUT_PORT);
  for (const cable of cables) {
    hub.network.disconnect(vstNodeId, COMMAND_OUT_PORT, cable.to.nodeId, cable.to.portId);
    hub.network.connect(node.id, COMMAND_OUT_PORT, cable.to.nodeId, cable.to.portId);
  }
  return { ok: true, nodeId: node.id, moved: cables.length };
}
