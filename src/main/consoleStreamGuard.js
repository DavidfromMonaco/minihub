'use strict';

const guardedStreams = new WeakSet();

/**
 * Electron desktop processes can outlive the terminal or test runner that
 * launched them. In that case stdout/stderr emit EPIPE; without an error
 * listener Node turns the failed diagnostic write into an uncaught exception.
 * Logging transport loss must never prevent the user from closing MiniHub.
 */
function installConsoleStreamGuards(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (!stream || (typeof stream !== 'object' && typeof stream !== 'function')
        || typeof stream.on !== 'function' || guardedStreams.has(stream)) continue;
    guardedStreams.add(stream);
    stream.on('error', (error) => {
      if (error?.code === 'EPIPE') return;
      process.nextTick(() => { throw error; });
    });
  }
}

module.exports = { installConsoleStreamGuards };
