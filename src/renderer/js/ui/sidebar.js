import { icon } from './icons.js';
import { escapeHtml } from '../core/html.js';

/**
 * Builds the sidebar from registered modules and keeps it in sync.
 * Every module with a `navEntry` automatically gets a navigation item.
 *
 * The nav is rebuilt only when the set of modules changes. Navigating between
 * modules just moves the `active` class: rebuilding the whole list on every
 * activation threw away and recreated every button (and its click listener) on
 * each click.
 */
export function buildSidebar(hub, sidebarEl, contentEl) {
  const items = new Map(); // moduleId -> button element

  const syncActive = () => {
    for (const [moduleId, el] of items) {
      el.classList.toggle('active', moduleId === hub.modules.activeId);
    }
  };

  const render = () => {
    sidebarEl.innerHTML = '';
    items.clear();

    const label = document.createElement('div');
    label.className = 'sidebar-label';
    label.textContent = 'Modules';
    sidebarEl.appendChild(label);

    hub.modules.list().forEach((module) => {
      if (!module.navEntry) return;
      const item = document.createElement('button');
      const accent = module.navEntry.accent ? ` accent-${module.navEntry.accent}` : '';
      const dot = module.navEntry.accent ? '<span class="nav-accent"></span>' : '';
      item.className =
        'nav-item' + (module.id === hub.modules.activeId ? ' active' : '') + accent;
      item.innerHTML = `
        ${dot}
        <span class="nav-icon">${icon(module.navEntry.icon || 'info')}</span>
        <span>${escapeHtml(module.navEntry.label || module.name)}</span>`;
      item.addEventListener('click', () => {
        hub.modules.activate(module.id, contentEl);
      });
      sidebarEl.appendChild(item);
      items.set(module.id, item);
    });
  };

  hub.events.on('module:registered', render);
  hub.events.on('module:unregistered', render);
  hub.events.on('module:activated', syncActive);
  render();
}
