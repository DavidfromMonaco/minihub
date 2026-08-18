/**
 * Renderer-side settings store backed by the main process via IPC.
 * Persists selected MIDI ports and other basic user preferences.
 */
export class SettingsStore {
  constructor(api) {
    this.api = api;
    this.data = {};
  }

  async load() {
    try {
      this.data = (await this.api.loadSettings()) || {};
    } catch (err) {
      console.error('[settings] failed to load:', err);
      this.data = {};
    }
    return this.data;
  }

  get(key) {
    return this.data[key];
  }

  async set(key, value) {
    this.data[key] = value;
    try {
      await this.api.saveSettings(this.data);
    } catch (err) {
      console.error(`[settings] failed to save "${key}":`, err);
    }
  }
}
