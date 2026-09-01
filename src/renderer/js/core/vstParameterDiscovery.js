/**
 * Renderer-side VST parameter discovery.
 *
 * Future Patch Bay code (the CONTROL parameter picker) will consume this API
 * without knowing anything about the native engine or its IPC protocol. It
 * answers one question: "what parameters does this VST node expose, grouped by
 * its internal plugin instances?"
 *
 * Discovery is demand-driven: nothing is polled and nothing is cached. Each
 * call asks the engine for the parameters of every plugin currently in the
 * node's chain and groups the results by plugin. The stable per-plugin identity
 * is the chain entry's `id` (e.g. `plugin-1`), which survives reordering and
 * reloads; the stable per-parameter identity is the engine-reported
 * `parameterId` (the VST3 ParamID).
 *
 * The engine always answers a parameter request with a controlled `status`, so
 * an unavailable runtime (engine down, plugin still loading, plugin failed,
 * node deleted) is reported per-plugin rather than crashing or fabricating a
 * fake "success".
 */

/**
 * Fetch the parameters of every plugin in a VST node, grouped by plugin.
 *
 * @param {object} hub the central Hub seam (needs `nodes` and `engine`)
 * @param {string} vstNodeId the VST node id
 * @returns {Promise<{vstNodeId: string, status: string, plugins: Array}>}
 *   `plugins` is an array of per-plugin records, each with:
 *   `instanceId`, `pluginId`, `name`, `status` (engine-reported), and
 *   `parameters` (array of parameter records). A plugin whose runtime is
 *   unavailable has an empty `parameters` array and a non-`ok` `status`.
 */
export async function getVstParametersForNode(hub, vstNodeId) {
  const node = hub.nodes.get(vstNodeId);
  if (!node || node.type !== 'vst') {
    return { vstNodeId, status: 'node-not-found', plugins: [] };
  }

  const plugins = (node.content && Array.isArray(node.content.plugins))
    ? node.content.plugins
    : [];

  const results = await Promise.all(plugins.map(async (plugin) => {
    let res;
    try {
      res = await hub.engine.getVstParameters(vstNodeId, plugin.id);
    } catch (err) {
      // The engine never throws for a bad request (it returns a controlled
      // status), but guard anyway so discovery can never reject the whole node.
      res = { status: 'error', message: String((err && err.message) || err) };
    }
    const currentNode = hub.nodes.get(vstNodeId);
    const currentPlugin = currentNode?.type === 'vst'
      ? currentNode.content?.plugins?.find((p) => p.id === plugin.id)
      : null;
    if (!currentPlugin || currentPlugin.pluginId !== plugin.pluginId) return null;
    const runtimeMatches = !res.pluginId || res.pluginId === currentPlugin.pluginId;
    return {
      instanceId: plugin.id,
      pluginId: plugin.pluginId,
      name: plugin.name,
      status: runtimeMatches ? res.status : 'stale-instance',
      message: runtimeMatches ? res.message : 'native instance does not match the chain model',
      parameters: (runtimeMatches && res.status === 'ok' && Array.isArray(res.parameters))
        ? res.parameters : []
    };
  }));

  const currentNode = hub.nodes.get(vstNodeId);
  if (!currentNode || currentNode.type !== 'vst') {
    return { vstNodeId, status: 'node-not-found', plugins: [] };
  }
  return { vstNodeId, status: 'ok', plugins: results.filter(Boolean) };
}
