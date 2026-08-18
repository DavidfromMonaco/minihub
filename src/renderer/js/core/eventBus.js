/**
 * Minimal typed pub/sub event bus.
 * Handlers are isolated so one failing handler never breaks the others.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[eventBus] handler for "${event}" failed:`, err);
      }
    }
  }

  /** Remove all handlers (used mainly for tests / teardown). */
  clear() {
    this._handlers.clear();
  }
}
