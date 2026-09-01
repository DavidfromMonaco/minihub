/**
 * Home module: four project actions and nothing else.
 */
import { newPictogram, recentPictogram, loadPictogram, templatePictogram } from './homePictograms.js';

export function createHomeModule(hub) { return {
  id: 'home',
  name: 'Home',
  navEntry: { label: 'Home', icon: 'home', group: 'home', fixed: true },

  mount(container) {
    const recentName = hub.settings.get('recentProjectName');
    const recentPath = hub.settings.get('recentProjectPath');
    container.innerHTML = `
      <div class="home-project-grid">
        <button class="home-project-tile" data-project-action="new" data-accent="orange">
          <span class="home-project-scene">${newPictogram()}</span>
          <span class="home-project-label">New</span>
        </button>
        <button class="home-project-tile home-project-recent" data-project-action="recent" data-accent="blue" ${recentPath ? '' : 'disabled'}>
          <span class="home-project-scene">${recentPictogram()}</span>
          <span class="home-project-label">${recentName || 'No recent project'}</span>
        </button>
        <button class="home-project-tile" data-project-action="load" data-accent="orange">
          <span class="home-project-scene">${loadPictogram()}</span>
          <span class="home-project-label">Load</span>
        </button>
        <button class="home-project-tile" data-project-action="template" data-accent="purple">
          <span class="home-project-scene">${templatePictogram()}</span>
          <span class="home-project-label">Templates</span>
        </button>
      </div>`;
    // A tile is a button wrapping a pictogram and a label, so the click always
    // lands on one of those children - reading `event.target.dataset` alone
    // matched almost nothing and the tiles did nothing at all.
    container.onclick = (event) => {
      const action = event.target?.closest?.('[data-project-action]')?.dataset?.projectAction;
      if (!action) return;
      if (action === 'new') hub.project.newProject();
      if (action === 'template') hub.project.newFromBasicTemplate();
      if (action === 'recent' && recentPath) hub.project.load(recentPath);
      if (action === 'load') hub.project.load();
    };
    this._container = container;
  },

  // `#content` is shared by every module: leaving the handler installed lets
  // Home react to clicks on another module's page.
  unmount() {
    if (this._container) this._container.onclick = null;
    this._container = null;
  }
}; }

export const homeModule = { id: 'home', name: 'Home', navEntry: { label: 'Home', icon: 'home', group: 'home', fixed: true } };
