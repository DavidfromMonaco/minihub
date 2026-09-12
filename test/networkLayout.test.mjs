import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridPositions, separateOverlaps, alignPositions, NODE_GAP } from '../src/renderer/js/core/networkLayout.js';

/*
 * The Patch Bay stopped being able to assume one node size the day a controller
 * node started being drawn at the width its device needs: a BeatStep node is
 * 361 x 262 where the grid reserved 300 x 220 per cell, so it reached into its
 * right-hand neighbour and into the one below, and the canvas opened on a pile.
 */
const box = (id, x, y, width, height) => ({ id, x, y, width, height });
const overlaps = (a, b, gap = 0) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap
  && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

test('the default grid is as wide as what goes in it', () => {
  const sizes = [
    { width: 361, height: 262 },   // a dense controller
    { width: 200, height: 150 },
    { width: 200, height: 150 },
    { width: 200, height: 180 }
  ];
  const at = gridPositions(sizes);
  const rects = at.map((pos, i) => box(`n${i}`, pos.x, pos.y, sizes[i].width, sizes[i].height));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      assert.equal(overlaps(rects[i], rects[j]), false, `${rects[i].id} and ${rects[j].id} overlap`);
    }
  }
  assert.equal(at[1].x, 80 + 361 + NODE_GAP, 'the widest node in a column sets that column');
  assert.equal(at[3].y, 80 + 262 + NODE_GAP, 'the tallest in a row sets that row');
});

test('positions saved for smaller nodes are separated, not left piled up', () => {
  // The canvas as it was persisted when every node was 200 wide.
  const rects = [
    box('controller', 80, 80, 361, 262),
    box('vst', 380, 80, 200, 150),
    box('audio', 80, 300, 200, 150)
  ];
  const moves = separateOverlaps(rects, NODE_GAP);
  assert.equal(moves.has('controller'), false, 'the node that was there first does not move');
  const after = rects.map((rect) => (moves.has(rect.id) ? { ...rect, ...moves.get(rect.id) } : rect));
  for (let i = 0; i < after.length; i += 1) {
    for (let j = i + 1; j < after.length; j += 1) {
      assert.equal(overlaps(after[i], after[j]), false, `${after[i].id} still sits on ${after[j].id}`);
    }
  }
});

test('separating a canvas that is already clear moves nothing', () => {
  const rects = [box('a', 0, 0, 200, 150), box('b', 260, 0, 200, 150)];
  assert.equal(separateOverlaps(rects, NODE_GAP).size, 0,
    'a nudge recomputed at every open would fight the user dragging a node');
});

// ---- Align: a command, and what "aligned" means -------------------------------

/*
 * ROADMAP item 12. `Align` is not the automatic layout INTENT section 6
 * refuses: it runs when it is pressed and never on its own. What it owes is a
 * drawing that follows the signal -- controller, then processing, then Audio
 * Output -- because insertion order says nothing about where the sound goes.
 */
const edge = (from, to) => ({ from, to });
const columnOf = (at, id) => at.get(id).x;

test('columns follow the signal, not the order the nodes were created in', () => {
  const boxes = [
    box('audio-output', 0, 0, 200, 150),
    box('vst', 0, 0, 200, 150),
    box('minilab-3', 0, 0, 361, 262)
  ];
  const at = alignPositions(boxes, [
    edge('minilab-3', 'vst'),
    edge('vst', 'audio-output')
  ]);

  assert.ok(columnOf(at, 'minilab-3') < columnOf(at, 'vst'),
    'the controller opens the graph even though it was added last');
  assert.ok(columnOf(at, 'vst') < columnOf(at, 'audio-output'),
    'and the output closes it');
  assert.equal(columnOf(at, 'vst'), 80 + 361 + NODE_GAP,
    'a column is as wide as the widest node in it');
});

test('a node is placed by its longest path, so no cable is drawn backwards', () => {
  // The controller also reaches the output directly. Ranking by the shortest
  // path would seat the output beside the VST, with the VST's cable pointing
  // back at it.
  const at = alignPositions([
    box('minilab-3', 0, 0, 200, 150),
    box('vst', 0, 0, 200, 150),
    box('audio-output', 0, 0, 200, 150)
  ], [
    edge('minilab-3', 'vst'),
    edge('vst', 'audio-output'),
    edge('minilab-3', 'audio-output')
  ]);

  assert.ok(columnOf(at, 'audio-output') > columnOf(at, 'vst'));
});

test('nodes sharing a column keep the vertical order they already had', () => {
  const at = alignPositions([
    box('minilab-3', 0, 0, 361, 262),
    box('vst-b', 900, 400, 200, 150),
    box('vst-a', 500, 90, 200, 150)
  ], [
    edge('minilab-3', 'vst-a'),
    edge('minilab-3', 'vst-b')
  ]);

  assert.equal(columnOf(at, 'vst-a'), columnOf(at, 'vst-b'), 'both are one hop from the controller');
  assert.ok(at.get('vst-a').y < at.get('vst-b').y,
    'the one that was higher stays higher -- you have to recognise your own patch');
  assert.equal(at.get('vst-b').y, 80 + 150 + NODE_GAP, 'and they are stacked, not piled');
});

test('aligning an already aligned canvas changes nothing', () => {
  const boxes = [
    box('minilab-3', 0, 0, 361, 262),
    box('vst', 0, 0, 200, 150),
    box('audio-output', 0, 0, 200, 150)
  ];
  const edges = [edge('minilab-3', 'vst'), edge('vst', 'audio-output')];
  const first = alignPositions(boxes, edges);
  const second = alignPositions(
    boxes.map((item) => ({ ...item, ...first.get(item.id) })), edges
  );

  for (const id of first.keys()) assert.deepEqual(second.get(id), first.get(id));
});

test('the result never overlaps, whatever the node sizes', () => {
  const boxes = [
    box('minilab-3', 0, 0, 361, 262),
    box('beatstep', 0, 0, 420, 300),
    box('vst', 0, 0, 200, 150),
    box('arp', 0, 0, 260, 220),
    box('audio-output', 0, 0, 200, 150)
  ];
  const at = alignPositions(boxes, [
    edge('minilab-3', 'arp'), edge('beatstep', 'vst'),
    edge('arp', 'vst'), edge('vst', 'audio-output')
  ]);
  const rects = boxes.map((item) => ({ ...item, ...at.get(item.id) }));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      assert.equal(overlaps(rects[i], rects[j]), false, `${rects[i].id} and ${rects[j].id} overlap`);
    }
  }
});

test('a cycle across two cable types terminates instead of ranking forever', () => {
  // Cycles are refused per type (network.js), so MIDI one way and audio the
  // other is reachable. The relaxation is bounded by the node count.
  const at = alignPositions([
    box('a', 0, 0, 200, 150),
    box('b', 0, 0, 200, 150)
  ], [edge('a', 'b'), edge('b', 'a')]);

  assert.equal(at.size, 2);
  for (const pos of at.values()) {
    assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
  }
});

test('a cable to a node that is not on the canvas is ignored', () => {
  const at = alignPositions([box('vst', 0, 0, 200, 150)], [edge('ghost', 'vst'), edge('vst', 'ghost')]);
  assert.deepEqual(at.get('vst'), { x: 80, y: 80 });
});
