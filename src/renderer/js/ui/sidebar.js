import { icon } from './icons.js';
import { escapeHtml } from '../core/html.js';
import { nodeFamily } from '../core/nodeTypes.js';

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
 * their registration order inside a group. Future dynamic types (Video, Image,
 * Sequencer, …) land in NODES automatically because they declare
 * `group: 'node'` — no sidebar rewrite.
 *
 * The nodes in NODES are the one exception to registration order: they follow
 * the order of `hub.nodes`, which a person arranges by dragging them in this
 * list and which the project saves. Routing and anything else that is not a
 * node instance stays above them, where it was registered.
 */
const GROUPS = [
  { id: 'home', label: 'HOME' },
  { id: 'system', label: 'SYSTEM' },
  { id: 'node', label: 'NODES' }
];

/**
 * How far the pointer travels before a press on a node becomes a drag. Under
 * it the press is a click and opens the node, as it always did: a hand is never
 * perfectly still, and a list that reordered itself on every click would be
 * worse than one that cannot be reordered.
 */
const DRAG_THRESHOLD_PX = 5;
/** Near the top or bottom of the sidebar a drag scrolls it, this much a move. */
const EDGE_SCROLL_PX = 28;
const EDGE_SCROLL_STEP = 10;

/**
 * Where a node dropped at `y` lands: before the first item whose middle is
 * below the pointer, or after the last. `items` are the movable entries in
 * their order on screen, `{ id, top, height }`.
 *
 * Answers `null` when the drop would leave the order as it is -- over itself,
 * or just after the node above it -- so no line is drawn for a move that moves
 * nothing.
 */
export function dropPosition(items = [], draggedId = '', y = 0) {
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(draggedId);
  if (from < 0) return null;
  let index = items.findIndex((item) => y < item.top + item.height / 2);
  if (index < 0) index = items.length;
  if (index === from || index === from + 1) return null;
  return {
    beforeId: index < items.length ? ids[index] : null,
    // The item the line is drawn against, and on which of its edges.
    markId: index < items.length ? ids[index] : ids[items.length - 1],
    edge: index < items.length ? 'before' : 'after'
  };
}

export function buildSidebar(hub, sidebarEl, contentEl) {
  const items = new Map(); // moduleId -> button element
  /** Set when a drag ends, so the click the browser may send after it does
   *  not also open the node that was just moved. */
  let swallowClick = false;

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
      if (group.id === 'node') sortByNodeOrder(modules);

      const label = document.createElement('div');
      label.setAttribute('class', 'sidebar-group-label');
      label.textContent = group.label;
      sidebarEl.appendChild(label);

      modules.forEach((module) => {
        const item = document.createElement('button');
        const accent = module.navEntry.accent
          ? ` accent-${module.navEntry.accent} family-${nodeFamily(module.navEntry.accent)}` : '';
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
          if (swallowClick) return;
          hub.modules.activate(module.id, contentEl);
        });
        if (group.id === 'node' && hub.nodes?.get?.(module.id)) {
          item.classList.add('nav-movable');
          bindReorder(item, module.id);
        }
        sidebarEl.appendChild(item);
        items.set(module.id, item);
      });
    });
  };

  /** Node instances in the order `hub.nodes` holds them; the rest first. */
  function sortByNodeOrder(modules) {
    const order = new Map((hub.nodes?.list?.() || []).map((instance, index) => [instance.id, index]));
    modules.sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
  }

  /** The movable entries as they stand on screen now. */
  function movableItems() {
    return [...items.entries()]
      .filter(([, element]) => element.classList.contains('nav-movable'))
      .map(([id, element]) => {
        const rect = element.getBoundingClientRect();
        return { id, top: rect.top, height: rect.height };
      });
  }

  function clearMarks() {
    for (const element of items.values()) element.classList.remove('nav-drop-before', 'nav-drop-after');
  }

  /**
   * Press, move past the threshold, release: the node goes where the line was.
   *
   * Pointer events on the document rather than HTML drag and drop: the
   * browser's drag carries a ghost image of the button and its own cursor, and
   * cannot be told apart from a file dropped on the window. This is the
   * gesture of a list you arrange, and nothing leaves the list.
   */
  function bindReorder(item, moduleId) {
    item.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const y0 = event.clientY;
      let dragging = false;
      let target = null;
      const move = (moveEvent) => {
        if (!dragging) {
          if (Math.abs(moveEvent.clientY - y0) < DRAG_THRESHOLD_PX) return;
          dragging = true;
          item.classList.add('nav-dragging');
          sidebarEl.classList.add('nav-reordering');
        }
        const box = sidebarEl.getBoundingClientRect?.();
        if (box && box.height > 0) {
          if (moveEvent.clientY < box.top + EDGE_SCROLL_PX) sidebarEl.scrollTop -= EDGE_SCROLL_STEP;
          else if (moveEvent.clientY > box.top + box.height - EDGE_SCROLL_PX) sidebarEl.scrollTop += EDGE_SCROLL_STEP;
        }
        target = dropPosition(movableItems(), moduleId, moveEvent.clientY);
        clearMarks();
        if (target) items.get(target.markId)?.classList.add(target.edge === 'before' ? 'nav-drop-before' : 'nav-drop-after');
      };
      const finish = (commit) => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', cancel);
        document.removeEventListener('keydown', key);
        clearMarks();
        item.classList.remove('nav-dragging');
        sidebarEl.classList.remove('nav-reordering');
        if (!dragging) return;
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 0);
        if (commit && target) hub.nodes.move(moduleId, target.beforeId);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const key = (keyEvent) => { if (keyEvent.key === 'Escape') finish(false); };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', cancel);
      document.addEventListener('keydown', key);
    });
  }

  hub.events.on('module:registered', render);
  hub.events.on('module:unregistered', render);
  hub.events.on('nodes:reordered', render);
  hub.events.on('module:activated', syncActive);
  render();
}
