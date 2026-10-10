// Feature 4 — wall edge merging at perpendicular corners.
//
// A wall is a thin slab anchored to one edge of its footprint, so two
// perpendicular walls meeting at the back corner overlap in a thickness×thickness
// post and never satisfy `sameFlatSurface` (their vertical faces are
// perpendicular). These tests cover the adjacency-aware edge suppression and the
// mitre post that make the corner merge. Pure-core: no DOM, no network.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyseWallCorners, wallSlabBounds } from '../src/core/combinatorics';
import { intersectCanonical, makeHit, prepareShape } from '../src/core/geometry';
import { renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS } from '../src/core/types';
import { makeObject } from './sample-scene';

const noFloor = { ...DEFAULT_RENDER_OPTIONS, showFloor: false };
const outlineCount = (buffers: ReturnType<typeof renderScene>) =>
  buffers.outline.reduce((total, value) => total + value, 0);

/** An L of two matching walls meeting at the back (low-x/low-y) corner. */
function backCornerL(thicknessA = 0.25, thicknessB = 0.25) {
  return [
    makeObject('wall', 0, 0, 0, 1, 6, 3, 0, thicknessA), // runs along y, slab at low-x
    makeObject('wall', 0, 0, 0, 6, 1, 3, 1, thicknessB), // runs along x, slab at low-y
  ];
}

// ── 1. perpendicular corner ───────────────────────────────────────────────────

test('perpendicular walls merge at the back corner (fewer outline pixels)', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 6, floorTilesY: 6 };
  const objects = backCornerL();
  const options = { ...noFloor, outlines: 'all' as const, mergeCoplanarFaces: true };
  const merged = renderScene(settings, objects, { ...options, mergeWallCorners: true });
  const legacy = renderScene(settings, objects, { ...options, mergeWallCorners: false });
  assert.ok(
    outlineCount(merged) < outlineCount(legacy),
    `merged ${outlineCount(merged)} should be < legacy ${outlineCount(legacy)}`,
  );
});

test('the corner join is derived without an imported combinatorics set', () => {
  const objects = backCornerL();
  const { pairs, joins } = analyseWallCorners(objects);
  assert.equal(pairs.size, 2, 'both pair orders are recorded');
  assert.equal(joins[0].length, 1);
  assert.equal(joins[1].length, 1);
  assert.equal(joins[0][0].neighbour, 1);
  assert.equal(joins[1][0].neighbour, 0);
});

// ── 2. collinear run (regression guard) ───────────────────────────────────────

test('a straight run of walls has no interior seams', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 1, floorTilesY: 4 };
  const objects = [0, 1, 2].map((index) => makeObject('wall', 0, index, 0, 1, 1, 2, 0, 0.25));
  const options = { ...noFloor, outlines: 'all' as const, mergeCoplanarFaces: true };
  const merged = renderScene(settings, objects, { ...options, mergeWallCorners: true });
  const legacy = renderScene(settings, objects, { ...options, mergeWallCorners: false });
  // Parallel walls are not corner joins, so the fix must not change the run.
  assert.equal(outlineCount(merged), outlineCount(legacy));
});

// ── 3. mismatched thickness ───────────────────────────────────────────────────

test('a thick wall meeting a thin wall still merges and keeps a solid top', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 6, floorTilesY: 6 };
  const objects = backCornerL(0.25, 0.5);
  const options = { ...noFloor, outlines: 'all' as const, mergeCoplanarFaces: true };
  const merged = renderScene(settings, objects, { ...options, mergeWallCorners: true });
  const legacy = renderScene(settings, objects, { ...options, mergeWallCorners: false });
  assert.ok(outlineCount(merged) < outlineCount(legacy), 'the corner seam is suppressed');
  // The corner post is solid: no empty pixel inside the union's footprint.
  const projection = merged.projection;
  const sx = Math.floor(projection.originX + (0.125 - 0.125) * projection.halfTile);
  const sy = Math.floor(projection.originY + (0.125 + 0.125) * projection.quarterTile - 3 * projection.levelHeight);
  assert.notEqual(merged.owner[sy * merged.width + sx], -1, 'the corner top is not a hole');
});

// ── 4. no neighbours ──────────────────────────────────────────────────────────

test('a lone wall renders exactly as today', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 3, floorTilesY: 3 };
  const objects = [makeObject('wall', 1, 1, 0, 1, 2, 2, 0, 0.25)];
  const options = { ...noFloor, outlines: 'all' as const };
  const merged = renderScene(settings, objects, { ...options, mergeWallCorners: true });
  const legacy = renderScene(settings, objects, { ...options, mergeWallCorners: false });
  assert.deepEqual(merged.outline, legacy.outline);
  assert.deepEqual(merged.owner, legacy.owner);
});

// ── 5. geometry unit ──────────────────────────────────────────────────────────

test('the wall union includes a corner post beyond the slab', () => {
  const shape = prepareShape('wall', 1, 6, 3, 0.25, [{ x0: 0, x1: 0.25, y0: -0.25, y1: 0 }]);
  const hit = makeHit();
  // Through the post, outside the slab's run (y < 0): only the post can hit.
  // The renderer's ray travels upward (+z), so the far hit is the post's top (z = 3).
  assert.ok(intersectCanonical(shape, 0.125, -0.125, -10, 0, 0, 1, hit));
  assert.ok(Math.abs(hit.t - 13) < 1e-6, `hit.t ${hit.t}`);
  // Without the post the same ray misses.
  const bare = prepareShape('wall', 1, 6, 3, 0.25);
  assert.equal(intersectCanonical(bare, 0.125, -0.125, -10, 0, 0, 1, makeHit()), false);
});

test('analyseWallCorners describes the thickness×thickness post for an L', () => {
  const objects = backCornerL();
  const { joins } = analyseWallCorners(objects);
  const post = joins[0][0].post;
  assert.ok(Math.abs(post.x1 - post.x0 - 0.25) < 1e-9, `post width ${post.x1 - post.x0}`);
  assert.ok(Math.abs(post.y1 - post.y0 - 0.25) < 1e-9, `post depth ${post.y1 - post.y0}`);
});

test('wallSlabBounds anchors the slab to the correct footprint edge per rotation', () => {
  const lowX = wallSlabBounds(makeObject('wall', 0, 0, 0, 1, 6, 3, 0, 0.25));
  assert.deepEqual(lowX, { x0: 0, x1: 0.25, y0: 0, y1: 6 });
  const lowY = wallSlabBounds(makeObject('wall', 0, 0, 0, 6, 1, 3, 1, 0.25));
  assert.deepEqual(lowY, { x0: 0, x1: 6, y0: 0, y1: 0.25 });
  const highX = wallSlabBounds(makeObject('wall', 0, 0, 0, 1, 6, 3, 2, 0.25));
  assert.deepEqual(highX, { x0: 0.75, x1: 1, y0: 0, y1: 6 });
  const highY = wallSlabBounds(makeObject('wall', 0, 0, 0, 6, 1, 3, 3, 0.25));
  assert.deepEqual(highY, { x0: 0, x1: 6, y0: 0.75, y1: 1 });
});
