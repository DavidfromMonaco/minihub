/**
 * Teardown collector for everything a mount() attaches.
 *
 * `#content` is shared by every module, so a DOM listener that survives
 * unmount() keeps reacting to clicks belonging to another page: a plugin action
 * once fired on unrelated VST nodes, and "Delete Node" could delete a node
 * visited earlier (invariant 8, ARCHITECTURE §10).
 *
 * What this removes is the manual mirror. A listener used to be written three
 * times — the declaration, a `module._onX` field so the closure survived the
 * mount, and the matching removeEventListener() in unmount(). Adding one meant
 * editing all three sites, and forgetting the third is silent: nothing throws,
 * the page simply starts answering for another one.
 */
export function createDisposers() {
  let pending = [];

  return {
    /** Attach a DOM listener that dispose() is guaranteed to remove. */
    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      pending.push(() => target.removeEventListener(type, handler, options));
      return handler;
    },

    /**
     * Register any other teardown: an EventBus unsubscribe, a timer, a flag
     * that tells an in-flight request to drop its answer. A non-function is
     * ignored so `add(editor.bind(...))` stays valid when `bind` returns
     * nothing.
     */
    add(teardown) {
      if (typeof teardown === 'function') pending.push(teardown);
      return teardown;
    },

    /**
     * Run every teardown, oldest first. Draining makes a second call a no-op,
     * which matters because unmount() can follow a mount() that threw halfway.
     * One failing teardown must not strand those queued behind it — the same
     * isolation `eventBus.js` applies to handlers.
     */
    dispose() {
      const queued = pending;
      pending = [];
      for (const teardown of queued) {
        try {
          teardown();
        } catch (err) {
          /* a teardown that throws is already broken; the rest must still run */
        }
      }
    }
  };
}
