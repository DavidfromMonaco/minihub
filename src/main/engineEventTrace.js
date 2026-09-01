'use strict';

/**
 * Decides which native-engine events reach the startup log.
 *
 * The engine publishes periodic telemetry many times per second (masterMeter
 * alone runs at 10 Hz). Writing one synchronous line per event grew the startup
 * log to 18.6 MB and put a disk write on the critical path of the very process
 * that relays live MIDI to the engine.
 *
 * Periodic telemetry is therefore dropped, with one deliberate exception:
 * `audioRuntimeTelemetry` is logged whenever the window it describes actually
 * reports a fault. That turns the log from a firehose into an anomaly record,
 * and in particular it is the only place a *silent* dropout becomes visible -
 * a block that reached the device as clean, on-time zeroes because a chain or a
 * plugin was locked out by the message thread.
 */

const PERIODIC_EVENTS = new Set([
  'masterMeter',
  'hostTiming',
  'audioPathTelemetry',
  'transport',
  'recorderState',
  'nodeSafetyTelemetry',
  'metronomeTick'
]);

const RUNTIME_TELEMETRY = 'audioRuntimeTelemetry';

// Reported by the engine as a per-window delta, so they are used as-is.
const WINDOW_FIELDS = [
  ['chainBlocksSkippedSinceSnapshot', 'chainBlocksSkipped'],
  ['pluginBlocksSkippedSinceSnapshot', 'pluginBlocksSkipped'],
  ['deadlineMisses', 'deadlineMisses'],
  ['estimatedSchedulingUnderruns', 'schedulingGaps']
];

// Reported as run totals, so only their growth is worth a line.
const TOTAL_FIELDS = [
  ['paOutputUnderflows', 'paOutputUnderflows'],
  ['paOutputOverflows', 'paOutputOverflows'],
  ['portAudioNonFiniteSamples', 'nonFiniteSamples']
];

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * @returns {(msg: object, details?: string) => string|null} the line to log, or
 *   null when the event carries nothing worth a synchronous disk write.
 */
function createEngineEventTrace() {
  const totals = new Map();

  const growth = (key, value) => {
    if (!Number.isFinite(value)) return 0;
    const previous = totals.get(key) || 0;
    totals.set(key, value);
    return Math.max(0, value - previous);
  };

  return (msg, details = '') => {
    const type = msg && typeof msg.type === 'string' ? msg.type : '';
    if (!type) return null;

    if (type === RUNTIME_TELEMETRY) {
      const parts = [];
      for (const [field, label] of WINDOW_FIELDS) {
        const value = positiveNumber(msg[field]);
        if (value > 0) parts.push(label + '=' + value);
      }
      for (const [field, label] of TOTAL_FIELDS) {
        const value = growth(field, msg[field]);
        if (value > 0) parts.push(label + '=+' + value);
      }
      if (!parts.length) return null;
      return 'engine:anomaly ' + parts.join(' ');
    }

    if (PERIODIC_EVENTS.has(type)) return null;
    return 'engine:event ' + type + details;
  };
}

module.exports = { createEngineEventTrace, PERIODIC_EVENTS, RUNTIME_TELEMETRY };
