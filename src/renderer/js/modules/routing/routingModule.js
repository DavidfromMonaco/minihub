/**
 * Routing / Patch Bay module.
 *
 * A Reason-style rear-panel cable editor rendered in SVG. Nodes and cables
 * are always derived from `hub.network` — this editor is never the source of
 * truth for routing. Node positions are view state persisted separately via
 * `NetworkLayout` under the `networkLayout` settings key.
 *
 * Interactions:
 *   - drag a node body to move it (position is view state only)
 *   - drag from an output jack toward a compatible input jack to connect
 *   - click a cable to select it, then press Delete to remove it
 *   - left-click a node to select it (blue outline); Shift or Ctrl + click adds
 *     or removes one; left-drag on empty canvas draws a frame that selects every
 *     node it touches; dragging a selected node moves the whole selection;
 *     Delete removes them, Ctrl+A selects all, Escape none
 *   - Ctrl+C / Ctrl+V copy and paste the selected nodes, Ctrl+D duplicates
 *     them (internal clipboard; cables are never copied)
 *   - right-click a node -> its menu, acting on the selection it belongs to
 *   - right-click a cable -> Disconnect
 *   - right-click or double-click empty canvas -> the node types, narrowed by
 *     typing, then Paste, Select All, Align, Show All Nodes
 *   - right-drag empty canvas -> pan (click vs drag disambiguated by threshold)
 *
 * Rendering uses native SVG (no framework): nodes are `<g>` groups positioned
 * with `transform`, ports are jack glyphs, cables are cubic bezier paths.
 */
import { NetworkLayout, separateOverlaps, alignPositions, framedNodes, NODE_GAP } from '../../core/networkLayout.js';
import { NetworkViewport } from '../../core/networkViewport.js';
import { GRID_SIZE, dragPosition } from '../../core/grid.js';
import { closeContextMenu, openContextMenu } from '../../ui/contextMenu.js';
import { getNodeType, listNodeTypes, listOmniBoxCategories, nodeFamily } from '../../core/nodeTypes.js';
import { audioOutputLines, gainDb, meterReading, nodeSummaryLines, oneRingSceneId } from '../../core/nodeSummary.js';
import { AUDIO_OUTPUT_NODE_ID } from '../../core/systemNodes.js';
import {
  NODE_WIDTH,
  nodeWidth,
  IDENTITY_H,
  surfaceScale,
  surfacePortRowY,
  SURFACE_Y,
  SURFACE_X,
  portY,
  nodeGeometry
} from '../../core/nodeGeometry.js';
import {
  screenToWorld,
  zoomAt,
  panFromStart,
  fitViewport,
  nodeDetail,
  gridVisible
} from '../../core/viewportMath.js';
import {
  buildVisualNodes,
  buildVisualConnections,
  createConnection,
  deleteConnection,
  moveConnectionEnd,
  portTypeInfo
} from './routingCore.js';
import { appendMiniLabControlSurfaceSvg } from '../../ui/miniLabControlSurface.js';
import { surfaceControlsOfNode } from '../../midi/minilabControls.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Right-button click vs drag threshold (screen px): beyond this the gesture is
// treated as a pan, otherwise it is a context click.
const PAN_THRESHOLD = 4;

// A card's shape (D-055): square-ish corners, the family's corner drawn over
// the outline for CORNER_LEG units each way, and the readout under the title.
// IDENTITY_H (core/nodeGeometry.js) is what these have to fit in.
//
// The corner is a short bracket drawn along the outline itself, so its
// stroke (base.css) straddles the edge: half over the card, half past it --
// a clip fitted on the card rather than a line printed inside it (asked
// 2026-09-25). Its arc is wider than the card's by half the stroke, so the
// bracket is rounded inside as well as out: the inner curve is the card's
// own radius, the outer one follows it at the stroke's width.
const NODE_RADIUS = 4;
const CORNER_LEG = 14;
const CORNER_STROKE = 6; // base.css .node-corner stroke-width
const CORNER_ARC = NODE_RADIUS + CORNER_STROKE / 2;
const READOUT = Object.freeze({ x: 10, y: 34, h: 42, line: 15 });
// A Mixer's or Morpher's strips inside the readout: one per input, this far
// apart, as many as fit beside the master's value; the rest are counted.
const STRIP = Object.freeze({ pitch: 12, width: 5, top: 5, height: 24, labelY: 38, right: 58 });
// The OPEN chip's width, which the header's tag stands clear of.
const OPEN_W = 42;
// How fast a card's meter falls back, in fractions of its 60 dB scale per
// second -- 30 dB/s, a peak meter's release. It rises at once.
const METER_FALL = 0.5;
// One press of the zoom buttons: a quarter of an octave of scale, the wheel's
// step at a notch and a half.
const ZOOM_STEP = Math.pow(2, 0.25);

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
  let gridRects = []; // background rects that follow the viewBox: [major, minor]
  let viewport = { x: 0, y: 0, zoom: 1 }; // world top-left + scale
  let placedSignature = '';               // which nodes, at which sizes, were separated

  /**
   * Where the nodes were before the last Align, or null.
   *
   * One state, never persisted, gone when the page is left. It is the Align
   * button's own counterpart and deliberately NOT a history: ROADMAP item 13 is
   * what will own undo across the application, and a second mechanism with its
   * own rules is what that item exists to avoid. Dragging a node afterwards
   * does not clear it -- Undo Align means "the canvas as it was before I
   * pressed Align", and that includes the drag.
   */
  let alignUndo = null;                   // nodeId -> {x, y}

  let selectedCableId = null;
  // Patch Bay UI selection (never persisted). Several nodes since 2026-09-24:
  // Shift or Ctrl + click adds or removes one, a frame drawn on the canvas takes
  // every node it touches, and a drag moves them all.
  let selectedNodeIds = new Set();
  let lastNodeTap = null;    // { nodeId, at } - pointer-level double-tap detection
  let lastCanvasTap = null; // { at, x, y } - double-click on the empty canvas
  let rightPressCableId = null; // the cable a right press landed on, for its menu
  let suppressContextMenu = false; // suppress menu right after a right-drag pan
  let suppressTimer = null;
  let drag = null; // node drag, cable drag, or pan state
  let rearView = false; // front hides cable runs beneath panels; rear exposes them
  // What the meters and the One Ring's state write into between renders, at
  // up to 10 Hz: the elements themselves, so a reading never redraws a card.
  let live = { output: null, strips: new Map(), rings: new Map() };
  let refreshTimer = null;
  // The cards' meters, animated between the engine's readings (10 Hz):
  // element -> { target, shown, apply }. A reading drawn as it arrives jumped
  // ten times a second and read as lag; this rises with the reading and falls
  // smoothly towards the next one, one frame at a time, and stops when still.
  let meters = new Map();
  let meterFrame = 0;

  // Internal Patch Bay clipboard (temporary app state, never persisted).
  let clipboard = null; // { type, content } serializable snapshot

  // Right-button gesture state (click vs drag disambiguation).
  let rightDown = null; // { clientX, clientY, pointerId }
  let lastPointerClient = null; // last pointer position over the canvas

  // ---------- rendering ----------

  function render() {
    const nodes = buildVisualNodes(hub.network);
    const cables = buildVisualConnections(hub.network);

    // Ensure positions exist for every node (deterministic defaults). The grid
    // is built from the nodes' real boxes: a controller node is as wide as its
    // device, so a cell of a fixed 300 x 220 would put its neighbour inside it.
    const sizes = nodes.map((node) => {
      const geo = nodeGeometry(node, { x: 0, y: 0 });
      return { width: geo.width, height: geo.height };
    });
    nodes.forEach((node, i) => {
      if (!positions.has(node.id)) {
        positions.set(node.id, layout.get(node.id, i, sizes));
      }
    });

    // Positions are persisted, so a canvas laid out when every node was 200 wide
    // still holds those coordinates: the node that grew now sits on its
    // neighbour. Separate them, write the result back, and do it again whenever
    // the set of nodes or their sizes changes -- which is what loading a project
    // or switching to a bigger controller profile does. Keyed on that signature
    // rather than on a "once" flag, so dragging a node never fights the nudge
    // and a new project is not left piled up.
    const signature = nodes.map((node, i) => `${node.id}@${sizes[i].width}x${sizes[i].height}`).join('|');
    if (signature !== placedSignature) {
      placedSignature = signature;
      const moves = separateOverlaps(nodes.map((node, i) => ({
        id: node.id, ...positions.get(node.id), ...sizes[i]
      })), NODE_GAP);
      if (moves.size) {
        for (const [id, pos] of moves) positions.set(id, pos);
        layout.setMany(moves);
      }
    }

    // Prune positions for nodes that no longer exist.
    const ids = new Set(nodes.map((n) => n.id));
    for (const id of [...positions.keys()]) {
      if (!ids.has(id)) positions.delete(id);
    }

    // Clear stale selection/context target if the node disappeared for any
    // reason (deletion elsewhere, network change, etc.).
    for (const id of [...selectedNodeIds]) if (!ids.has(id)) selectedNodeIds.delete(id);

    selectedCableId = null;
    nodeEls.clear();
    cableEls.clear();
    cableHits.clear();
    cablesLayer.innerHTML = '';
    nodesLayer.innerHTML = '';
    live = { output: null, strips: new Map(), rings: new Map() };
    meters = new Map();
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

      // Coloured by what it carries, like the jacks at its two ends; a cable's
      // type is its source port's, which the network already checked matches.
      const path = svgEl('path', { class: `cable type-${portTypeInfo(fromPort.port.type).className}`, d });
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
      if (selectedNodeIds.has(node.id)) g.classList.add('selected');

      const type = getNodeType(node.type);
      if (type) g.classList.add(`node-type-${node.type}`);
      else g.classList.add('node-native'); // native/system node (e.g. MiniLab)
      g.classList.add(`family-${nodeFamily(node.type)}`);

      // A controller node is as wide as its device needs; everything else keeps
      // NODE_WIDTH. Read once here so the panel, the dock, the divider and the
      // output ports cannot disagree about where the right edge is.
      const width = nodeWidth(node);

      // Clip the identity/dock surfaces to the panel outline.
      const clipId = `node-clip-${node.id}`;
      const clip = svgEl('clipPath', { id: clipId });
      clip.appendChild(svgEl('rect', { x: 0, y: 0, width, height, rx: NODE_RADIUS }));
      clipDefs.appendChild(clip);

      // Base panel (fill + border + selection outline).
      g.appendChild(svgEl('rect', { class: 'node-panel', x: 0, y: 0, width, height, rx: NODE_RADIUS }));

      const clipped = svgEl('g', { 'clip-path': `url(#${clipId})` });
      // Upper identity/content surface + lower I/O dock.
      const identityH = IDENTITY_H;
      clipped.appendChild(svgEl('rect', { class: 'node-identity', x: 0, y: 0, width, height: identityH }));
      clipped.appendChild(svgEl('rect', { class: 'node-dock', x: 0, y: identityH, width, height: height - identityH }));
      clipped.appendChild(svgEl('rect', { class: 'node-dock-divider', x: 0, y: identityH, width, height: 1 }));

      const title = svgEl('text', { class: 'node-title', x: 12, y: 23 });
      title.textContent = node.name;
      clipped.appendChild(title);

      // Direct route to the node's own page. Double-click still works, but a
      // visible control is the discoverable one - and it does not depend on
      // the synthesized click that pointer capture retargets during a drag.
      const hasOpen = Boolean(type && hub.modules?.get(node.id));
      if (hasOpen) clipped.appendChild(buildOpenControl(node, width));
      const tag = headerTag(node, type, width, hasOpen);
      if (tag) clipped.appendChild(tag);

      // The readout: what this node holds, on the One Ring's black screen. A
      // Mixer or Morpher draws a strip per input; the output, its device and
      // its two meters.
      if (node.type === 'mixer' || node.type === 'morpher') clipped.appendChild(buildStripsReadout(node, width));
      else if (type) clipped.appendChild(buildReadout(readoutLines(node, type), width, node));
      else if (node.id === AUDIO_OUTPUT_NODE_ID) clipped.appendChild(buildOutputReadout(width));

      g.appendChild(clipped);
      // The family, as the card's top-left corner drawn heavier than its
      // outline and in the family's colour (asked 2026-09-25, in place of a
      // bar across the top). Outside the clip, so the stroke is whole.
      g.appendChild(svgEl('path', {
        class: 'node-corner',
        d: `M 0 ${CORNER_LEG} V ${CORNER_ARC} A ${CORNER_ARC} ${CORNER_ARC} 0 0 1 ${CORNER_ARC} 0 H ${CORNER_LEG}`
      }));

      if (node.surface) {
        const connectedPortIds = new Set(cables
          .filter((cable) => cable.from.nodeId === node.id)
          .map((cable) => cable.from.portId));
        // Both the scale and everything hung under the panel come from the
        // device's own box: a node framed for a MiniLab left a narrower keyboard
        // small in a corner, with the labels below sitting in the empty band.
        const scale = surfaceScale(node.surface);
        const portRowY = surfacePortRowY(node.surface);
        const surfaceHolder = svgEl('g', { transform: `translate(${SURFACE_X} ${SURFACE_Y}) scale(${scale})` });
        appendMiniLabControlSurfaceSvg(surfaceHolder, {
          connectedPortIds,
          box: node.surface,
          // This node's own controls. Left to its default, the drawing would be
          // the first keyboard's, painted inside the second one's box.
          controls: surfaceControlsOfNode(node.id),
          buildPort: (control, x, y) => buildPort(
            { id: control.portId, type: 'control', label: control.label, jack: control.jack },
            'output', x, y, node.id, false
          )
        });
        g.appendChild(surfaceHolder);
        const midi = node.outputs.find((port) => port.id === 'midi-out');
        if (midi) g.appendChild(markPlugged(buildPort(midi, 'output', width, portRowY, node.id), cables));
      }
      // Inputs on the left (I/O dock). A surface node keeps them in one row
      // BELOW the panel -- which is where `nodeGeometry` has always attached
      // their cables, while this line drew them at the dock's first row, in the
      // middle of the drawing. One socket, two positions: the label sat across
      // the pads and the cable met nothing.
      node.inputs.forEach((port, i) => {
        const y = node.surface ? surfacePortRowY(node.surface) : portY(node, i);
        g.appendChild(markPlugged(buildPort(port, 'input', 0, y, node.id), cables));
      });
      // Outputs on the right (I/O dock). A CTRL OUT that sends commands has a
      // jack only where something can send them -- a plugin in the chain that
      // speaks the control connection -- or where a cable already leaves it.
      // Every VST node showing one would offer a cable that does nothing.
      if (!node.surface) node.outputs.forEach((port, i) => {
          if (port.commands && !hub.commands?.sendsCommands(node.id)
              && !cables.some((cable) => cable.from.nodeId === node.id && cable.from.portId === port.id)) return;
          g.appendChild(markPlugged(buildPort(port, 'output', width, portY(node, i), node.id), cables));
        });

      nodesLayer.appendChild(g);
      nodeEls.set(node.id, g);
    });
    renderCount(nodes.length, cables.length);
  }

  function buildOpenControl(node, nodeW) {
    const width = 42;
    const group = svgEl('g', {
      class: 'node-open-control', transform: `translate(${nodeW - 10 - width} 9)`,
      role: 'button', tabindex: '0', 'aria-label': `Open ${node.name}`
    });
    group.dataset.nodeAction = 'open';
    // Drawn by ui/tooltip.js; an SVG <title> is a tooltip Windows draws.
    group.setAttribute('data-tip', `Open ${node.name}`);
    group.appendChild(svgEl('rect', { width, height: 18, rx: 2 }));
    const label = svgEl('text', { x: width / 2, y: 12.5, 'text-anchor': 'middle' });
    label.textContent = 'OPEN';
    group.appendChild(label);
    return group;
  }

  /**
   * The readout on a card: a black screen under the title with at most two
   * lines of what the node holds (`core/nodeSummary.js`). A type with nothing
   * to say shows its family, dimmed, so every card keeps the same anatomy.
   */
  function readoutLines(node, type) {
    const lines = nodeSummaryLines(node.type, hub.nodes?.get(node.id)?.content, {
      ringStatus: hub.oneRing?.statusOf?.(node.id) || null,
      trackCount: hub.sequencer?.model?.state?.tracks?.length
    });
    return lines.length ? lines : [{ text: (type.omniBoxCategory || type.label).toUpperCase(), tone: 'dim', tag: '' }];
  }

  function readoutFrame(width) {
    const g = svgEl('g', { class: 'node-readout', transform: `translate(${READOUT.x} ${READOUT.y})` });
    g.appendChild(svgEl('rect', { class: 'node-readout-screen', width: width - READOUT.x * 2, height: READOUT.h, rx: 2 }));
    return g;
  }

  /**
   * The header's small print, right of the title: what a VST holds, or the
   * family. Only when it fits beside the title and the OPEN chip -- a title is
   * never cut for it. A controller card has none; its drawing says enough.
   */
  function headerTag(node, type, width, hasOpen) {
    let text = '';
    if (node.type === 'vst') {
      const count = hub.nodes?.get(node.id)?.content?.plugins?.length || 0;
      text = count ? `${count} plugin${count === 1 ? '' : 's'}` : 'empty';
    } else if (type) text = type.omniBoxCategory || 'media';
    else if (node.id === AUDIO_OUTPUT_NODE_ID) text = 'system';
    if (!text) return null;
    const right = width - 10 - (hasOpen ? OPEN_W + 8 : 0);
    const titleWidth = 12 + String(node.name || '').length * 7.4;
    const tagWidth = text.length * 6.6;
    if (titleWidth + 10 + tagWidth > right) return null;
    const el = svgEl('text', { class: 'node-tag', x: right, y: 22, 'text-anchor': 'end' });
    el.textContent = text.toUpperCase();
    return el;
  }

  function buildReadout(shown, width, node) {
    const g = readoutFrame(width);
    const top = shown.length === 1 ? READOUT.h / 2 + 4 : READOUT.h / 2 - 4;
    shown.forEach((entry, i) => {
      const y = top + i * READOUT.line;
      let x = 9;
      if (entry.num) {
        const num = svgEl('text', { class: 'node-readout-text tone-dim', x, y });
        num.textContent = entry.num;
        g.appendChild(num);
        x += 13;
      }
      const text = svgEl('text', { class: `node-readout-text tone-${entry.tone}`, x, y });
      let lastPart = text;
      if (entry.segments) {
        entry.segments.forEach((part, index) => {
          const span = svgEl('tspan', { class: `tone-${part.tone}` });
          span.textContent = index ? `  ${part.text}` : part.text;
          text.appendChild(span);
          lastPart = span;
        });
      } else text.textContent = entry.text;
      g.appendChild(text);
      if (entry.tag) {
        const tag = svgEl('text', { class: 'node-readout-tag', x: width - READOUT.x * 2 - 8, y, 'text-anchor': 'end' });
        tag.textContent = entry.tag;
        g.appendChild(tag);
        if (node?.type === 'one-ring') {
          tag.classList.add('ring-state');
          tag.classList.toggle('playing', entry.tag === 'PLAYING');
          // The scene is the line's last part: "SCENE", then its id.
          live.rings.set(node.id, { scene: lastPart, state: tag });
        }
      }
    });
    return g;
  }

  /**
   * A Mixer's or Morpher's readout: a strip per input -- its fader as a mark,
   * what it brings as a meter the engine feeds at 10 Hz (`engine:nodeMeters`)
   * -- and, on the right, the master's gain (Mixer) or the step count (Morpher).
   */
  function buildStripsReadout(node, width) {
    const g = readoutFrame(width);
    const content = hub.nodes?.get(node.id)?.content || {};
    const inputs = Array.isArray(content.inputs) ? content.inputs : [];
    const inner = width - READOUT.x * 2;
    const room = Math.max(1, Math.floor((inner - STRIP.right - 9) / STRIP.pitch));
    const shown = inputs.length > room ? room - 1 : inputs.length;
    const fills = [];
    for (let i = 0; i < shown; i += 1) {
      const input = inputs[i] || {};
      const x = 9 + i * STRIP.pitch;
      g.appendChild(svgEl('rect', { class: 'strip-track', x, y: STRIP.top, width: STRIP.width, height: STRIP.height, rx: 1 }));
      const fill = svgEl('rect', { class: 'strip-fill', x, y: STRIP.top + STRIP.height, width: STRIP.width, height: 0 });
      g.appendChild(fill);
      fills.push(fill);
      if (node.type === 'mixer') {
        const level = Math.max(0, Math.min(2, Number(input.level) || 0));
        const markY = STRIP.top + STRIP.height * (1 - level / 2);
        g.appendChild(svgEl('rect', { class: 'strip-mark', x: x - 1, y: markY - 0.75, width: STRIP.width + 2, height: 1.5 }));
      }
      const label = svgEl('text', { class: `strip-label${input.muted ? ' muted' : ''}`, x: x + STRIP.width / 2, y: STRIP.labelY, 'text-anchor': 'middle' });
      label.textContent = input.muted ? 'M' : String(i + 1);
      g.appendChild(label);
    }
    if (inputs.length > shown) {
      const more = svgEl('text', { class: 'strip-label', x: 9 + shown * STRIP.pitch, y: STRIP.labelY });
      more.textContent = `+${inputs.length - shown}`;
      g.appendChild(more);
    }
    const value = svgEl('text', { class: 'strip-value', x: inner - 8, y: 20, 'text-anchor': 'end' });
    const caption = svgEl('text', { class: 'strip-caption', x: inner - 8, y: 33, 'text-anchor': 'end' });
    if (node.type === 'mixer') {
      value.textContent = gainDb(content.masterLevel ?? 1);
      caption.textContent = 'DB MASTER';
    } else {
      value.textContent = String(Number.isSafeInteger(content.stepCount) ? content.stepCount : 0);
      caption.textContent = 'STEPS';
    }
    g.appendChild(value);
    g.appendChild(caption);
    live.strips.set(node.id, fills);
    return g;
  }

  /** The output's readout: the device, and the master's two meters. */
  function buildOutputReadout(width) {
    const g = readoutFrame(width);
    const inner = width - READOUT.x * 2;
    const [device] = audioOutputLines(hub.engine?.deviceState);
    const name = svgEl('text', { class: `node-readout-text small tone-${device.tone}`, x: 9, y: 13 });
    name.textContent = device.text;
    g.appendChild(name);
    const bars = {};
    [['L', 22], ['R', 32]].forEach(([side, y]) => {
      const label = svgEl('text', { class: 'strip-label', x: 9, y: y + 4 });
      label.textContent = side;
      g.appendChild(label);
      g.appendChild(svgEl('rect', { class: 'strip-track', x: 20, y, width: inner - 28, height: 4, rx: 1 }));
      const fill = svgEl('rect', { class: 'strip-fill', x: 20, y, width: 0, height: 4 });
      g.appendChild(fill);
      bars[side] = fill;
    });
    live.output = { ...bars, span: inner - 28 };
    const meter = hub.engine?.masterMeter;
    if (meter) paintOutput(meter);
    return g;
  }

  function paintLevel(fill, reading) {
    fill.classList.toggle('warn', reading.level === 'warn');
    fill.classList.toggle('hot', reading.level === 'hot');
  }

  /**
   * A node's content moved elsewhere -- a knob on a Mixer's fader, a One Ring's
   * scene from its page -- and its card must say so. Coalesced to one redraw a
   * tenth of a second, and never under a drag, which holds the elements the
   * redraw would replace.
   */
  function scheduleRefresh() {
    if (!container || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!container) return;
      if (drag) scheduleRefresh();
      else render();
    }, 100);
  }

  /**
   * A reading for one meter: shown at once if it is higher, otherwise the
   * meter falls towards it at METER_FALL, animated. Without frames (a hidden
   * window, the tests) it is simply drawn.
   */
  function setMeter(fill, reading, apply) {
    paintLevel(fill, reading);
    let meter = meters.get(fill);
    if (!meter) {
      meter = { target: 0, shown: 0, apply };
      meters.set(fill, meter);
    }
    meter.target = reading.fraction;
    if (reading.fraction >= meter.shown || typeof globalThis.requestAnimationFrame !== 'function') {
      meter.shown = reading.fraction;
      apply(meter.shown);
      return;
    }
    animateMeters();
  }

  function animateMeters() {
    if (meterFrame || !container) return;
    let last = globalThis.performance?.now?.() ?? Date.now();
    const step = (now) => {
      const seconds = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      let moving = false;
      for (const meter of meters.values()) {
        if (meter.shown <= meter.target) continue;
        meter.shown = Math.max(meter.target, meter.shown - METER_FALL * seconds);
        meter.apply(meter.shown);
        moving = true;
      }
      meterFrame = moving && container ? globalThis.requestAnimationFrame(step) : 0;
    };
    meterFrame = globalThis.requestAnimationFrame(step);
  }

  /** `engine:masterMeter`, 10 Hz: the output card's L and R. */
  function paintOutput(meter) {
    if (!live.output) return;
    const { L, R, span } = live.output;
    [[L, meter?.peakLeft], [R, meter?.peakRight]].forEach(([fill, peak]) => {
      setMeter(fill, meterReading(peak), (fraction) => fill.setAttribute('width', (span * fraction).toFixed(1)));
    });
  }

  /** `engine:nodeMeters`, 10 Hz: each strip of each Mixer and Morpher card. */
  function paintStrips(message) {
    for (const entry of Array.isArray(message?.nodes) ? message.nodes : []) {
      const fills = live.strips.get(entry?.nodeId);
      if (!fills) continue;
      fills.forEach((fill, i) => {
        setMeter(fill, meterReading(entry.inputs?.[i]), (fraction) => {
          const height = STRIP.height * fraction;
          fill.setAttribute('height', height.toFixed(1));
          fill.setAttribute('y', (STRIP.top + STRIP.height - height).toFixed(1));
        });
      });
    }
  }

  /** `oneRing:status`: the card's scene and PLAYING / STOPPED, in place. */
  function paintRing({ nodeId, status } = {}) {
    const ring = live.rings.get(nodeId);
    if (!ring) return;
    const id = oneRingSceneId(hub.nodes?.get(nodeId)?.content, status);
    const state = status?.playing ? 'PLAYING' : 'STOPPED';
    if (id && ring.scene.textContent !== `  ${id}`) ring.scene.textContent = `  ${id}`;
    if (ring.state.textContent !== state) ring.state.textContent = state;
    ring.state.classList.toggle('playing', status?.playing === true);
  }

  /** A jack with a cable on it is drawn filled; a free one is hollow. */
  function markPlugged(portEl, cables) {
    const { nodeId, portId, side } = portEl.dataset;
    const plugged = cables.some((cable) => (side === 'input'
      ? cable.to.nodeId === nodeId && cable.to.portId === portId
      : cable.from.nodeId === nodeId && cable.from.portId === portId));
    portEl.classList.toggle('plugged', plugged);
    return portEl;
  }

  /**
   * A control with two functions -- a knob that also pushes -- keeps ONE socket
   * on the panel: the second function's jack is drawn INSIDE the first's rather
   * than beside it (D-049). `ui/miniLabControlSurface.js` decides which is
   * which and puts them on the same point; these are the two sizes that make
   * the pair legible, and the only thing this file knows about the norm.
   *
   * The host is enlarged so that what nests in it is still something a mouse
   * can take hold of, and it stays inside the 26-unit body of the encoder it is
   * drawn on.
   */
  const JACK_SCALE = Object.freeze({ host: 1.6, nested: 0.66 });

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

    const scale = JACK_SCALE[port.jack] ?? 1;
    const unit = (value) => Number((value * scale).toFixed(2));
    const jack = svgEl('g', { class: 'jack' });
    if (info.shape === 'square') {
      jack.appendChild(svgEl('rect', {
        x: unit(-5), y: unit(-5), width: unit(10), height: unit(10), rx: 2
      }));
    } else if (info.shape === 'triangle') {
      jack.appendChild(svgEl('polygon', {
        points: `0,${unit(-6)} ${unit(5.5)},${unit(4)} ${unit(-5.5)},${unit(4)}`
      }));
    } else {
      jack.appendChild(svgEl('circle', { r: unit(5) }));
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
    //
    // A nested jack is the exception: its hit area is its own triangle and no
    // more, so the room around it still belongs to the socket it sits in. It is
    // drawn last, above its host, which is what makes the two grabbable at all
    // -- clicks land on the small one only where the small one is.
    const hit = port.jack === 'nested'
      ? svgEl('rect', { class: 'port-hit', x: -5, y: -5, width: 10, height: 10 })
      : svgEl('rect', {
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
   * `hub.nodes.delete` owns the real teardown (engine chain, network
   * connections, layout, module registration, persistence); this only clears
   * the view state that would otherwise keep pointing at a node that is gone.
   */
  function deleteNode(nodeId) {
    if (!isDeletable(nodeId)) return false;
    hub.nodes.delete(nodeId);
    if (selectedNodeIds.has(nodeId)) setSelection([...selectedNodeIds].filter((id) => id !== nodeId));
    return true;
  }

  /** Select these nodes and only these (Patch Bay UI state only). Selecting a node clears cable selection. */
  function setSelection(ids) {
    selectedNodeIds = new Set(ids);
    if (selectedNodeIds.size) setSelectedCable(null);
    for (const [nodeId, el] of nodeEls) {
      el.classList.toggle('selected', selectedNodeIds.has(nodeId));
    }
  }

  /** Select one node, or none with null. */
  function setSelectedNode(id) {
    setSelection(id ? [id] : []);
  }

  // ---------- clipboard / copy / paste / duplicate ----------

  /** The copyable nodes among `ids`: the controller and the output are not. */
  function copyableIds(ids) {
    return [...ids].filter((id) => isCopyable(id));
  }

  /**
   * What copying these nodes keeps: each one's type and content, and where it
   * sits against the group's top-left corner, so several nodes paste in the
   * arrangement they were copied in. Cables are not copied, not even between
   * two copied nodes: a paste is new nodes, never new routing.
   */
  function snapshotNodes(ids) {
    const found = copyableIds(ids)
      .map((id) => ({ instance: hub.nodes.get(id), pos: positions.get(id) || layout.get(id, 0) }))
      .filter((entry) => entry.instance);
    if (!found.length) return null;
    const origin = {
      x: Math.min(...found.map((entry) => entry.pos.x)),
      y: Math.min(...found.map((entry) => entry.pos.y))
    };
    return {
      origin,
      items: found.map(({ instance, pos }) => ({
        type: instance.type,
        content: instance.content ? JSON.parse(JSON.stringify(instance.content)) : null,
        dx: pos.x - origin.x,
        dy: pos.y - origin.y
      }))
    };
  }

  /** Copy nodes into the internal clipboard. Returns whether anything was copied. */
  function copyNodes(ids) {
    const snapshot = snapshotNodes(ids);
    if (snapshot) clipboard = snapshot;
    return Boolean(snapshot);
  }

  /**
   * New, independent nodes from a snapshot, the group's corner at `worldPos`,
   * and those nodes selected. The first node is nudged off anything it would
   * cover, and the group moves with it.
   */
  function pasteSnapshot(snapshot, worldPos) {
    if (!snapshot?.items?.length) return [];
    const [first] = snapshot.items;
    const wanted = { x: worldPos.x + first.dx, y: worldPos.y + first.dy };
    const landed = resolveNodePos(first.type, wanted);
    const shift = { x: landed.x - wanted.x, y: landed.y - wanted.y };
    const made = new Map();
    for (const item of snapshot.items) {
      const instance = hub.nodes.createFromSnapshot({ type: item.type, content: item.content });
      if (!instance) continue;
      const pos = { x: worldPos.x + item.dx + shift.x, y: worldPos.y + item.dy + shift.y };
      positions.set(instance.id, pos);
      made.set(instance.id, pos);
    }
    if (!made.size) return [];
    layout.setMany(made);
    setSelection([...made.keys()]);
    render();
    return [...made.keys()];
  }

  /** Paste the clipboard at a world position. */
  function pasteNode(worldPos) {
    return pasteSnapshot(clipboard, worldPos);
  }

  /**
   * Duplicate: a copy beside the original, in one gesture, and the clipboard
   * left as it was -- what Ctrl+D does in the Sequencer and the Clip Editor.
   */
  function duplicateNodes(ids) {
    const snapshot = snapshotNodes(ids);
    if (!snapshot) return [];
    return pasteSnapshot(snapshot, { x: snapshot.origin.x + GRID_SIZE * 2, y: snapshot.origin.y + GRID_SIZE * 2 });
  }

  /** Create a new empty dynamic node of a type at a world position. */
  function createNodeAt(typeId, worldPos) {
    const instance = hub.nodes.create(typeId);
    if (!instance) return null;
    placeNode(instance, resolveNodePos(typeId, worldPos));
    return instance;
  }

  /**
   * A VST node with this plugin already in it: what a search for a plugin's
   * name ends in. The plugin goes in the way the node page's "+ Add VST" puts
   * it in (`appendPlugin`), so the page finds it loading like any other.
   */
  function createPluginNodeAt(pluginId, worldPos) {
    const instance = createNodeAt('vst', worldPos);
    if (!instance) return null;
    hub.nodes.appendPlugin(instance.id, pluginId);
    return instance;
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
    const nodes = buildVisualNodes(hub.network);
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

  // ---------- context menus ----------
  //
  // Built on ui/contextMenu.js since 2026-09-25, when the author found the
  // hand-built ones unergonomic: adding a node took three hover submenus
  // (OmniBox > family > type), a node offered Copy and Delete only, and a cable
  // had no menu. What node editors do instead: one flat list of the node types
  // under their families, narrowed by typing, on a right-click or a
  // double-click of the empty canvas; on a node, what can be done to it -- or
  // to the whole selection it belongs to; on a cable, unplugging it.

  function nodeName(nodeId) {
    return hub.nodes?.get(nodeId)?.name || hub.network.getNode?.(nodeId)?.name || nodeId;
  }

  /** The first plugin of a VST node, when it is loaded and its window can open. */
  function readyPrimaryPlugin(nodeId) {
    if (hub.nodes?.get(nodeId)?.type !== 'vst') return null;
    const primary = hub.nodes.getChain(nodeId)?.plugins?.[0];
    return primary && hub.engine.getInstanceStatus(nodeId, primary.id) === 'ready' ? primary : null;
  }

  /**
   * What a right-click on a node acts on: the selection when that node is in
   * it, otherwise that node alone -- which it selects, as a file manager or a
   * DAW does, so the menu never acts on something that is not highlighted.
   */
  function menuTargets(nodeId) {
    if (!selectedNodeIds.has(nodeId)) setSelectedNode(nodeId);
    return [...selectedNodeIds];
  }

  function deleteNodes(ids) {
    let deleted = false;
    for (const id of ids) deleted = deleteNode(id) || deleted;
    return deleted;
  }

  /** Unplug every cable into or out of these nodes. One undo step, like a delete. */
  function disconnectNodes(ids) {
    const set = new Set(ids);
    const cables = buildVisualConnections(hub.network)
      .filter((cable) => set.has(cable.from.nodeId) || set.has(cable.to.nodeId));
    for (const cable of cables) deleteConnection(hub.network, cable);
    return cables.length;
  }

  function openNodeContextMenu(nodeId, clientX, clientY) {
    const ids = menuTargets(nodeId);
    const several = ids.length > 1;
    const counted = (one, verb) => (several ? `${verb} ${ids.length} Nodes` : one);
    const cabled = hub.network.connections()
      .some((cable) => ids.includes(cable.from.nodeId) || ids.includes(cable.to.nodeId));
    const items = [];
    if (!several) {
      const plugin = readyPrimaryPlugin(nodeId);
      if (plugin) items.push({ label: 'Open Plugin Window', action: () => hub.engine.openEditor(nodeId, plugin.id) });
      if (hub.nodes?.get(nodeId) && hub.modules?.get(nodeId)) {
        items.push({ label: 'Open Page', hint: 'Double-click', action: () => openNodeEditor(nodeId) });
      }
      if (items.length) items.push({ separator: true });
    }
    const copyable = copyableIds(ids).length > 0;
    items.push(
      { label: counted('Duplicate', 'Duplicate'), hint: 'Ctrl+D', disabled: !copyable, action: () => duplicateNodes(ids) },
      { label: counted('Copy', 'Copy'), hint: 'Ctrl+C', disabled: !copyable, action: () => copyNodes(ids) },
      { separator: true },
      { label: 'Disconnect All Cables', disabled: !cabled, action: () => disconnectNodes(ids) },
      { label: counted('Delete Node', 'Delete'), hint: 'Del', danger: true, disabled: !ids.some(isDeletable), action: () => deleteNodes(ids) }
    );
    openContextMenu({ x: clientX, y: clientY, items, className: 'patch-bay-menu' });
  }

  function openCableContextMenu(cableId, clientX, clientY) {
    const cable = buildVisualConnections(hub.network).find((item) => item.id === cableId);
    if (!cable) return false;
    setSelection([]);
    setSelectedCable(cableId);
    openContextMenu({
      x: clientX,
      y: clientY,
      className: 'patch-bay-menu',
      items: [
        { heading: `${nodeName(cable.from.nodeId)} → ${nodeName(cable.to.nodeId)}` },
        { label: 'Disconnect', hint: 'Del', danger: true, action: () => deleteConnection(hub.network, cable) }
      ]
    });
    return true;
  }

  /**
   * The empty canvas: the node types first, since adding one is what the empty
   * canvas is for, then what acts on the whole Patch Bay. Typing narrows the
   * list at once and Enter creates the first match, under the pointer.
   *
   * Typing also finds the installed plugins, asked by the author on 2026-09-25:
   * "Val" offers Valhalla, and taking it places a VST node with Valhalla
   * already loaded. They wait for a search -- fifty plugins are a list to
   * search, not one to read -- and come after the node types, so "mix" still
   * means the Mixer.
   */
  function openCanvasContextMenu(clientX, clientY, place = null) {
    const r = svgRect();
    const world = place || screenToWorld(viewport, { x: clientX - r.left, y: clientY - r.top });
    const items = [];
    for (const category of listOmniBoxCategories()) {
      items.push({ heading: category.label });
      for (const type of category.types) {
        items.push({ label: type.label, keywords: type.id, action: () => createNodeAt(type.id, world) });
      }
    }
    // Video and Image are no OmniBox, and the toolbar's list of every type was
    // their only way in until that list went (D-055). They follow, under Media.
    const media = listNodeTypes().filter((type) => nodeFamily(type.id) === 'media');
    if (media.length) {
      items.push({ heading: 'Media' });
      for (const type of media) {
        items.push({ label: type.label, keywords: type.id, action: () => createNodeAt(type.id, world) });
      }
    }
    const plugins = [...(hub.engine?.plugins || [])]
      .filter((plugin) => plugin?.pluginId && plugin.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (plugins.length) {
      items.push({ heading: 'Installed plugins' });
      for (const plugin of plugins) {
        items.push({
          label: plugin.name,
          hint: plugin.manufacturer || '',
          keywords: ['vst', plugin.manufacturer, plugin.category].filter(Boolean).join(' '),
          searchOnly: true,
          action: () => createPluginNodeAt(plugin.pluginId, world)
        });
      }
    }
    items.push(
      { separator: true },
      { label: 'Paste', hint: 'Ctrl+V', disabled: !clipboard, action: () => pasteNode(world) },
      { label: 'Select All', hint: 'Ctrl+A', disabled: nodeBoxes().length === 0, action: selectAll },
      { separator: true },
      { label: 'Align', keywords: 'layout arrange', action: alignNodes },
      ...(alignUndo ? [{ label: 'Undo Align', action: undoAlign }] : []),
      { label: 'Show All Nodes', keywords: 'reset view fit zoom', action: resetView }
    );
    openContextMenu({ x: clientX, y: clientY, items, search: { placeholder: 'Add a node or a plugin…' }, className: 'patch-bay-menu' });
  }

  function selectAll() {
    setSelection(nodeBoxes().map((box) => box.id));
  }

  /**
   * The field in the top-left corner: the canvas menu, opened under it, with
   * its search already taking keys. A node made from it lands in the middle of
   * the view, since the pointer is on the button, not on the canvas.
   */
  function openAddMenu(e) {
    const box = e?.currentTarget?.getBoundingClientRect?.();
    openCanvasContextMenu(box ? box.left : 0, box ? box.bottom + 4 : 0, viewportCenterWorld());
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
    // Right button: potential context click or pan start on empty canvas.
    if (e.button === 2) {
      const portEl = e.target.closest('.port');
      const nodeEl = e.target.closest('.node');
      // Remembered now: the pointer is captured below, and the `contextmenu`
      // that follows is then aimed at the canvas, not at the cable.
      const cableEl = e.target.closest?.('[data-cable-id]');
      rightPressCableId = cableEl && !cableEl.classList.contains('temp') ? cableEl.dataset.cableId : null;
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

    // Left-drag a connected input endpoint to unplug that cable or move it.
    if (portEl && portEl.dataset.side === 'input') {
      const conns = hub.network.connectionsTo(portEl.dataset.nodeId, portEl.dataset.portId);
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

    // Clicking empty canvas deselects nodes and cables, unless Shift or Ctrl
    // keeps the nodes; dragging on it draws a selection frame.
    if (selectedCableId) setSelectedCable(null);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!additive && selectedNodeIds.size) setSelectedNode(null);
    // A press on a cable is the cable's: its click selects it, or with Ctrl
    // unplugs it (`onCableClick`). A frame would capture the pointer, and the
    // browser would then deliver that click to the canvas instead (2026-09-24).
    if (e.target.closest?.('[data-cable-id]')) return;
    // A second press in the same place, quickly: the node list, as a
    // double-click on the empty canvas opens it in node editors. Counted by
    // hand for the reason `registerNodeTap` gives -- the frame captures the
    // pointer, and the browser's own dblclick then never reaches the canvas.
    const now = Date.now();
    if (!additive && lastCanvasTap && now - lastCanvasTap.at < 400
        && Math.hypot(e.clientX - lastCanvasTap.x, e.clientY - lastCanvasTap.y) <= PAN_THRESHOLD) {
      lastCanvasTap = null;
      e.preventDefault();
      openCanvasContextMenu(e.clientX, e.clientY);
      return;
    }
    lastCanvasTap = { at: now, x: e.clientX, y: e.clientY };
    startMarquee(e, additive);
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
  }

  /**
   * Swallow the context menu Windows sends when the right button comes back up
   * after a pan.
   *
   * Armed on RELEASE, and that is the whole repair. It used to be armed in
   * `startPan` behind an 800 ms safety timer, and every pan a person actually
   * makes lasts longer than that: the flag had already expired by the time
   * they let go, so the menu opened at the end of the movement. The clock was
   * racing the gesture it was meant to protect.
   *
   * Nothing here times the gesture any more. The only thing still timed is the
   * gap between the release and the `contextmenu` that follows it -- the same
   * tick -- and the timer exists solely so that a button released outside the
   * window, where no `contextmenu` ever arrives, cannot swallow the NEXT
   * right-click instead.
   */
  function armContextMenuSuppression() {
    suppressContextMenu = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressContextMenu = false;
      suppressTimer = null;
    }, 300);
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
    armContextMenuSuppression();
  }

  // --- node drag ---

  function startNodeDrag(e, nodeEl) {
    const nodeId = nodeEl.dataset.nodeId;
    // A plain press on a node outside the selection selects it alone; Shift or
    // Ctrl adds it. A press on a node already selected keeps the selection, so
    // the drag carries every selected node -- and, if it turns out to be a
    // click, the release decides (`endNodeDrag`): a plain click narrows the
    // selection to that node, a Shift or Ctrl click takes it out.
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const wasSelected = selectedNodeIds.has(nodeId);
    if (!wasSelected) setSelection(additive ? [...selectedNodeIds, nodeId] : [nodeId]);
    else setSelectedCable(null);
    const pos = positions.get(nodeId);

    drag = {
      kind: 'node',
      nodeId,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
      // Where every node carried along started. The pressed node is the one
      // snapped to the grid; the others keep their distance to it.
      group: [...selectedNodeIds].filter((id) => positions.has(id))
        .map((id) => ({ id, x: positions.get(id).x, y: positions.get(id).y })),
      onClick: !wasSelected ? null : (additive ? 'remove' : 'narrow'),
      additive
    };

    svg.setPointerCapture(e.pointerId);
    for (const { id } of drag.group) nodeEls.get(id)?.classList.add('dragging');
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
    const dx = pos.x - d.origX;
    const dy = pos.y - d.origY;

    for (const start of d.group) {
      const next = { x: start.x + dx, y: start.y + dy };
      positions.set(start.id, next);
      const el = nodeEls.get(start.id);
      if (el) el.setAttribute('transform', `translate(${next.x} ${next.y})`);
    }
    updateCables();
  }

  function endNodeDrag() {
    const d = drag;
    for (const { id } of d.group) nodeEls.get(id)?.classList.remove('dragging');
    drag = null;
    const pos = positions.get(d.nodeId);
    if (pos.x !== d.origX || pos.y !== d.origY) {
      // Persist view state (never routing state), in one write for the group.
      layout.setMany(new Map(d.group.map(({ id }) => [id, positions.get(id)])));
      return;
    }
    if (d.onClick === 'remove') setSelection([...selectedNodeIds].filter((id) => id !== d.nodeId));
    else if (d.onClick === 'narrow') setSelectedNode(d.nodeId);
    if (!d.additive) registerNodeTap(d.nodeId);
  }

  // --- selection frame (left-drag on empty canvas) ---

  function startMarquee(e, additive) {
    drag = {
      kind: 'marquee',
      start: toSvgPoint(e),
      base: additive ? [...selectedNodeIds] : [],
      rect: null
    };
    svg.setPointerCapture(e.pointerId);
  }

  function moveMarquee(e) {
    const d = drag;
    const at = toSvgPoint(e);
    const box = {
      x: Math.min(d.start.x, at.x), y: Math.min(d.start.y, at.y),
      width: Math.abs(at.x - d.start.x), height: Math.abs(at.y - d.start.y)
    };
    // Under a few pixels it is still a click on the canvas.
    if (!d.rect && Math.hypot(box.width, box.height) * viewport.zoom < PAN_THRESHOLD) return;
    if (!d.rect) {
      d.rect = svgEl('rect', { class: 'selection-frame' });
      svg.appendChild(d.rect);
    }
    d.rect.setAttribute('x', box.x);
    d.rect.setAttribute('y', box.y);
    d.rect.setAttribute('width', box.width);
    d.rect.setAttribute('height', box.height);
    setSelection([...d.base, ...framedNodes(nodeBoxes(), box)]);
  }

  function endMarquee() {
    if (drag.rect) drag.rect.remove();
    drag = null;
  }

  // --- cable drag (create connection) ---

  function startCableDrag(e, portEl) {
    const nodeId = portEl.dataset.nodeId;
    const portId = portEl.dataset.portId;
    const node = hub.network.getNode(nodeId);
    const port = node && node.outputs.find((p) => p.id === portId);
    if (!port) return;

    const pos = positions.get(nodeId);
    // The NODE, not a literal rebuilt from three of its fields. A rebuilt node
    // has no `surface`, so `nodeGeometry` took its dock branch and answered for
    // every control port at the card's right edge, stacked -- a cable dragged
    // from a knob left from somewhere under the card, pointing at nothing, with
    // no error anywhere. The drawn socket and the drag have to read the same
    // geometry or they are two routes that must agree and will not.
    const geo = nodeGeometry(node, pos);
    const out = geo.outputs.find((p) => p.port.id === portId);
    if (!out) return;

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
      const result = createConnection(hub.network, {
        nodeId: d.fromNodeId,
        portId: d.fromPortId
      }, {
        nodeId: portEl.dataset.nodeId,
        portId: portEl.dataset.portId
      });
      if (!result.ok) {
        flashReject(portEl, result.reason);
      }
      // On success, network:change re-renders automatically.
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
    const fromNode = hub.network.getNode(connection.from.nodeId);
    if (!fromNode) return;
    const fromPos = positions.get(connection.from.nodeId);
    // Same trap as `startCableDrag`: the surface has to come with the node, or
    // unplugging a cable snaps its live end to the dock instead of leaving it on
    // the knob it actually leaves from.
    const fromGeo = nodeGeometry(fromNode, fromPos);
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

    // Released on empty canvas it is unplugged; on another input it is plugged
    // there instead (asked 2026-09-24: moving a cable meant cutting it and
    // drawing a new one); on its own input or an output it stays where it was.
    if (!portEl) {
      deleteConnection(hub.network, d.connection);
    } else if (portEl.dataset.side === 'input') {
      const result = moveConnectionEnd(hub.network, d.connection, {
        nodeId: portEl.dataset.nodeId, portId: portEl.dataset.portId
      });
      if (!result.ok && result.reason !== 'same-port') flashReject(portEl, result.reason);
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
      const cable = buildVisualConnections(hub.network).find((c) => c.id === cableId);
      if (cable) deleteConnection(hub.network, cable);
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
    // An open menu takes Escape for itself (ui/contextMenu.js), so this one
    // only ever clears the selection.
    if (e.key === 'Escape') {
      if (selectedNodeIds.size && !isEditableTarget(e.target)) setSelectedNode(null);
      return;
    }
    // Never interfere with normal keyboard editing in text controls.
    if (isEditableTarget(e.target)) return;

    const ctrl = e.ctrlKey || e.metaKey;
    // Tab turns the canvas round: the cables drawn over the cards, as behind a
    // rack, and back. It replaced a Rear View button on each controller card
    // (asked 2026-09-25). Only while the focus is on the page or the canvas --
    // a Tab from a field or the header still moves the focus.
    if (e.key === 'Tab' && !ctrl && !e.altKey && !e.shiftKey && ownsKeyboard(e.target)) {
      e.preventDefault();
      toggleViewSide();
      return;
    }
    if (ctrl && (e.key === 'c' || e.key === 'C')) {
      copyNodes(selectedNodeIds);
      e.preventDefault();
      return;
    }
    if (ctrl && (e.key === 'd' || e.key === 'D')) {
      duplicateNodes(selectedNodeIds);
      e.preventDefault();
      return;
    }
    if (ctrl && (e.key === 'a' || e.key === 'A')) {
      selectAll();
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
      const cable = buildVisualConnections(hub.network).find((c) => c.id === selectedCableId);
      if (cable) {
        deleteConnection(hub.network, cable);
        // network:change re-renders and clears selection.
      }
      e.preventDefault();
      return;
    }

    // Native/system nodes are not in hub.nodes, so deleteNode ignores them and
    // they stay selected. Every other selected node goes, in one undo step --
    // the edit history settles after the last write.
    if (deleteNodes([...selectedNodeIds])) e.preventDefault();
  }

  // ---------- helpers ----------

  /** The focus is nowhere in particular, or somewhere on this canvas. */
  function ownsKeyboard(target) {
    if (!target || target === document.body || target === document.documentElement) return true;
    return Boolean(container && typeof container.contains === 'function' && container.contains(target));
  }

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
    const nodes = buildVisualNodes(hub.network);
    const cables = buildVisualConnections(hub.network);
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

  /**
   * Does the biggest node fit on screen at the current zoom?
   *
   * The zoom is remembered across sessions, and it was chosen for the nodes of
   * that session. A node that grows afterwards -- a controller profile with more
   * controls than the last one -- would open half outside the viewport with no
   * hint that panning is what is missing.
   */
  function largestNodeFits() {
    const nodes = buildVisualNodes(hub.network);
    if (!nodes.length) return true;
    const r = svgRect();
    if (!r.width || !r.height) return true;
    return nodes.every((node) => {
      const geo = nodeGeometry(node, { x: 0, y: 0 });
      return geo.width * viewport.zoom <= r.width && geo.height * viewport.zoom <= r.height;
    });
  }

  function fitToNodes() {
    const nodes = buildVisualNodes(hub.network);
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
    // This changes presentation only; hub.network remains the topology authority.
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
    renderViewSideHint();
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
    layout = new NetworkLayout(hub.settings);
    viewportStore = new NetworkViewport(hub.settings);
    const hasPersisted = isPersistedViewport(hub.settings.get('networkViewport'));
    viewport = viewportStore.load();

    // The canvas takes the whole page; what used to be a toolbar row floats in
    // its corners, as in the mockup the author approved (D-055).
    container.innerHTML = `
      <div class="routing-view">
        <div class="routing-canvas">
          <svg class="routing-svg" id="routing-svg"></svg>
          <div class="routing-float routing-top-left">
            <div class="routing-heading" title="Double-click a node to open it · wheel to zoom · right-drag to pan · right-click for a menu · drag an output to an input to connect">
              <span class="routing-title">Patch Bay</span>
              <span id="routing-count" class="routing-count"></span>
            </div>
            <button id="routing-add" class="routing-add" type="button" aria-haspopup="menu" title="Add a node, or a VST with a plugin already in it">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
              <span>Add a node, or type a plugin name</span>
            </button>
          </div>
          <div class="routing-float routing-top-right legend" aria-label="Cable types">
            <span class="legend-item type-midi"><i class="jack-dot square"></i>MIDI</span>
            <span class="legend-item type-audio"><i class="jack-dot circle"></i>Audio</span>
            <span class="legend-item type-control"><i class="jack-dot triangle"></i>Control</span>
          </div>
          <div class="routing-float routing-bottom-left routing-keyhint">
            <kbd>Tab</kbd><span id="routing-side-hint">Rear view</span>
          </div>
          <div class="routing-float routing-bottom-right viewport-controls">
            <button id="routing-align" class="routing-tool" type="button" title="Lay the nodes out along the signal, once">Align</button>
            <button id="routing-unalign" class="routing-tool" type="button" title="Put the nodes back where they were before Align" hidden>Undo Align</button>
            <span class="routing-zoom-group">
              <button id="routing-zoom-out" class="routing-tool" type="button" aria-label="Zoom out" title="Zoom out">−</button>
              <span id="routing-zoom" class="zoom-readout">100%</span>
              <button id="routing-zoom-in" class="routing-tool" type="button" aria-label="Zoom in" title="Zoom in">+</button>
              <button id="routing-reset" class="routing-tool" type="button" title="Show all nodes">Fit</button>
            </span>
          </div>
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

    const resetBtn = container.querySelector('#routing-reset');
    if (resetBtn) resetBtn.addEventListener('click', resetView);

    const alignBtn = container.querySelector('#routing-align');
    if (alignBtn) alignBtn.addEventListener('click', alignNodes);
    const unalignBtn = container.querySelector('#routing-unalign');
    if (unalignBtn) unalignBtn.addEventListener('click', undoAlign);

    const zoomOutBtn = container.querySelector('#routing-zoom-out');
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', zoomOut);
    const zoomInBtn = container.querySelector('#routing-zoom-in');
    if (zoomInBtn) zoomInBtn.addEventListener('click', zoomIn);

    const addBtn = container.querySelector('#routing-add');
    if (addBtn && hub.nodes) addBtn.addEventListener('click', openAddMenu);
    renderViewSideHint();

    applyViewBox();
    updateZoomDisplay();
    // First open with no persisted viewport: fit the existing nodes so the
    // Patch Bay is never empty. A persisted viewport is kept -- unless it cannot
    // show the largest node whole, which is what a saved 250% zoom does the day a
    // controller node is drawn at the width its device needs.
    if (!hasPersisted || !largestNodeFits()) {
      fitToNodes();
    }
    window.addEventListener('resize', applyViewBox);

    subs.push(
      hub.events.on('network:change', onNetworkChange),
      // A plugin that sends commands finished loading, or left: its node's CTRL OUT jack follows.
      hub.events.on('commands:sourcesChanged', () => render()),
      // The output's readout names the device; a new one redraws it.
      hub.events.on('engine:deviceState', () => render()),
      // Readings, written into the cards without redrawing them (D-055).
      hub.events.on('engine:masterMeter', paintOutput),
      hub.events.on('engine:nodeMeters', paintStrips),
      hub.events.on('oneRing:status', paintRing),
      ...['nativeAudio:stateChanged', 'nativeMidi:stateChanged', 'oneRing:contentChanged',
        'audioPlayer:contentChanged', 'sequencer:changed', 'vst:chainChanged'].map((name) => hub.events.on(name, scheduleRefresh)),
      // An undo rewrote `networkLayout` under us. The cache below only fills in
      // positions it is MISSING, so without this the nodes stay where they were
      // and the canvas quietly disagrees with the project.
      hub.events.on('history:applied', () => {
        positions = new Map();
        placedSignature = '';
        alignUndo = null;
        updateAlignControls();
        render();
      }),
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
    applyDetailLevel();
  }

  /**
   * Publish what this zoom is worth drawing: two classes and one size.
   *
   * Here rather than in `render()` because zooming does not rebuild the graph
   * -- the viewBox changes and the same nodes are seen from further away, so
   * the level of detail has to follow the viewport, not the topology.
   *
   * The custom property goes through the CSSOM, like the sequencer's
   * `--seq-beat`: the CSP drops a style ATTRIBUTE, and this is not one.
   */
  function applyDetailLevel() {
    if (!svg) return;
    const detail = nodeDetail(viewport.zoom);
    svg.classList.toggle('zoom-far', detail.far);
    svg.classList.toggle('zoom-mute', detail.mute);
    svg.style.setProperty('--node-title-size', `${detail.titleSize}px`);
    // Pulling back, the fine tile is the first to stop being a grid; at the
    // floor the coarse one goes too and the canvas is plain.
    const [major, minor] = gridRects;
    if (major) major.classList.toggle('off', !gridVisible(GRID_SIZE * 5, viewport.zoom));
    if (minor) minor.classList.toggle('off', !gridVisible(GRID_SIZE, viewport.zoom));
  }

  function updateZoomDisplay() {
    const el = container && container.querySelector('#routing-zoom');
    if (el) el.textContent = `${Math.round(viewport.zoom * 100)}%`;
  }

  /** The zoom buttons: about the middle of the view, as the wheel is about the pointer. */
  function zoomBy(factor) {
    const r = svgRect();
    viewport = zoomAt(viewport, { x: r.width / 2, y: r.height / 2 }, viewport.zoom * factor);
    applyViewBox();
    updateZoomDisplay();
    viewportStore.save(viewport.x, viewport.y, viewport.zoom);
  }
  function zoomIn() { zoomBy(ZOOM_STEP); }
  function zoomOut() { zoomBy(1 / ZOOM_STEP); }

  /** The corner hint says what Tab will do next. */
  function renderViewSideHint() {
    const el = container && container.querySelector('#routing-side-hint');
    if (el) el.textContent = rearView ? 'Front view' : 'Rear view';
  }

  /** "6 nodes · 5 cables", under the page's name. */
  function renderCount(nodeCount, cableCount) {
    const el = container && container.querySelector('#routing-count');
    if (!el) return;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    el.textContent = `${plural(nodeCount, 'node')} · ${plural(cableCount, 'cable')}`;
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
    const cableId = rightPressCableId;
    rightPressCableId = null;
    const nodeEl = e.target.closest('.node');
    if (nodeEl) openNodeContextMenu(nodeEl.dataset.nodeId, e.clientX, e.clientY);
    else if (!cableId || !openCableContextMenu(cableId, e.clientX, e.clientY)) openCanvasContextMenu(e.clientX, e.clientY);
  }

  /**
   * Move nodes to `next` and persist it. Returns whether anything moved.
   *
   * The separation pass in `render()` keys on which nodes are present at which
   * sizes: neither changes here, so it does not re-run and cannot fight the
   * arrangement that was just computed.
   */
  function applyPositions(next) {
    if (next.size === 0) return false;
    let moved = false;
    const all = new Map();
    for (const [id, pos] of next) {
      const before = positions.get(id);
      if (!before || before.x !== pos.x || before.y !== pos.y) moved = true;
      positions.set(id, { x: pos.x, y: pos.y });
      all.set(id, { x: pos.x, y: pos.y });
    }
    // Every node is pinned, including one that was already where it belongs.
    // A node with no stored position falls back to the default grid, and that
    // grid is derived from how many nodes there are and how big they are -- so
    // leaving it unpinned means the arrangement quietly moves the day another
    // node is added.
    layout.setMany(all);
    if (!moved) return false;
    render();
    // Without this the command looks broken whenever the canvas was panned:
    // the nodes go where they belong, off screen, and nothing appears to have
    // happened. Only pan and zoom change here.
    fitToNodes();
    viewportStore.save(viewport.x, viewport.y, viewport.zoom);
    return true;
  }

  function nodeBoxes() {
    return buildVisualNodes(hub.network).map((node) => {
      const geo = nodeGeometry(node, { x: 0, y: 0 });
      const pos = positions.get(node.id) || layout.get(node.id, 0);
      return { id: node.id, x: pos.x, y: pos.y, width: geo.width, height: geo.height };
    });
  }

  function alignNodes() {
    const boxes = nodeBoxes();
    if (boxes.length === 0) return false;
    const edges = hub.network.connections()
      .map((cable) => ({ from: cable.from.nodeId, to: cable.to.nodeId }));
    const before = new Map(boxes.map((box) => [box.id, { x: box.x, y: box.y }]));
    if (!applyPositions(alignPositions(boxes, edges))) return false;
    alignUndo = before;
    updateAlignControls();
    return true;
  }

  function undoAlign() {
    if (!alignUndo) return false;
    const restore = alignUndo;
    alignUndo = null;
    applyPositions(restore);
    updateAlignControls();
    return true;
  }

  function updateAlignControls() {
    const btn = container && container.querySelector('#routing-unalign');
    if (btn) btn.hidden = !alignUndo;
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
    else if (drag.kind === 'marquee') moveMarquee(e);
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
    else if (drag.kind === 'marquee') endMarquee();
  }

  function onNetworkChange() {
    // Network is the source of truth; re-derive the visual model.
    render();
    // Loading a project can bring in a node bigger than anything the remembered
    // zoom was chosen for -- another controller profile, with more controls.
    // Zoom out to what now exists rather than leaving half of it off-screen.
    // Only when it does NOT fit: a fit on every change would undo the user's own
    // zoom each time a cable is drawn.
    if (!largestNodeFits()) {
      fitToNodes();
      viewportStore.save(viewport.x, viewport.y, viewport.zoom);
    }
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
    const alignBtn = container && container.querySelector('#routing-align');
    if (alignBtn) alignBtn.removeEventListener('click', alignNodes);
    const unalignBtn = container && container.querySelector('#routing-unalign');
    if (unalignBtn) unalignBtn.removeEventListener('click', undoAlign);
    const zoomOutBtn = container && container.querySelector('#routing-zoom-out');
    if (zoomOutBtn) zoomOutBtn.removeEventListener('click', zoomOut);
    const zoomInBtn = container && container.querySelector('#routing-zoom-in');
    if (zoomInBtn) zoomInBtn.removeEventListener('click', zoomIn);
    const addBtn = container && container.querySelector('#routing-add');
    if (addBtn) addBtn.removeEventListener('click', openAddMenu);
    window.removeEventListener('keydown', onKeyDown);
    closeContextMenu();
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
    selectedNodeIds = new Set();
    clipboard = null;
    lastCanvasTap = null;
    rightPressCableId = null;
    rightDown = null;
    lastPointerClient = null;
    suppressContextMenu = false;
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
    drag = null;
    alignUndo = null;
    rearView = false;
    live = { output: null, strips: new Map(), rings: new Map() };
    meters = new Map();
    if (meterFrame) globalThis.cancelAnimationFrame?.(meterFrame);
    meterFrame = 0;
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  return {
    id: 'routing',
    name: 'Routing',
    navEntry: { label: 'Routing', icon: 'cable', group: 'node', fixed: true },
    mount,
    unmount,
    setRearView,
    isRearView: () => rearView,
    // The toolbar's Align, Undo Align and Reset View for the agent channel: the
    // functions the buttons call, on the canvas on screen. With the page left
    // there is no canvas to lay out or frame, and null says so.
    align: () => (container ? { moved: alignNodes() } : null),
    undoAlign: () => (container ? { restored: undoAlign() } : null),
    resetView: () => (container ? (resetView(), {}) : null)
  };
}
