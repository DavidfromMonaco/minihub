/**
 * Rebuilds the native engine's VST chains from the persisted Hub model.
 *
 * The engine is stateless across restarts by design: it owns runtime plugin
 * instances, never persisted identity. So after an engine start (app launch,
 * engine crash + relaunch, renderer reload) the UI would show a chain that the
 * engine knows nothing about — plugins looked loaded but produced no sound and
 * `openEditor` answered `instance-not-found`.
 *
 * The rebuild runs as soon as the engine is running. It used to wait for the
 * plugin registry event, i.e. for a full VST3 scan of every installed plugin -
 * around twenty seconds - during which the persisted chain existed only in the
 * UI and nothing could be opened or played. The engine resolves a chain's
 * plugin from its stable id (an absolute .vst3 path) on demand, so the rebuild
 * does not need the registry at all.
 *
 * Only persisted, reconstructable data is replayed (pluginId, order, bypass,
 * serialized state) — never a native handle.
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

  const maybeRebuild = () => {
    if (!needsRebuild) return;
    if (hub.engine.state !== 'running') return;
    needsRebuild = false;
    rebuild();
  };

  hub.events.on('engine:state', (s) => {
    if (s && s.state !== 'running') {
      needsRebuild = true;
      return;
    }
    maybeRebuild();
  });

  // Cold start: the renderer usually attaches after the engine is already
  // running, so no `running` transition is ever observed. init() is idempotent
  // and resolves with the current state.
  Promise.resolve(hub.engine.init()).then(maybeRebuild);

  return { rebuild, maybeRebuild };
}
