import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placementTarget } from '../src/core/placement';
import { projectPoint, sceneProjection } from '../src/core/projection';
import { renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS } from '../src/core/types';
import { makeObject } from './sample-scene';

const settings = { ...DEFAULT_SETTINGS, floorTilesX: 6, floorTilesY: 6 };
const unit = { width: 1, depth: 1, height: 1 };

test('tapping the floor places on the floor cell', () => {
  const buffers = renderScene(settings, [], DEFAULT_RENDER_OPTIONS);
  const [x, y] = projectPoint(sceneProjection(settings), 2.5, 3.5, 0);
  assert.deepEqual(placementTarget(buffers, settings, x, y, 'stack', 0, unit), { x: 2, y: 3, z: 0 });
});

test('tapping a top face stacks on it; tapping a slab stacks at half a level', () => {
  const objects = [makeObject('block', 1, 1, 0), makeObject('block', 3, 3, 0, 1, 1, 0.5)];
  const buffers = renderScene(settings, objects, DEFAULT_RENDER_OPTIONS);
  const projection = sceneProjection(settings);
  const [bx, by] = projectPoint(projection, 1.5, 1.5, 1);
  assert.deepEqual(placementTarget(buffers, settings, bx, by, 'stack', 0, unit), { x: 1, y: 1, z: 1 });
  const [sx, sy] = projectPoint(projection, 3.5, 3.5, 0.5);
  assert.deepEqual(placementTarget(buffers, settings, sx, sy, 'stack', 0, unit), { x: 3, y: 3, z: 0.5 });
});

test('tapping a side face places beside it', () => {
  const buffers = renderScene(settings, [makeObject('block', 2, 2, 0, 1, 1, 2)], DEFAULT_RENDER_OPTIONS);
  const projection = sceneProjection(settings);
  // +x face (right side) at height 1.5
  const [rx, ry] = projectPoint(projection, 3, 2.5, 1.5);
  assert.deepEqual(placementTarget(buffers, settings, rx + 1, ry, 'stack', 0, unit), { x: 3, y: 2, z: 1 });
  // +y face (left side) near the floor
  const [lx, ly] = projectPoint(projection, 2.5, 3, 0.5);
  assert.deepEqual(placementTarget(buffers, settings, lx - 1, ly, 'stack', 0, unit), { x: 2, y: 3, z: 0 });
});

test('plane mode ignores geometry and uses the active level', () => {
  const buffers = renderScene(settings, [makeObject('block', 2, 2, 0, 1, 1, 3)], DEFAULT_RENDER_OPTIONS);
  const [x, y] = projectPoint(sceneProjection(settings), 4.5, 1.5, 2);
  assert.deepEqual(placementTarget(buffers, settings, x, y, 'plane', 2, unit), { x: 4, y: 1, z: 2 });
});

test('targets are clamped to the floor and the level headroom', () => {
  const buffers = renderScene(settings, [], DEFAULT_RENDER_OPTIONS);
  const [x, y] = projectPoint(sceneProjection(settings), 5.9, 5.9, 0);
  assert.deepEqual(placementTarget(buffers, settings, x, y, 'plane', 3, { width: 2, depth: 2, height: 2 }), { x: 4, y: 4, z: 2 });
});
