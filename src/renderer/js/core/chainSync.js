/**
 * Rebuilds the native engine's VST chains from the persisted Hub model.
 *
 * The engine is stateless across restarts by design: it owns runtime plugin
 * instances, never persisted identity. So after an engine start (app launch,
 * engine crash + relaunch, renderer reload) the UI would show a chain that the
 * engine knows nothing about — plugins looked loaded but produced no sound and
 * `openEditor` answered `instance-not-found`.
 *
 * Rebuilding is driven by the plugin registry event rather than by engine
 * state, because `createInstance` can only succeed once the engine has scanned
 * and knows the pluginId. Only persisted, reconstructable data is replayed
 * (pluginId, order, bypass, serialized state) — never a native handle.
 */
export function setupChainSync(hub, syncRouting) {
  let needsRebuild = true;

  const rebuild = () => {
    if (!hub.engine || !hub.nodes) return;
    for (const instance of hub.nodes.list()) {
      if (instance.type !== 'vst') continue;
      const plugins = (instance.content && Array.isArray(instance.content.plugins))
        ? instance.content.plugins
        : [];
      plugins.forEach((plugin, index) => {
        if (!plugin.pluginId) return;
        hub.engine.createInstance(instance.id, plugin.pluginId, plugin.id, index);
        if (plugin.bypassed) hub.engine.setBypass(instance.id, plugin.id, true);
        if (plugin.state) hub.engine.setState(instance.id, plugin.id, plugin.state);
      });
    }
    // Chain MIDI/output gating lives in the engine too and is equally lost on
    // restart, so re-publish the routing topology right after the rebuild.
    if (typeof syncRouting === 'function') syncRouting();
  };

  hub.events.on('engine:state', (s) => {
    if (s && s.state !== 'running') needsRebuild = true;
  });

  hub.events.on('engine:plugins', () => {
    if (!needsRebuild) return;
    if (!hub.engine.plugins.length) return;
    needsRebuild = false;
    rebuild();
  });

  return { rebuild };
}
