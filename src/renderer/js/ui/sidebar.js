import { icon } from './icons.js';

/**
 * Builds the sidebar from registered modules and keeps it in sync.
 * Every module with a `navEntry` automatically gets a navigation item.
 */
export function buildSidebar(hub, sidebarEl, contentEl) {
  const render = () => {
    sidebarEl.innerHTML = '';

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
        <span>${module.navEntry.label || module.name}</span>`;
      item.addEventListener('click', () => {
        hub.modules.activate(module.id, contentEl);
      });
      sidebarEl.appendChild(item);
    });
  };

  hub.events.on('module:registered', render);
  hub.events.on('module:unregistered', render);
  hub.events.on('module:activated', render);
  render();
}
