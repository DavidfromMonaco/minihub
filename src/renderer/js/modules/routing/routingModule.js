/**
 * Routing / Patch Bay module.
 *
 * A Reason-style rear-panel cable editor rendered in SVG. Nodes and cables
 * are always derived from `hub.graph` — this editor is never the source of
 * truth for routing. Node positions are view state persisted separately via
 * `GraphLayout` under the `graphLayout` settings key.
 *
 * Interactions:
 *   - drag a node body to move it (position is view state only)
 *   - drag from an output jack toward a compatible input jack to connect
 *   - click a cable to select it, then press Delete to remove it
 *   - left-click a node to select it (blue outline)
 *   - Ctrl+C / Ctrl+V to copy/paste a selected dynamic node (internal clipboard)
 *   - right-click a node -> node context menu (Copy / Delete)
 *   - right-click empty canvas -> canvas context menu (New Node / Paste)
 *   - right-drag empty canvas -> pan (click vs drag disambiguated by threshold)
 *
 * Rendering uses native SVG (no framework): nodes are `<g>` groups positioned
 * with `transform`, ports are jack glyphs, cables are cubic bezier paths.
 */
import { GraphLayout } from '../../core/graphLayout.js';
import { GraphViewport } from '../../core/graphViewport.js';
import { GRID_SIZE, dragPosition } from '../../core/grid.js';
import { getNodeType, listNodeTypes, listOmniBoxCategories } from '../../core/nodeTypes.js';
import {
  NODE_WIDTH,
  IDENTITY_H,
  identityHeight,
  MINILAB_SURFACE_SCALE,
  MINILAB_SURFACE_Y,
  MINILAB_SURFACE_X,
  portY,
  nodeGeometry
} from '../../core/nodeGeometry.js';
import { getVstRole } from '../../core/vstChain.js';
import {
  screenToWorld,
  zoomAt,
  panFromStart,
  fitViewport
} from '../../core/viewportMath.js';
import {
  buildVisualNodes,
  buildVisualConnections,
  createConnection,
  deleteConnection,
  portTypeInfo
} from './routingCore.js';
import { appendMiniLabControlSurfaceSvg } from '../../ui/miniLabControlSurface.js';
import { MINILAB_NODE_ID } from '../../core/systemNodes.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Right-button click vs drag threshold (screen px): beyond this the gesture is
// treated as a pan, otherwise it is a context click.
const PAN_THRESHOLD = 4;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

export function createRoutingModule(hub) {
  let container = null;
  let svg = null;
  let cablesLayer = null;
  let nodesLayer = null;
  let clipDefs = null;
  let subs = [];
  let layout = null;
  let viewportStore = null;

  // View state (never routing state).
  let positions = new Map(); // nodeId -> {x, y}
  let nodeEls = new Map(); // nodeId -> <g>
  let cableEls = new Map(); // cableId -> <path> (visible)
  let cableHits = new Map(); // cableId -> <path> (invisible wide hit area)
  let gridRects = []; // background rects that follow the viewBox
  let viewport = { x: 0, y: 0, zoom: 1 }; // world top-left + scale

  let selectedCableId = null;
  let selectedNodeId = null; // Patch Bay UI selection (never persisted)
  let lastNodeTap = null;    // { nodeId, at } - pointer-level double-tap detection
  let contextNodeId = null; // right-click context-menu target (independent of selection)
  let contextMenuEl = null;
  let suppressContextMenu = false; // suppress menu right after a right-drag pan
  let suppressTimer = null;
  let drag = null; // node drag, cable drag, or pan state
  let rearView = false; // front hides cable runs beneath panels; rear exposes them
  let viewSideSwitch = null;

  // Internal Patch Bay clipboard (temporary app state, never persisted).
  let clipboard = null; // { type, content } serializable snapshot

  // Right-button gesture state (click vs drag disambiguation).
  let rightDown = null; // { clientX, clientY, pointerId }
  let lastPointerClient = null; // last pointer position over the canvas

  // ---------- rendering ----------

  function render() {
    const nodes = buildVisualNodes(hub.graph);
    const cables = buildVisualConnections(hub.graph);

    // Ensure positions exist for every node (deterministic defaults).
    nodes.forEach((node, i) => {
      if (!positions.has(node.id)) {
        positions.set(node.id, layout.get(node.id, i));
      }
    });

    // Prune positions for nodes that no longer exist.
    const ids = new Set(nodes.map((n) => n.id));
    for (const id of [...positions.keys()]) {
      if (!ids.has(id)) positions.delete(id);
    }

    // Clear stale selection/context target if the node disappeared for any
    // reason (deletion elsewhere, graph change, etc.).
    if (selectedNodeId && !ids.has(selectedNodeId)) selectedNodeId = null;
    if (contextNodeId && !ids.has(contextNodeId)) contextNodeId = null;

    selectedCableId = null;
    nodeEls.clear();
    cableEls.clear();
    cableHits.clear();
    cablesLayer.innerHTML = '';
    nodesLayer.innerHTML = '';
    viewSideSwitch = null;
    if (clipDefs) clipDefs.innerHTML = '';

    const geo = new Map();
    nodes.forEach((node) => geo.set(node.id, nodeGeometry(node, positions.get(node.id))));

    // Cables first (under nodes).
    cables.forEach((cable) => {
      const fromGeo = geo.get(cable.from.nodeId);
      const toGeo = geo.get(cable.to.nodeId);
      const fromPort = fromGeo && fromGeo.outputs.find((p) => p.port.id === cable.from.portId);
      const toPort = toGeo && toGeo.inputs.find((p) => p.port.id === cable.to.portId);
      if (!fromPort || !toPort) return;

      const d = cablePath(fromPort, toPort);
      // Wide invisible hit path (captures clicks/drags; visible cable stays thin).
      const hit = svgEl('path', { class: 'cable-hit', d });
      hit.dataset.cableId = cable.id;
      cablesLayer.appendChild(hit);
      cableHits.set(cable.id, hit);

      const path = svgEl('path', { class: 'cable', d });
      path.dataset.cableId = cable.id;
      path.dataset.fromNodeId = cable.from.nodeId;
      path.dataset.fromPortId = cable.from.portId;
      path.dataset.toNodeId = cable.to.nodeId;
      path.dataset.toPortId = cable.to.portId;
      cablesLayer.appendChild(path);
      cableEls.set(cable.id, path);
    });

    // Nodes.
    nodes.forEach((node) => {
      const height = geo.get(node.id).height;
      const g = svgEl('g', { class: 'node', transform: `translate(${positions.get(node.id).x} ${positions.get(node.id).y})` });
      g.dataset.nodeId = node.id;
      if (node.id === selectedNodeId) g.classList.add('selected');

      const type = getNodeType(node.type);
      if (type) g.classList.add(`node-type-${node.type}`);
      else g.classList.add('node-native'); // native/system node (e.g. MiniLab)

      // Clip the identity/dock surfaces to the rounded panel outline.
      const clipId = `node-clip-${node.id}`;
      const clip = svgEl('clipPath', { id: clipId });
      clip.appendChild(svgEl('rect', { x: 0, y: 0, width: NODE_WIDTH, height, rx: 8 }));
      clipDefs.appendChild(clip);

      // Base panel (fill + border + selection outline).
      g.appendChild(svgEl('rect', { class: 'node-panel', x: 0, y: 0, width: NODE_WIDTH, height, rx: 8 }));

      const clipped = svgEl('g', { 'clip-path': `url(#${clipId})` });
      // Upper identity/content surface (family-tinted) + lower I/O dock.
      const identityH=identityHeight(node);
      clipped.appendChild(svgEl('rect', { class: 'node-identity', x: 0, y: 0, width: NODE_WIDTH, height: identityH }));
      clipped.appendChild(svgEl('rect', { class: 'node-dock', x: 0, y: identityH, width: NODE_WIDTH, height: height - identityH }));
      clipped.appendChild(svgEl('rect', { class: 'node-dock-divider', x: 0, y: identityH, width: NODE_WIDTH, height: 1 }));
      clipped.appendChild(svgEl('rect', { class: 'node-accent', x: 0, y: 0, width: NODE_WIDTH, height: 4 }));

      const title = svgEl('text', { class: 'node-title', x: 12, y: 24 });
      title.textContent = node.name;
      clipped.appendChild(title);

      // Direct route to the node's own page. Double-click still works, but a
      // visible control is the discoverable one - and it does not depend on
      // the synthesized click that pointer capture retargets during a drag.
      if (type && hub.modules?.get(node.id)) clipped.appendChild(buildOpenControl(node));

      // Family + type badges and content info (dynamic nodes only).
      if (type) {
        const familyLabel = type.label.toUpperCase();
        const familyW = Math.round(familyLabel.length * 7.2) + 18;
        clipped.appendChild(buildBadge(familyLabel, 'family', 12, 44));

        let typeInfo;
        if (node.type === 'vst') {
          const inst = hub.nodes && hub.nodes.get(node.id);
          const plugins = inst && inst.content && Array.isArray(inst.content.plugins)
            ? inst.content.plugins
            : [];
          typeInfo = vstTypeBadge(plugins);
          const sub = svgEl('text', { class: 'node-subtitle', x: 12, y: 76 });
          sub.textContent = `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`;
          clipped.appendChild(sub);
        } else {
          typeInfo = { text: 'EMPTY', className: 'empty' };
        }
        clipped.appendChild(buildBadge(typeInfo.text, `type ${typeInfo.className}`, 12 + familyW + 6, 44));
      }

      g.appendChild(clipped);

      if (node.id === MINILAB_NODE_ID) {
        const connectedPortIds = new Set(cables
          .filter((cable) => cable.from.nodeId === node.id)
          .map((cable) => cable.from.portId));
        const surfaceHolder = svgEl('g', { transform: `translate(${MINILAB_SURFACE_X} ${MINILAB_SURFACE_Y}) scale(${MINILAB_SURFACE_SCALE})` });
        appendMiniLabControlSurfaceSvg(surfaceHolder, {
          connectedPortIds,
          buildPort: (control, x, y) => buildPort(
            { id: control.portId, type: 'control', label: control.label },
            'output', x, y, node.id, false
          )
        });
        g.appendChild(surfaceHolder);
        viewSideSwitch = buildViewSideSwitch();
        g.appendChild(viewSideSwitch);
        const midi = node.outputs.find((port) => port.id === 'midi-out');
        if (midi) g.appendChild(buildPort(midi, 'output', NODE_WIDTH, 146, node.id));
      }
      // Inputs on the left (I/O dock).
      node.inputs.forEach((port, i) => {
        g.appendChild(buildPort(port, 'input', 0, portY(node, i), node.id));
      });
      // Outputs on the right (I/O dock).
      if (node.id !== MINILAB_NODE_ID) node.outputs.forEach((port, i) => {
          g.appendChild(buildPort(port, 'output', NODE_WIDTH, portY(node, i), node.id));
        });

      nodesLayer.appendChild(g);
      nodeEls.set(node.id, g);
    });
    updateViewSideSwitch();
  }

  function buildViewSideSwitch() {
    const group = svgEl('g', {
      class: 'view-side-switch', transform: 'translate(72 135)',
      role: 'button', tabindex: '0', 'aria-label': 'Show rear cable view'
    });
    group.appendChild(svgEl('rect', { class: 'view-side-switch-bg', width: 66, height: 22, rx: 5 }));
    group.appendChild(svgEl('text', { class: 'view-side-switch-label', x: 33, y: 15, 'text-anchor': 'middle' }));
    return group;
  }

  function buildOpenControl(node) {
    const width = 46;
    const group = svgEl('g', {
      class: 'node-open-control', transform: `translate(${NODE_WIDTH - 12 - width} 11)`,
      role: 'button', tabindex: '0', 'aria-label': `Open ${node.name}`
    });
    group.dataset.nodeAction = 'open';
    const tooltip = svgEl('title');
    tooltip.textContent = `Open ${node.name}`;
    group.appendChild(tooltip);
    group.appendChild(svgEl('rect', { width, height: 18, rx: 4 }));
    const label = svgEl('text', { x: width / 2, y: 12.5, 'text-anchor': 'middle' });
    label.textContent = 'OPEN';
    group.appendChild(label);
    return group;
  }

  function updateViewSideSwitch() {
    if (!viewSideSwitch) return;
    viewSideSwitch.classList.toggle('active', rearView);
    viewSideSwitch.setAttribute('aria-pressed', rearView ? 'true' : 'false');
    viewSideSwitch.setAttribute('aria-label', rearView ? 'Return to front cable view' : 'Show rear cable view');
    const label = Array.from(viewSideSwitch.children).find((child) => child.classList?.contains('view-side-switch-label'));
    if (label) label.textContent = rearView ? 'Front View' : 'Rear View';
  }

  /** Semantic type badge for a VST node based on its plugin chain. */
  function vstTypeBadge(plugins) {
    if (!plugins || plugins.length === 0) {
      return { text: 'EMPTY', className: 'empty' };
    }
    const roles = new Set(plugins.map((p) => getVstRole(p.role).id));
    if (roles.size === 1) {
      const role = getVstRole(plugins[0].role);
      return { text: role.badge, className: `role-${role.id}` };
    }
    return { text: 'MIXED', className: 'mixed' };
  }

  /** Build a compact pill badge (rect + text) with an estimated width. */
  function buildBadge(text, className, x, y) {
    const w = Math.round(text.length * 7.2) + 18;
    const g = svgEl('g', { class: `node-badge ${className}`, transform: `translate(${x} ${y})` });
    g.appendChild(svgEl('rect', { class: 'node-badge-bg', width: w, height: 16, rx: 8 }));
    const t = svgEl('text', { class: 'node-badge-text', x: 9, y: 11 });
    t.textContent = text;
    g.appendChild(t);
    return g;
  }

  function buildPort(port, side, x, y, nodeId, showLabel = true) {
    const info = portTypeInfo(port.type);
    const g = svgEl('g', {
      class: `port port-${side} type-${info.className}`,
      transform: `translate(${x} ${y})`
    });
    g.dataset.nodeId = nodeId;
    g.dataset.portId = port.id;
    g.dataset.side = side;
    g.dataset.type = port.type;

    const jack = svgEl('g', { class: 'jack' });
    if (info.shape === 'square') {
      jack.appendChild(svgEl('rect', { x: -5, y: -5, width: 10, height: 10, rx: 2 }));
    } else if (info.shape === 'triangle') {
      jack.appendChild(svgEl('polygon', { points: '0,-6 5.5,4 -5.5,4' }));
    } else {
      jack.appendChild(svgEl('circle', { r: 5 }));
    }
    g.appendChild(jack);

    const label = svgEl('text', {
      class: 'port-label',
      x: side === 'input' ? 12 : -12,
      'text-anchor': side === 'input' ? 'start' : 'end'
    });
    label.textContent = port.label || info.label;
    if (showLabel) g.appendChild(label);

    // Larger invisible hit area so jacks are easy to grab (input endpoints).
    const hit = svgEl('rect', {
      class: 'port-hit',
      x: side === 'input' ? -8 : -14,
      y: -10,
      width: side === 'input' ? 22 : 28,
      height: 20
    });
    g.appendChild(hit);

    return g;
  }

  function cablePath(from, to) {
    const dx = Math.max(48, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }

  // ---------- selection ----------

  /** A node is deletable only when its project-owned type permits it. */
  function isDeletable(nodeId) {
    const instance = hub.nodes?.get(nodeId);
    return Boolean(instance && getNodeType(instance.type)?.deletable !== false);
  }

  /** A node is copyable only when its project-owned type permits it. */
  function isCopyable(nodeId) {
    const instance = hub.nodes?.get(nodeId);
    return Boolean(instance && getNodeType(instance.type)?.copyable !== false);
  }

  /** True when the keyboard event target is an editable text control. */
  function isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName ? String(target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return Boolean(target.isContentEditable);
  }

  /**
   * Delete a dynamic node and clear every Patch Bay reference to it.
   *
   * `hub.nodes.delete` owns the real teardown (engine chain, graph
   * connections, layout, module registration, persistence); this only clears
   * the view state that would otherwise keep pointing at a node that is gone.
   */
  function deleteNode(nodeId) {
    if (!isDeletable(nodeId)) return false;
    hub.nodes.delete(nodeId);
    if (selectedNodeId === nodeId) setSelectedNode(null);
    if (contextNodeId === nodeId) contextNodeId = null;
    return true;
  }

  /** Select a node (Patch Bay UI state only). Selecting a node clears cable selection. */
  function setSelectedNode(id) {
    selectedNodeId = id;
    if (id) setSelectedCable(null);
    for (const [nodeId, el] of nodeEls) {
      el.classList.toggle('selected', nodeId === id);
    }
  }

  // ---------- clipboard / copy / paste ----------

  /** Copy a dynamic node into the internal clipboard (native nodes cannot be copied). */
  function copyNode(nodeId) {
    if (!isCopyable(nodeId)) return;
    const inst = hub.nodes.get(nodeId);
    if (!inst) return;
    clipboard = {
      type: inst.type,
      content: inst.content ? JSON.parse(JSON.stringify(inst.content)) : null
    };
  }

  /** Paste the clipboard into a new independent instance at a world position. */
  function pasteNode(worldPos) {
    if (!clipboard) return;
    const instance = hub.nodes.createFromSnapshot(clipboard);
    if (!instance) return;
    placeNode(instance, resolveNodePos(clipboard.type, worldPos));
  }

  /** Create a new empty dynamic node of a type at a world position. */
  function createNodeAt(typeId, worldPos) {
    const instance = hub.nodes.create(typeId);
    if (!instance) return;
    placeNode(instance, resolveNodePos(typeId, worldPos));
  }

  /** Place a freshly created node at a world position, select it, and re-render. */
  function placeNode(instance, pos) {
    layout.set(instance.id, pos.x, pos.y);
    positions.set(instance.id, pos);
    setSelectedNode(instance.id);
    render();
  }

  /**
   * Resolve a paste/create position, nudging deterministically when it would
   * overlap an existing node so repeated pastes do not stack exactly on top.
   */
  function resolveNodePos(typeId, worldPos) {
    const type = getNodeType(typeId);
    const ports = (type && type.ports) || {};
    const synth = { inputs: ports.inputs || [], outputs: ports.outputs || [] };
    const geo = nodeGeometry(synth, { x: 0, y: 0 });
    let pos = { x: worldPos.x, y: worldPos.y };
    const nodes = buildVisualNodes(hub.graph);
    let attempts = 0;
    while (attempts < 10) {
      let overlap = false;
      for (const n of nodes) {
        const p = positions.get(n.id) || layout.get(n.id, 0);
        const b = nodeGeometry(n, p);
        if (pos.x < p.x + b.width && pos.x + geo.width > p.x &&
            pos.y < p.y + b.height && pos.y + geo.height > p.y) {
          overlap = true;
          break;
        }
      }
      if (!overlap) break;
      pos.x += 32;
      pos.y += 32;
      attempts++;
    }
    return pos;
  }

  /** World position at the centre of the visible canvas. */
  function viewportCenterWorld() {
    const r = svgRect();
    return {
      x: viewport.x + (r.width / viewport.zoom) / 2,
      y: viewport.y + (r.height / viewport.zoom) / 2
    };
  }

  /** World position under the pointer, or the viewport centre if it is elsewhere. */
  function pointerWorldOrCenter() {
    const r = svgRect();
    if (lastPointerClient &&
        lastPointerClient.x >= r.left && lastPointerClient.x <= r.right &&
        lastPointerClient.y >= r.top && lastPointerClient.y <= r.bottom) {
      return screenToWorld(viewport, {
        x: lastPointerClient.x - r.left,
        y: lastPointerClient.y - r.top
      });
    }
    return viewportCenterWorld();
  }

  /** Ctrl+V: paste around the pointer (if over the canvas) or the viewport centre. */
  function pasteAtPointerOrCenter() {
    if (!clipboard) return;
    pasteNode(pointerWorldOrCenter());
  }

  // ---------- context menu ----------

  function closeContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.remove();
      contextMenuEl = null;
    }
    contextNodeId = null;
  }

  function openSubmenuToAvailableSide(wrap) {
    const submenu = [...wrap.children].find((child) => child.classList?.contains('ctx-sub'));
    if (!submenu) return;
    wrap.classList.add('ctx-expanded');
    submenu.classList.remove('ctx-flip-left');
    submenu.style.left = '100%';
    submenu.style.right = 'auto';
    submenu.style.top = '-4px';
    const viewport = container.getBoundingClientRect();
    const parent = wrap.getBoundingClientRect();
    const width = submenu.offsetWidth || 140;
    const height = submenu.offsetHeight || 40;
    const rightFits = parent.right + width <= viewport.right - 8;
    const leftFits = parent.left - width >= viewport.left + 8;
    if (!rightFits && leftFits) {
      submenu.classList.add('ctx-flip-left');
      submenu.style.left = 'auto';
      submenu.style.right = '100%';
    }
    else if (!rightFits) {
      const desiredLeft = Math.max(viewport.left + 8, Math.min(parent.right, viewport.right - width - 8));
      submenu.style.left = `${desiredLeft - parent.left}px`;
      submenu.style.right = 'auto';
    }
    const top = Math.max(viewport.top + 8, Math.min(parent.top - 4, viewport.bottom - height - 8));
    submenu.style.top = `${top - parent.top}px`;
  }

  function closeSubmenuBranch(wrap) {
    wrap.classList.remove('ctx-expanded');
    const pending = [...wrap.children];
    while (pending.length) {
      const child = pending.pop();
      if (child.classList?.contains('ctx-submenu')) child.classList.remove('ctx-expanded');
      pending.push(...(child.children || []));
    }
  }

  function armSubmenu(wrap) {
    let closeTimer = null;
    wrap.addEventListener('pointerenter', () => {
      if (closeTimer) clearTimeout(closeTimer);
      const parentPanel = wrap.parentElement || wrap.parentNode;
      if (parentPanel) {
        [...parentPanel.children].forEach((sibling) => {
          if (sibling !== wrap && sibling.classList?.contains('ctx-submenu')) {
            closeSubmenuBranch(sibling);
          }
        });
      }
      openSubmenuToAvailableSide(wrap);
    });
    wrap.addEventListener('pointerleave', () => {
      closeTimer = setTimeout(() => closeSubmenuBranch(wrap), 180);
    });
  }

  /** Position a menu near the pointer, clamped inside the visible container. */
  function positionMenu(menu, clientX, clientY) {
    const r = container.getBoundingClientRect();
    const mw = menu.offsetWidth || 150;
    const mh = menu.offsetHeight || 40;
    let left = clientX - r.left;
    let top = clientY - r.top;
    if (left + mw > r.width - 8) left = r.width - mw - 8;
    if (top + mh > r.height - 8) top = r.height - mh - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    container.appendChild(menu);
    contextMenuEl = menu;
  }

  /** Node context menu. Native/system nodes expose no actions. */
  function openNodeContextMenu(nodeId, clientX, clientY) {
    closeContextMenu();
    const canCopy = isCopyable(nodeId);
    const canDelete = isDeletable(nodeId);
    if (!canCopy && !canDelete) return; // native/fixed: no Copy, no Delete
    contextNodeId = nodeId;

    const menu = document.createElement('div');
    menu.classList.add('node-context-menu');

    if (canCopy) {
      const copy = document.createElement('button');
      copy.classList.add('ctx-item');
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        copyNode(nodeId);
        closeContextMenu();
      });
      menu.appendChild(copy);
    }

    if (canCopy && canDelete) {
      const sep = document.createElement('div');
      sep.classList.add('ctx-separator');
      menu.appendChild(sep);
    }

    if (canDelete) {
      const del = document.createElement('button');
      del.classList.add('ctx-item');
      del.textContent = 'Delete Node';
      del.addEventListener('click', () => {
        deleteNode(nodeId);
        closeContextMenu();
      });
      menu.appendChild(del);
    }

    positionMenu(menu, clientX, clientY);
  }

  /** Empty-canvas context menu: New Node submenu + Paste. */
  function openCanvasContextMenu(clientX, clientY) {
    closeContextMenu();
    contextNodeId = null;
    const r = svgRect();
    const world = screenToWorld(viewport, { x: clientX - r.left, y: clientY - r.top });

    const menu = document.createElement('div');
    menu.classList.add('node-context-menu');

    // OmniBox hierarchy is driven by populated families in the Node Type Registry.
    const subWrap = document.createElement('div');
    subWrap.classList.add('ctx-submenu');
    const parent = document.createElement('button');
    parent.classList.add('ctx-item', 'ctx-parent');
    parent.textContent = 'OmniBox';
    const parentCaret = document.createElement('span');
    parentCaret.classList.add('ctx-caret'); parentCaret.textContent = '›'; parent.appendChild(parentCaret);
    const sub = document.createElement('div');
    sub.classList.add('ctx-sub');
    listOmniBoxCategories().forEach((category) => {
      const categoryWrap = document.createElement('div');
      categoryWrap.classList.add('ctx-submenu');
      const categoryButton = document.createElement('button');
      categoryButton.classList.add('ctx-item', 'ctx-parent');
      categoryButton.textContent = category.label;
      const categoryCaret = document.createElement('span');
      categoryCaret.classList.add('ctx-caret'); categoryCaret.textContent = '›'; categoryButton.appendChild(categoryCaret);
      const categorySub = document.createElement('div');
      categorySub.classList.add('ctx-sub');
      category.types.forEach((t) => {
        const btn = document.createElement('button');
        btn.classList.add('ctx-item');
        btn.textContent = t.label;
        btn.dataset.nodeType = t.id;
        btn.addEventListener('click', () => {
          createNodeAt(t.id, world);
          closeContextMenu();
        });
        categorySub.appendChild(btn);
      });
      categoryWrap.appendChild(categoryButton);
      categoryWrap.appendChild(categorySub);
      sub.appendChild(categoryWrap);
    });
    subWrap.appendChild(parent);
    subWrap.appendChild(sub);
    armSubmenu(subWrap);
    [...sub.children].forEach(armSubmenu);
    menu.appendChild(subWrap);

    const sep = document.createElement('div');
    sep.classList.add('ctx-separator');
    menu.appendChild(sep);

    const paste = document.createElement('button');
    paste.classList.add('ctx-item');
    paste.textContent = 'Paste';
    paste.disabled = !clipboard;
    paste.addEventListener('click', () => {
      if (clipboard) pasteNode(world);
      closeContextMenu();
    });
    menu.appendChild(paste);

    positionMenu(menu, clientX, clientY);
  }

  function onGlobalPointerDown(e) {
    if (contextMenuEl && !(e.target && e.target.closest && e.target.closest('.node-context-menu'))) {
      closeContextMenu();
    }
  }

  // ---------- interactions ----------

  function onPointerDown(e) {
    const openEl = e.target.closest?.('.node-open-control');
    if (openEl) {
      e.preventDefault();
      e.stopPropagation();
      openNodeAction(openEl.closest('.node')?.dataset.nodeId);
      return;
    }
    if (e.target.closest?.('.view-side-switch')) {
      e.preventDefault();
      e.stopPropagation();
      toggleViewSide();
      return;
    }
    // Right button: potential context click or pan start on empty canvas.
    if (e.button === 2) {
      const portEl = e.target.closest('.port');
      const nodeEl = e.target.closest('.node');
      if (!portEl && !nodeEl) {
        rightDown = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId };
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      return;
    }
    if (e.button !== 0) return;

    const portEl = e.target.closest('.port');
    if (portEl && portEl.dataset.side === 'output') {
      startCableDrag(e, portEl);
      return;
    }

    // Left-drag a connected input endpoint to physically unplug that cable.
    if (portEl && portEl.dataset.side === 'input') {
      const conns = hub.graph.connectionsTo(portEl.dataset.nodeId, portEl.dataset.portId);
      if (conns.length > 0) {
        startUnplugDrag(e, portEl, conns[0]);
        return;
      }
    }

    const nodeEl = e.target.closest('.node');
    if (nodeEl && !portEl) {
      startNodeDrag(e, nodeEl);
      return;
    }

    // Clicking empty canvas deselects nodes and cables.
    if (selectedCableId) setSelectedCable(null);
    if (selectedNodeId) setSelectedNode(null);
  }

  /** Single entry point for "show me this node's page" (chip, tap, dblclick). */
  function openNodeEditor(nodeId) {
    if(!nodeId||!hub.nodes?.get(nodeId)||!hub.modules?.get(nodeId))return false;
    hub.modules.activate(nodeId,container);
    return true;
  }

  /**
   * Patch Bay OPEN button behavior (contextual for VST nodes).
   *
   * For a VST node:
   *   - if the chain holds a usable (ready) primary plugin, open/foreground its
   *     native editor and stay on the Patch Bay;
   *   - otherwise (empty chain, or the primary plugin is still loading/failed)
   *     navigate to that node's MiniHub VST page so the user can select/add a
   *     plugin.
   * The primary plugin is the first entry in the chain, matching the existing
   * chain semantics (no new chain-selection model). Non-VST nodes keep the
   * plain "open this node's page" behavior.
   */
  function openNodeAction(nodeId) {
    if (!nodeId) return;
    const instance = hub.nodes?.get(nodeId);
    if (!instance) return;
    if (instance.type === 'vst') {
      const chain = hub.nodes.getChain(nodeId);
      const primary = chain && chain.plugins && chain.plugins[0];
      if (primary) {
        const status = hub.engine.getInstanceStatus(nodeId, primary.id);
        if (status === 'ready') {
          hub.engine.openEditor(nodeId, primary.id);
          return; // stay on Routing / Patch Bay
        }
      }
    }
    openNodeEditor(nodeId);
  }

  /**
   * Pointer-level double-tap.
   *
   * A node press captures the pointer on the SVG root, and the browser then
   * retargets the synthesized click/dblclick to that capture element - so the
   * `dblclick` listener on the nodes layer never sees it and double-clicking a
   * node did nothing. Counting taps where the node did not move reproduces the
   * intent without depending on those synthesized events.
   */
  function registerNodeTap(nodeId) {
    const now = Date.now();
    if (lastNodeTap && lastNodeTap.nodeId === nodeId && now - lastNodeTap.at < 400) {
      lastNodeTap = null;
      openNodeEditor(nodeId);
      return;
    }
    lastNodeTap = { nodeId, at: now };
  }

  function onNodeDoubleClick(e){
    if(e.target.closest?.('.port'))return;
    const nodeId=e.target.closest?.('.node')?.dataset.nodeId;
    if(!openNodeEditor(nodeId))return;
    e.preventDefault();e.stopPropagation();
  }

  // --- pan (right-drag) ---

  function startPan(startClient, pointerId) {
    // Capture a FIXED drag origin. The pointer reference frame (startClient,
    // startPan, startZoom) must stay stable for the whole drag even though the
    // viewBox updates continuously.
    drag = {
      kind: 'pan',
      clientX: startClient.x,
      clientY: startClient.y,
      panX: viewport.x,
      panY: viewport.y,
      zoom: viewport.zoom
    };
    svg.setPointerCapture(pointerId);
    svg.classList.add('panning');
    // A right-drag pan must not open a context menu when released, so suppress
    // the context menu event that follows the pan.
    suppressContextMenu = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressContextMenu = false;
      suppressTimer = null;
    }, 800);
  }

  function movePan(e) {
    // Compute only from the fixed start values; never from the already-updated
    // viewport, so repeated pointermove events cannot accumulate or amplify.
    const next = panFromStart(drag, { clientX: e.clientX, clientY: e.clientY });
    viewport.x = next.x;
    viewport.y = next.y;
    applyViewBox();
  }

  function endPan() {
    svg.classList.remove('panning');
    viewportStore.save(viewport.x, viewport.y, viewport.zoom);
    drag = null;
  }

  // --- node drag ---

  function startNodeDrag(e, nodeEl) {
    const nodeId = nodeEl.dataset.nodeId;
    // Left-click / left-drag selects the node (and moves it).
    setSelectedNode(nodeId);
    const pos = positions.get(nodeId);
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = pos.x;
    const origY = pos.y;

    drag = {
      kind: 'node',
      nodeId,
      startX,
      startY,
      origX,
      origY
    };

    svg.setPointerCapture(e.pointerId);
    nodeEl.classList.add('dragging');
    e.preventDefault();
  }

  function moveNodeDrag(e) {
    const d = drag;
    // Ctrl is checked live during the drag, so the user can press or release
    // it without restarting the drag. Snap applies to world coordinates only.
    const pos = dragPosition(
      { x: d.origX, y: d.origY, clientX: d.startX, clientY: d.startY },
      { clientX: e.clientX, clientY: e.clientY },
      viewport.zoom,
      e.ctrlKey
    );

    positions.set(d.nodeId, pos);
    const el = nodeEls.get(d.nodeId);
    if (el) el.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
    updateCables();
  }

  function endNodeDrag() {
    const d = drag;
    const el = nodeEls.get(d.nodeId);
    if (el) el.classList.remove('dragging');
    // Persist view state (never routing state).
    const pos = positions.get(d.nodeId);
    layout.set(d.nodeId, pos.x, pos.y);
    drag = null;
    if (pos.x === d.origX && pos.y === d.origY) registerNodeTap(d.nodeId);
  }

  // --- cable drag (create connection) ---

  function startCableDrag(e, portEl) {
    const nodeId = portEl.dataset.nodeId;
    const portId = portEl.dataset.portId;
    const node = hub.graph.getNode(nodeId);
    const port = node && node.outputs.find((p) => p.id === portId);
    if (!port) return;

    const pos = positions.get(nodeId);
    const geo = nodeGeometry(
      { id: node.id, inputs: node.inputs, outputs: node.outputs },
      pos
    );
    const out = geo.outputs.find((p) => p.port.id === portId);

    const fromPoint = { x: out.x, y: out.y };
    const temp = svgEl('path', {
      class: 'cable temp',
      d: cablePath(fromPoint, toSvgPoint(e))
    });
    cablesLayer.appendChild(temp);

    drag = {
      kind: 'cable',
      fromNodeId: nodeId,
      fromPortId: portId,
      fromType: port.type,
      fromPoint,
      temp,
      fromPortEl: portEl
    };

    svg.setPointerCapture(e.pointerId);
    portEl.classList.add('active');
    e.preventDefault();
  }

  function moveCableDrag(e) {
    const d = drag;
    const pt = toSvgPoint(e);
    d.temp.setAttribute('d', cablePath(d.fromPoint, pt));
  }

  function endCableDrag(e) {
    const d = drag;
    d.temp.remove();
    if (d.fromPortEl) d.fromPortEl.classList.remove('active');

    const target = document.elementFromPoint(e.clientX, e.clientY);
    const portEl = target && target.closest ? target.closest('.port') : null;

    if (portEl && portEl.dataset.side === 'input') {
      const result = createConnection(hub.graph, {
        nodeId: d.fromNodeId,
        portId: d.fromPortId
      }, {
        nodeId: portEl.dataset.nodeId,
        portId: portEl.dataset.portId
      });
      if (!result.ok) {
        flashReject(portEl, result.reason);
      }
      // On success, graph:change re-renders automatically.
    } else if (portEl && portEl.dataset.side === 'output') {
      flashReject(portEl, 'output-to-output');
    }

    drag = null;
  }

  function flashReject(portEl, reason) {
    portEl.classList.add('reject');
    setTimeout(() => portEl.classList.remove('reject'), 450);
  }

  // --- unplug drag (grab a connected input endpoint) ---

  function findCableEl(connection) {
    for (const [id, el] of cableEls) {
      if (
        el.dataset.fromNodeId === connection.from.nodeId &&
        el.dataset.fromPortId === connection.from.portId &&
        el.dataset.toNodeId === connection.to.nodeId &&
        el.dataset.toPortId === connection.to.portId
      ) {
        return el;
      }
    }
    return null;
  }

  function startUnplugDrag(e, portEl, connection) {
    const fromNode = hub.graph.getNode(connection.from.nodeId);
    if (!fromNode) return;
    const fromPos = positions.get(connection.from.nodeId);
    const fromGeo = nodeGeometry(
      { inputs: fromNode.inputs, outputs: fromNode.outputs },
      fromPos
    );
    const fromOut = fromGeo.outputs.find((p) => p.port.id === connection.from.portId);
    if (!fromOut) return;

    // Keep the source end attached; dim the original cable while unplugging.
    const origEl = findCableEl(connection);
    if (origEl) origEl.classList.add('unplugging');

    const temp = svgEl('path', {
      class: 'cable temp',
      d: cablePath(fromOut, toSvgPoint(e))
    });
    cablesLayer.appendChild(temp);

    drag = {
      kind: 'unplug',
      connection,
      fromPoint: { x: fromOut.x, y: fromOut.y },
      temp,
      origEl,
      toPortEl: portEl
    };

    svg.setPointerCapture(e.pointerId);
    portEl.classList.add('active');
    e.preventDefault();
  }

  function moveUnplugDrag(e) {
    const d = drag;
    const pt = toSvgPoint(e);
    d.temp.setAttribute('d', cablePath(d.fromPoint, pt));
  }

  function endUnplugDrag(e) {
    const d = drag;
    d.temp.remove();
    if (d.origEl) d.origEl.classList.remove('unplugging');
    if (d.toPortEl) d.toPortEl.classList.remove('active');

    const target = document.elementFromPoint(e.clientX, e.clientY);
    const portEl = target && target.closest ? target.closest('.port') : null;

    // Release on empty canvas (not over any port) disconnects; releasing over
    // a port (original input or otherwise) keeps the connection unchanged.
    if (!portEl) {
      deleteConnection(hub.graph, d.connection);
    }

    drag = null;
  }

  // --- cable selection / deletion ---

  function onCableClick(e) {
    const el = e.target.closest('[data-cable-id]');
    if (!el || el.classList.contains('temp')) return;
    const cableId = el.dataset.cableId;
    // Ctrl + left click -> immediate disconnect (no selection step).
    if (e.ctrlKey) {
      const cable = buildVisualConnections(hub.graph).find((c) => c.id === cableId);
      if (cable) deleteConnection(hub.graph, cable);
      return;
    }
    setSelectedCable(cableId);
  }

  function setSelectedCable(id) {
    selectedCableId = id;
    for (const [cableId, el] of cableEls) {
      el.classList.toggle('selected', cableId === id);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (contextMenuEl) closeContextMenu();
      return;
    }
    // Never interfere with normal keyboard editing in text controls.
    if (isEditableTarget(e.target)) return;

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === 'c' || e.key === 'C')) {
      if (selectedNodeId) copyNode(selectedNodeId);
      e.preventDefault();
      return;
    }
    if (ctrl && (e.key === 'v' || e.key === 'V')) {
      pasteAtPointerOrCenter();
      e.preventDefault();
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;

    if (selectedCableId) {
      const cable = buildVisualConnections(hub.graph).find((c) => c.id === selectedCableId);
      if (cable) {
        deleteConnection(hub.graph, cable);
        // graph:change re-renders and clears selection.
      }
      e.preventDefault();
      return;
    }

    // Native/system nodes are not in hub.nodes, so deleteNode ignores them.
    if (selectedNodeId && deleteNode(selectedNodeId)) {
      e.preventDefault();
    }
  }

  // ---------- helpers ----------

  function svgRect() {
    return svg.getBoundingClientRect();
  }

  function toSvgPoint(e) {
    // Convert the screen cursor position to world coordinates so the temp
    // cable is drawn in the same space as nodes/cables (via the viewBox).
    const r = svgRect();
    return screenToWorld(viewport, { x: e.clientX - r.left, y: e.clientY - r.top });
  }

  function updateCables() {
    const nodes = buildVisualNodes(hub.graph);
    const cables = buildVisualConnections(hub.graph);
    const geo = new Map();
    nodes.forEach((node) => geo.set(node.id, nodeGeometry(node, positions.get(node.id))));

    cables.forEach((cable) => {
      const fromGeo = geo.get(cable.from.nodeId);
      const toGeo = geo.get(cable.to.nodeId);
      const fromPort = fromGeo && fromGeo.outputs.find((p) => p.port.id === cable.from.portId);
      const toPort = toGeo && toGeo.inputs.find((p) => p.port.id === cable.to.portId);
      if (!fromPort || !toPort) return;
      const d = cablePath(fromPort, toPort);
      const el = cableEls.get(cable.id);
      if (el) el.setAttribute('d', d);
      const hit = cableHits.get(cable.id);
      if (hit) hit.setAttribute('d', d);
    });
  }

  // ---------- lifecycle ----------

  function isPersistedViewport(v) {
    return Boolean(
      v && typeof v === 'object' &&
      Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom)
    );
  }

  function fitToNodes() {
    const nodes = buildVisualNodes(hub.graph);
    const rects = nodes.map((node) => {
      const pos = positions.get(node.id) || layout.get(node.id, 0);
      const geo = nodeGeometry(node, { x: 0, y: 0 });
      return { x: pos.x, y: pos.y, width: geo.width, height: geo.height };
    });
    const r = svgRect();
    viewport = fitViewport(rects, { width: r.width, height: r.height });
    applyViewBox();
    updateZoomDisplay();
  }

  function applyViewSide() {
    if (!svg || !cablesLayer || !nodesLayer) return;
    // appendChild moves an existing SVG layer without recreating ports/cables.
    // This changes presentation only; hub.graph remains the topology authority.
    if (rearView) {
      if (cablesLayer.parentNode === svg) svg.removeChild(cablesLayer);
      svg.appendChild(cablesLayer);
    }
    else {
      if (cablesLayer.parentNode === svg) svg.removeChild(cablesLayer);
      if (nodesLayer.parentNode === svg) svg.removeChild(nodesLayer);
      svg.appendChild(cablesLayer);
      svg.appendChild(nodesLayer);
    }
    cablesLayer.classList.toggle('rear', rearView);
    svg.classList.toggle('rear-view', rearView);
    updateViewSideSwitch();
  }

  function setRearView(enabled) {
    rearView = enabled === true;
    applyViewSide();
    return rearView;
  }

  function toggleViewSide() {
    setRearView(!rearView);
  }

  function mount(el) {
    container = el;
    container.classList.add('routing-host');
    layout = new GraphLayout(hub.settings);
    viewportStore = new GraphViewport(hub.settings);
    const hasPersisted = isPersistedViewport(hub.settings.get('graphViewport'));
    viewport = viewportStore.load();

    container.innerHTML = `
      <div class="routing-view">
        <div class="routing-toolbar">
          <span class="routing-title">Patch Bay</span>
          <span class="routing-hint">Double-click a node to edit · wheel to zoom · right-drag to pan · right-click for menu · drag output to input to connect</span>
          <span class="spacer"></span>
          <span class="legend">
            <span class="legend-item type-midi"><i class="jack-dot square"></i>MIDI</span>
            <span class="legend-item type-audio"><i class="jack-dot circle"></i>AUDIO</span>
            <span class="legend-item type-control"><i class="jack-dot triangle"></i>CTRL</span>
          </span>
          <span class="viewport-controls">
            <span id="routing-zoom" class="zoom-readout">100%</span>
            <button id="routing-reset" class="btn btn-sm">Reset View</button>
          </span>
          <span class="new-node-control">
            <select id="routing-new-type" class="select select-sm">
              ${listNodeTypes().map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}
            </select>
            <button id="routing-new-node" class="btn btn-sm primary">+ New Node</button>
          </span>
        </div>
        <div class="routing-canvas">
          <svg class="routing-svg" id="routing-svg"></svg>
        </div>
      </div>`;

    svg = container.querySelector('#routing-svg');

    buildGrid();

    clipDefs = svgEl('defs');
    svg.appendChild(clipDefs);

    cablesLayer = svgEl('g', { class: 'cables' });
    nodesLayer = svgEl('g', { class: 'nodes' });
    svg.appendChild(cablesLayer);
    svg.appendChild(nodesLayer);
    applyViewSide();

    render();

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('contextmenu', onContextMenu);
    cablesLayer.addEventListener('click', onCableClick);
    nodesLayer.addEventListener('dblclick',onNodeDoubleClick);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onGlobalPointerDown);

    const resetBtn = container.querySelector('#routing-reset');
    if (resetBtn) resetBtn.addEventListener('click', resetView);

    const newBtn = container.querySelector('#routing-new-node');
    const newType = container.querySelector('#routing-new-type');
    if (newBtn && hub.nodes) {
      // Same path as the canvas context menu: place it, select it, render.
      // Calling hub.nodes.create() directly left the node unplaced and
      // unselected, so "+ New Node" and "right-click > New Node" disagreed.
      newBtn.addEventListener('click', () => {
        createNodeAt(newType ? newType.value : 'vst', viewportCenterWorld());
      });
    }

    applyViewBox();
    updateZoomDisplay();
    // First open with no persisted viewport: fit the existing nodes so the
    // Patch Bay is never empty. A valid persisted viewport is left untouched.
    if (!hasPersisted) {
      fitToNodes();
    }
    window.addEventListener('resize', applyViewBox);

    subs.push(
      hub.events.on('graph:change', onGraphChange),
      () => window.removeEventListener('resize', applyViewBox)
    );
  }

  function buildGrid() {
    // The grid is an infinite world-space pattern (userSpaceOnUse tiles across
    // the whole plane). The background rects are just the visible window into
    // it and are repositioned to match the viewBox on every applyViewBox, so
    // there is no finite boundary and no giant fixed rectangle.
    const defs = svgEl('defs');

    const minor = svgEl('pattern', {
      id: 'grid-minor', width: GRID_SIZE, height: GRID_SIZE, patternUnits: 'userSpaceOnUse'
    });
    minor.appendChild(svgEl('path', { d: `M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`, fill: 'none', class: 'grid-line' }));
    defs.appendChild(minor);

    const majorSize = GRID_SIZE * 5;
    const major = svgEl('pattern', {
      id: 'grid-major', width: majorSize, height: majorSize, patternUnits: 'userSpaceOnUse'
    });
    major.appendChild(svgEl('path', { d: `M ${majorSize} 0 L 0 0 0 ${majorSize}`, fill: 'none', class: 'grid-line-major' }));
    defs.appendChild(major);

    svg.appendChild(defs);

    gridRects = [
      svgEl('rect', { class: 'grid-bg', fill: 'url(#grid-major)' }),
      svgEl('rect', { class: 'grid-bg', fill: 'url(#grid-minor)' })
    ];
    gridRects.forEach((rect) => svg.appendChild(rect));
  }

  function applyViewBox() {
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    // viewBox shows the world region [pan, pan + size/zoom]; the browser maps
    // world -> screen, so nodes/cables stay in world coordinates with no drift.
    svg.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${w / viewport.zoom} ${h / viewport.zoom}`);
    // Keep the grid window covering exactly the visible region.
    for (const rect of gridRects) {
      rect.setAttribute('x', viewport.x);
      rect.setAttribute('y', viewport.y);
      rect.setAttribute('width', w / viewport.zoom);
      rect.setAttribute('height', h / viewport.zoom);
    }
  }

  function updateZoomDisplay() {
    const el = container && container.querySelector('#routing-zoom');
    if (el) el.textContent = `${Math.round(viewport.zoom * 100)}%`;
  }

  function onWheel(e) {
    e.preventDefault();
    const r = svgRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    // Wheel up (negative deltaY) zooms in; exponential factor keeps it smooth.
    const factor = Math.pow(2, -e.deltaY / 400);
    const next = zoomAt(viewport, screen, viewport.zoom * factor);
    viewport = next;
    applyViewBox();
    updateZoomDisplay();
    viewportStore.save(viewport.x, viewport.y, viewport.zoom);
  }

  function onContextMenu(e) {
    e.preventDefault();
    // Consume the suppression flag set by a right-drag pan so a menu is not
    // opened accidentally when panning the empty canvas.
    if (suppressContextMenu) {
      suppressContextMenu = false;
      if (suppressTimer) {
        clearTimeout(suppressTimer);
        suppressTimer = null;
      }
      return;
    }
    const nodeEl = e.target.closest('.node');
    if (nodeEl) {
      // Open the menu for the target node WITHOUT changing the current selection.
      openNodeContextMenu(nodeEl.dataset.nodeId, e.clientX, e.clientY);
    } else {
      openCanvasContextMenu(e.clientX, e.clientY);
    }
  }

  function resetView() {
    // Fit all nodes into view instead of restoring a fixed origin, so the
    // Patch Bay never appears empty. Only viewport pan/zoom change.
    fitToNodes();
    viewportStore.save(viewport.x, viewport.y, viewport.zoom);
  }

  function onPointerMove(e) {
    lastPointerClient = { x: e.clientX, y: e.clientY };

    // Right-button potential context click: start pan once movement exceeds
    // the threshold (otherwise it stays a context click).
    if (rightDown && !drag) {
      const dx = e.clientX - rightDown.clientX;
      const dy = e.clientY - rightDown.clientY;
      if (Math.hypot(dx, dy) > PAN_THRESHOLD) {
        startPan({ x: rightDown.clientX, y: rightDown.clientY }, rightDown.pointerId);
        rightDown = null;
      }
      return;
    }

    if (!drag) return;
    if (drag.kind === 'node') moveNodeDrag(e);
    else if (drag.kind === 'cable') moveCableDrag(e);
    else if (drag.kind === 'unplug') moveUnplugDrag(e);
    else if (drag.kind === 'pan') movePan(e);
  }

  function onPointerUp(e) {
    // Right-click without drag: clear the pending state; the contextmenu event
    // that follows will open the appropriate menu.
    if (rightDown) {
      rightDown = null;
      return;
    }
    if (!drag) return;
    if (drag.kind === 'node') endNodeDrag();
    else if (drag.kind === 'cable') endCableDrag(e);
    else if (drag.kind === 'unplug') endUnplugDrag(e);
    else if (drag.kind === 'pan') endPan();
  }

  function onGraphChange() {
    // Graph is the source of truth; re-derive the visual model.
    render();
  }

  function unmount() {
    subs.forEach((u) => u());
    subs = [];
    if (svg) {
      svg.removeEventListener('pointerdown', onPointerDown);
      svg.removeEventListener('pointermove', onPointerMove);
      svg.removeEventListener('pointerup', onPointerUp);
      svg.removeEventListener('pointercancel', onPointerUp);
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('contextmenu', onContextMenu);
      cablesLayer.removeEventListener('click', onCableClick);
      nodesLayer.removeEventListener('dblclick',onNodeDoubleClick);
    }
    const resetBtn = container && container.querySelector('#routing-reset');
    if (resetBtn) resetBtn.removeEventListener('click', resetView);
    window.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onGlobalPointerDown);
    if (container) container.classList.remove('routing-host');
    container = null;
    svg = null;
    cablesLayer = null;
    nodesLayer = null;
    clipDefs = null;
    positions = new Map();
    nodeEls = new Map();
    cableEls = new Map();
    cableHits = new Map();
    gridRects = [];
    viewport = { x: 0, y: 0, zoom: 1 };
    selectedCableId = null;
    selectedNodeId = null;
    contextNodeId = null;
    clipboard = null;
    rightDown = null;
    lastPointerClient = null;
    if (contextMenuEl) {
      contextMenuEl.remove();
      contextMenuEl = null;
    }
    suppressContextMenu = false;
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
    drag = null;
    rearView = false;
    viewSideSwitch = null;
  }

  return {
    id: 'routing',
    name: 'Routing',
    navEntry: { label: 'Routing', icon: 'cable', group: 'node', fixed: true },
    mount,
    unmount,
    setRearView,
    isRearView: () => rearView
  };
}
