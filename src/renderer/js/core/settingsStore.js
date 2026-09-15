import { PROJECT_KEY_SET } from './projectKeys.js';

/**
 * How long writes made inside `coalescingSaves` wait before their one save.
 *
 * Every `set` is a synchronous atomic file write in the main process -- the
 * process that also relays live MIDI. A plugin sequencing a fader on sixteenth
 * notes would otherwise write the settings file eight times a second for as
 * long as it plays.
 */
const COALESCED_SAVE_MS = 500;

/**
 * Renderer-side settings store backed by the main process via IPC.
 * Persists selected MIDI ports and other basic user preferences.
 */
export class SettingsStore {
  constructor(api) {
    this.api = api;
    this.data = {};
    this._coalescing = 0;
    this._saveTimer = null;
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
    if (this._coalescing > 0) {
      this._saveSoon();
      return;
    }
    // This save writes everything, the pending coalesced writes included.
    this._cancelSaveSoon();
    try {
      await this.api.saveSettings(this.applicationData());
    } catch (err) {
      console.error(`[settings] failed to save "${key}":`, err);
    }
  }

  /**
   * Run `fn` with the writes it makes saved once, shortly afterwards, instead
   * of once each. The values are in `data` immediately; only the file waits.
   */
  coalescingSaves(fn) {
    this._coalescing += 1;
    try {
      return fn();
    } finally {
      this._coalescing -= 1;
    }
  }

  _saveSoon() {
    if (this._saveTimer !== null) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      Promise.resolve()
        .then(() => this.api.saveSettings(this.applicationData()))
        .catch((err) => console.error('[settings] failed to save coalesced writes:', err));
    }, COALESCED_SAVE_MS);
  }

  _cancelSaveSoon() {
    if (this._saveTimer === null) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
  }

  /** Update related preferences with one atomic settings snapshot. */
  async setMany(values) {
    Object.assign(this.data, values || {});
    this._cancelSaveSoon();
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
