import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeImage } from '../src/core/compose';
import { sceneProjection, unprojectToPlane } from '../src/core/projection';
import { OWNER_FLOOR, OWNER_NONE, renderPrimitive, renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, type PrimitiveType } from '../src/core/types';
import { makeObject } from './sample-scene';

const noFloor = { ...DEFAULT_RENDER_OPTIONS, showFloor: false };

test('a 32px cube occupies a 32×32 sprite with classic 2:1 geometry', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), noFloor);
  assert.equal(buffers.width, 32);
  assert.equal(buffers.height, 32);
  // Top row: the diamond tip is exactly two pixels wide, centred.
  const topRow = [...buffers.owner.subarray(0, 32)].map((owner) => (owner === 0 ? 1 : 0)).join('');
  assert.equal(topRow, '0'.repeat(15) + '11' + '0'.repeat(15));
  // Every row of the top diamond grows by 4 pixels (2 per side): the 2:1 staircase.
  const coverage = (row: number) => buffers.owner.subarray(row * 32, row * 32 + 32).filter((owner) => owner === 0).length;
  for (let row = 0; row < 7; row++) assert.equal(coverage(row + 1) - coverage(row), 4, `row ${row}`);
  // Middle rows are fully covered.
  assert.equal(coverage(16), 32);
});

test('the three visible faces of a block read top > left > right in value', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), { ...noFloor, outlines: 'none' });
  const image = composeImage(buffers, { ...noFloor, outlines: 'none' }, DEFAULT_SETTINGS);
  const grey = (x: number, y: number) => image[(y * buffers.width + x) * 4];
  const top = grey(16, 6), left = grey(6, 22), right = grey(26, 22);
  assert.ok(top > left && left > right, `top ${top} left ${left} right ${right}`);
});

test('a nearer object occludes a farther one regardless of list order', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 4, floorTilesY: 4 };
  const far = makeObject('block', 1, 1, 0);
  const near = makeObject('block', 2, 2, 0);
  for (const objects of [[far, near], [near, far]]) {
    const buffers = renderScene(settings, objects, noFloor);
    const projection = sceneProjection(settings);
    // Screen point of the near block's top-back corner area: both blocks overlap here.
    const x = Math.round(projection.originX + (2 - 2) * projection.halfTile);
    const y = Math.round(projection.originY + (2 + 2) * projection.quarterTile - 0.5 * projection.levelHeight);
    const owner = buffers.owner[y * buffers.width + x];
    assert.equal(buffers.objects[owner].id, near.id);
  }
});

test('stacking: a block on level 1 sits exactly one level height above', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 2, floorTilesY: 2, paddingPixels: 0 };
  const lower = renderScene(settings, [makeObject('block', 0, 0, 0)], noFloor);
  const upper = renderScene(settings, [makeObject('block', 0, 0, 1)], noFloor);
  const firstRow = (buffers: typeof lower) => {
    for (let y = 0; y < buffers.height; y++) if (buffers.owner.subarray(y * buffers.width, (y + 1) * buffers.width).some((o) => o >= 0)) return y;
    return -1;
  };
  assert.equal(firstRow(lower) - firstRow(upper), settings.levelHeightPixels);
});

test('every primitive type renders in every rotation', () => {
  const types: PrimitiveType[] = ['block', 'wall', 'stairs', 'ramp', 'cylinder', 'sphere', 'cone', 'pyramid', 'arch'];
  for (const type of types) {
    for (const rotation of [0, 1, 2, 3] as const) {
      const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject(type, 0, 0, 0, 1, 2, 2, rotation, type === 'stairs' ? 4 : 0.25), noFloor);
      const covered = buffers.owner.filter((owner) => owner === 0).length;
      assert.ok(covered > 50, `${type} r${rotation} covered ${covered}`);
    }
  }
});

test('outlines are one pixel wide on the silhouette', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), { ...noFloor, outlines: 'silhouette' });
  // Middle row: outline at the leftmost and rightmost covered pixels only.
  const row = 16;
  const marks = [...buffers.outline.subarray(row * 32, row * 32 + 32)];
  assert.equal(marks[0], 1);
  assert.equal(marks[1], 0);
  assert.equal(marks[31], 1);
  assert.equal(marks[30], 0);
});

test('merged coplanar faces: two adjacent blocks have no seam on top', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 3, floorTilesY: 1 };
  const options = { ...noFloor, outlines: 'all' as const, mergeCoplanarFaces: true };
  const buffers = renderScene(settings, [makeObject('block', 0, 0, 0), makeObject('block', 1, 0, 0)], options);
  const projection = sceneProjection(settings);
  // Sample along the shared edge x = 1 on the top face (z = 1), away from the corners.
  let seams = 0;
  for (let step = 1; step < 8; step++) {
    const y = 0.15 + step * 0.1;
    const sx = Math.floor(projection.originX + (1 - y) * projection.halfTile);
    const sy = Math.floor(projection.originY + (1 + y) * projection.quarterTile - projection.levelHeight);
    seams += buffers.outline[sy * buffers.width + sx];
  }
  assert.equal(seams, 0);
  const separate = renderScene(settings, [makeObject('block', 0, 0, 0), makeObject('block', 1, 0, 0)], { ...options, mergeCoplanarFaces: false });
  assert.ok(separate.outline.reduce((total, value) => total + value, 0) > buffers.outline.reduce((total, value) => total + value, 0));
});

test('floor and cutaway', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 3, floorTilesY: 3 };
  const objects = [makeObject('block', 1, 1, 0), makeObject('block', 1, 1, 2)];
  const all = renderScene(settings, objects, DEFAULT_RENDER_OPTIONS);
  const cut = renderScene(settings, objects, { ...DEFAULT_RENDER_OPTIONS, hideAboveLevel: 0 });
  assert.ok(all.owner.includes(1));
  assert.ok(!cut.owner.includes(1));
  assert.ok(cut.owner.includes(OWNER_FLOOR));
  assert.ok(cut.owner.includes(OWNER_NONE));
  assert.ok(all.grid.includes(1));
});

test('unprojectToPlane inverts the projection', () => {
  const projection = sceneProjection(DEFAULT_SETTINGS);
  const [x, y, z] = [3.25, 1.5, 2];
  const screenX = projection.originX + (x - y) * projection.halfTile;
  const screenY = projection.originY + (x + y) * projection.quarterTile - z * projection.levelHeight;
  const [backX, backY] = unprojectToPlane(projection, screenX, screenY, z);
  assert.ok(Math.abs(backX - x) < 1e-9 && Math.abs(backY - y) < 1e-9);
});
