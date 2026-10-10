// Feature 6 — wall slopes (ramp-like slants for walls).
//
// A wall's slope is a single cutting plane on the wall's run axis (canonical y),
// the ramp construction rotated 90°: ramp is (h/a, 0, 1, h), wall slope is
// (0, h/(slope·b), 1, h/slope). Pure-core: no DOM, no network.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intersectCanonical, makeHit, prepareShape } from '../src/core/geometry';
import { placementTarget } from '../src/core/placement';
import { renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, type Rotation, type SceneObject } from '../src/core/types';
import { makeObject } from './sample-scene';

const noFloor = { ...DEFAULT_RENDER_OPTIONS, showFloor: false };

/** Top surface z of a wall at run position `ly`, via a straight-up ray. */
function topZ(shape: ReturnType<typeof prepareShape>, ly: number): number {
  const hit = makeHit();
  const ok = intersectCanonical(shape, 0.1, ly, -1, 0, 0, 1, hit);
  assert.ok(ok, `ray at ly=${ly} should hit the wall`);
  return hit.t - 1; // pz = −1, dz = 1
}

// ── 1. flat wall regression ───────────────────────────────────────────────────

test('a flat wall renders identically with slope absent and slope: 0', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 2, floorTilesY: 6 };
  const absent = makeObject('wall', 0, 0, 0, 1, 4, 2, 0, 0.25);
  const zero: SceneObject = { ...absent, slope: 0 };
  const a = renderScene(settings, [absent], noFloor);
  const b = renderScene(settings, [zero], noFloor);
  assert.deepEqual(a.depth, b.depth);
  assert.deepEqual(a.owner, b.owner);
});

// ── 2. monotonic top edge ─────────────────────────────────────────────────────

test('slope: 1 gives a monotonic top edge along the run', () => {
  const shape = prepareShape('wall', 1, 4, 2, 0.25, undefined, 1, 1);
  let previous = Infinity;
  for (let ly = 0.1; ly < 4; ly += 0.2) {
    const z = topZ(shape, ly);
    assert.ok(z < previous + 1e-9, `top z should not rise: ${previous} → ${z} at ly=${ly}`);
    previous = z;
  }
});

// ── 3. tall end matches a flat wall; short end reaches the base ───────────────

test('slope: 1 reaches the flat wall height at the tall end and the base at the short end', () => {
  const sloped = prepareShape('wall', 1, 4, 2, 0.25, undefined, 1, 1);
  const flat = prepareShape('wall', 1, 4, 2, 0.25);
  assert.ok(Math.abs(topZ(sloped, 0) - topZ(flat, 0)) < 1e-6, 'tall end matches the flat top');
  assert.ok(Math.abs(topZ(sloped, 0) - 2) < 1e-6, 'tall end is full height');
  assert.ok(Math.abs(topZ(sloped, 4) - 0) < 1e-6, 'short end reaches the base');
});

test('slopeDirection: -1 mirrors the slope to the high-y end', () => {
  const shape = prepareShape('wall', 1, 4, 2, 0.25, undefined, 1, -1);
  assert.ok(Math.abs(topZ(shape, 0) - 0) < 1e-6, 'low-y end is the base');
  assert.ok(Math.abs(topZ(shape, 4) - 2) < 1e-6, 'high-y end is full height');
});

// ── 4. rotation orients the slope ─────────────────────────────────────────────

test('rotations 0..3 orient the slope along the expected world axis', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 6, floorTilesY: 6, paddingPixels: 0 };
  // Keep the wall's run length 4 in world space: swap the footprint for odd turns.
  const expectedRight: Record<Rotation, boolean> = { 0: true, 1: true, 2: false, 3: false };
  for (const rotation of [0, 1, 2, 3] as Rotation[]) {
    const swapped = rotation % 2 === 1;
    const object: SceneObject = {
      ...makeObject('wall', 0, 0, 0, swapped ? 4 : 1, swapped ? 1 : 4, 2, rotation, 0.25),
      slope: 1,
    };
    const buffers = renderScene(settings, [object], noFloor);
    let minRow = Infinity, maxRow = -Infinity, minX = Infinity, maxX = -Infinity;
    let minRowXSum = 0, minRowCount = 0;
    for (let y = 0; y < buffers.height; y++) {
      for (let x = 0; x < buffers.width; x++) {
        if (buffers.owner[y * buffers.width + x] < 0) continue;
        if (y < minRow) { minRow = y; minRowXSum = 0; minRowCount = 0; }
        if (y === minRow) { minRowXSum += x; minRowCount++; }
        if (y > maxRow) maxRow = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    assert.ok(minRowCount > 0, `rotation ${rotation} drew nothing`);
    const tallX = minRowXSum / minRowCount;
    const centreX = (minX + maxX) / 2;
    assert.equal(tallX > centreX, expectedRight[rotation], `rotation ${rotation}: tall end on the wrong side`);
  }
});

// ── 5. placement defers to the sloped top ─────────────────────────────────────

test('placing on a sloped top defers to the object top instead of snapping to a face', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 2, floorTilesY: 6 };
  const object: SceneObject = { ...makeObject('wall', 0, 0, 0, 1, 4, 2, 0, 0.25), slope: 1 };
  const buffers = renderScene(settings, [object], noFloor);
  let found = false;
  for (let y = 0; y < buffers.height && !found; y++) {
    for (let x = 0; x < buffers.width; x++) {
      const index = y * buffers.width + x;
      if (buffers.owner[index] !== 0) continue;
      const nz = buffers.normalZ[index];
      if (nz > 0.1 && nz < 0.9) {
        const target = placementTarget(buffers, settings, x + 0.5, y + 0.5, 'stack', 0, { width: 1, depth: 1, height: 1 });
        assert.ok(target, 'a target should be produced on the slope');
        assert.equal(target!.z, object.z + object.height, 'sloped top defers to the object top');
        found = true;
        break;
      }
    }
  }
  assert.ok(found, 'expected a pixel on the sloped top');
});

// ── 6. outline pass: clean staircase, no curved flag ──────────────────────────

test('the slope top edge is a clean staircase with no curved flag', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 2, floorTilesY: 6 };
  const object: SceneObject = { ...makeObject('wall', 0, 0, 0, 1, 4, 2, 0, 0.25), slope: 1 };
  const buffers = renderScene(settings, [object], { ...noFloor, outlines: 'all' });
  assert.equal(buffers.curved.reduce((total, value) => total + value, 0), 0, 'no curved pixels on a sloped wall');
  assert.ok(buffers.outline.reduce((total, value) => total + value, 0) > 0, 'the slope edge is outlined');
});
