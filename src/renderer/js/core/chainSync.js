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
  const pendingRestore = new Map(); // create requestId -> persisted plugin record

  hub.events.on('engine:pluginState',(msg)=>{
    if(hub.engine.getInstanceGeneration(msg.chainId,msg.instanceId)!==msg.generation)return;
    hub.nodes.setPluginState(msg.chainId,msg.instanceId,msg.pluginId,msg.state);
  });

  hub.events.on('engine:instanceStatus', (msg) => {
    if (!msg || !msg.requestId) return;
    const pending = pendingRestore.get(msg.requestId);
    if (!pending) return;
    if (pending.engineGeneration !== hub.engine.runtimeGeneration) {
      pendingRestore.delete(msg.requestId);
      return;
    }
    if (msg.status === 'error') {
      pendingRestore.delete(msg.requestId);
      return;
    }
    if (msg.status !== 'ready') return;
    pendingRestore.delete(msg.requestId);

    // The model may have changed while native creation was in flight. Restore
    // only when this exact chain entry still owns the same plugin.
    const node = hub.nodes.get(pending.chainId);
    const live = node?.type === 'vst'
      ? node.content?.plugins?.find((p) => p.id === pending.plugin.id)
      : null;
    if (!live || live.pluginId !== pending.plugin.pluginId
        || (msg.pluginId && msg.pluginId !== live.pluginId)) return;

    if (live.state) hub.engine.setState(pending.chainId, live.id, live.state, live.pluginId, msg.generation);
    if (live.bypassed) hub.engine.setBypass(pending.chainId, live.id, true);
  });

  const rebuild = () => {
    if (!hub.engine || !hub.nodes) return;
    hub.diagnostics?.log(`startup:vst-chain-rebuild count=${hub.nodes.list().filter((node) => node.type === 'vst').length}`);
    const engineGeneration = hub.engine.runtimeGeneration;
    for (const instance of hub.nodes.list()) {
      if (instance.type !== 'vst') continue;
      const plugins = (instance.content && Array.isArray(instance.content.plugins))
        ? instance.content.plugins
        : [];
      plugins.forEach((plugin, index) => {
        if (!plugin.pluginId) return;
        const creation = hub.engine.createInstanceTracked(
          instance.id, plugin.pluginId, plugin.id, index
        );
        pendingRestore.set(creation.requestId, { chainId: instance.id, plugin, engineGeneration });
        creation.accepted.then((res) => {
          if (!res || !res.ok) pendingRestore.delete(creation.requestId);
        }).catch(() => pendingRestore.delete(creation.requestId));
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
      pendingRestore.clear();
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
