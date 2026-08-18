import { icon } from '../../ui/icons.js';
import { buildStampLabel } from '../../core/buildStamp.js';

/**
 * Home module: landing overview. Future modules will add their own
 * overview cards here by registering with the Hub.
 */
export const homeModule = {
  id: 'home',
  name: 'Home',
  navEntry: { label: 'Home', icon: 'home' },

  mount(container) {
    container.innerHTML = `
      <div class="panel">
        <h1 class="page-title mb-6">Welcome to MiniLab Hub</h1>
        <p class="muted mb-16">
          A modular desktop hub for the Arturia MiniLab 3 MIDI controller.
        </p>
        <p class="faint build-stamp mb-16">${buildStampLabel()}</p>
        <div class="grid grid-2">
          <div class="panel">
            <h2 class="panel-title">Getting started</h2>
            <p class="muted m-0">
              Open the <strong>MiniLab 3</strong> panel to select your MIDI
              input and output, then play — incoming MIDI activity is shown
              live. Your selected ports are remembered between sessions.
            </p>
          </div>
          <div class="panel">
            <h2 class="panel-title">Architecture</h2>
            <p class="muted m-0">
              This hub is built around a modular core: a shared event bus, a
              MIDI device layer, persisted settings, and a module registry.
              Future modules (sequencer, VST library, arpeggiator, …) plug in
              without rewriting the shell.
            </p>
          </div>
        </div>
      </div>`;
  },

  unmount() {}
};
