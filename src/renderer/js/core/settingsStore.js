import { PROJECT_KEY_SET } from './projectKeys.js';

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
    this.onSet?.(key, value);
    try {
      await this.api.saveSettings(this.applicationData());
    } catch (err) {
      console.error(`[settings] failed to save "${key}":`, err);
    }
  }

  /** Update related preferences with one atomic settings snapshot. */
  async setMany(values) {
    Object.assign(this.data, values || {});
    try {
      await this.api.saveSettings(this.applicationData());
    } catch (err) {
      console.error('[settings] failed to save preference group:', err);
    }
  }

  applicationData() {
    if (!this.projectMode) return this.data;
    return Object.fromEntries(
      Object.entries(this.data).filter(([key]) => !PROJECT_KEY_SET.has(key))
    );
  }
}
