/**
 * Renderer-side startup diagnostics helper.
 *
 * Appends lifecycle trace lines to the main-process startup log file (via IPC)
 * so the exact renderer event sequence is captured even without a visible
 * console. Mirrors the main-process `diagnostics` module.
 */
export function createDiagnostics(api) {
  return {
    log(line) {
      try {
        api.diagnosticsLog(line);
      } catch (err) {
        /* ignore */
      }
    }
  };
}
