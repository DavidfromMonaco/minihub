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
 *
 * Modules are grouped into three deterministic sections — HOME, SYSTEM and
 * NODES — driven by `navEntry.group` metadata rather than hardcoded markup:
 *
 *   home    -> HOME   ( the landing module, on its own at the top )
 *   system  -> SYSTEM ( permanent application modules: MiniLab, Audio Output, … )
 *   node    -> NODES  ( dynamic user-created node instances )
 *
 * A group is only rendered when it has at least one module, and modules keep
 * their registration order inside a group (dynamic nodes preserve creation
 * order). Future dynamic types (Video, Image, Sequencer, …) land in NODES
 * automatically because they declare `group: 'node'` — no sidebar rewrite.
 */
const GROUPS = [
  { id: 'home', label: 'HOME' },
  { id: 'system', label: 'SYSTEM' },
  { id: 'node', label: 'NODES' }
];

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

    // Bucket modules by their declared group. Modules without an explicit
    // group (legacy / tests) fall back to the SYSTEM section.
    const buckets = new Map(GROUPS.map((g) => [g.id, []]));
    hub.modules.list().forEach((module) => {
      if (!module.navEntry) return;
      const group = module.navEntry.group || 'system';
      if (!buckets.has(group)) buckets.set(group, []);
      buckets.get(group).push(module);
    });

    GROUPS.forEach((group) => {
      const modules = buckets.get(group.id) || [];
      if (modules.length === 0) return; // empty sections are hidden

      const label = document.createElement('div');
      label.setAttribute('class', 'sidebar-group-label');
      label.textContent = group.label;
      sidebarEl.appendChild(label);

      modules.forEach((module) => {
        const item = document.createElement('button');
        const accent = module.navEntry.accent ? ` accent-${module.navEntry.accent}` : '';
        const fixed = module.navEntry.fixed ? ' nav-fixed' : '';
        const dot = module.navEntry.accent ? '<span class="nav-accent"></span>' : '';
        item.setAttribute(
          'class',
          'nav-item' + (module.id === hub.modules.activeId ? ' active' : '') + fixed + accent
        );
        item.setAttribute('data-module-id', module.id);
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
    });
  };

  hub.events.on('module:registered', render);
  hub.events.on('module:unregistered', render);
  hub.events.on('module:activated', syncActive);
  render();
}
