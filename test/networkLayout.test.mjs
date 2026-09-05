import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridPositions, separateOverlaps, NODE_GAP } from '../src/renderer/js/core/networkLayout.js';

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
