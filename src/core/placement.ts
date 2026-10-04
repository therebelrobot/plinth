// Where does a tap land? Pure functions over render buffers, so they're testable.
//
// Two surfaces:
//   stack — look at what's under the pointer (from the z-buffer). Tap a top
//           face and the new piece sits on it; tap a side face and it goes
//           beside it at that height; tap the floor and it goes on the floor.
//   plane — ignore geometry and project the pointer onto the horizontal plane
//           of the active level. This is how you build an upper floor in
//           mid-air, or place behind something tall.

import { unprojectToPlane, type Projection } from './projection';
import { OWNER_FLOOR, OWNER_NONE, type RenderBuffers } from './render';
import type { SceneObject, SceneSettings } from './types';

export type PlacementSurface = 'stack' | 'plane';

export interface PlacementSize { width: number; depth: number; height: number }

export interface PlacementTarget {
  x: number;
  y: number;
  z: number;
}

function snapRound(value: number, snap: number): number {
  return Math.round(value / snap) * snap;
}

function snapFloor(value: number, snap: number): number {
  return Math.floor(value / snap + 1e-6) * snap;
}

export function clampTarget(target: PlacementTarget, size: PlacementSize, settings: SceneSettings): PlacementTarget {
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
  return {
    x: clamp(target.x, 0, settings.floorTilesX - size.width),
    y: clamp(target.y, 0, settings.floorTilesY - size.depth),
    z: clamp(target.z, 0, settings.levelCount - size.height),
  };
}

/** Footprint anchored so the pointer sits in its middle, on the plane at height z. */
export function targetOnPlane(
  projection: Projection, settings: SceneSettings, screenX: number, screenY: number, z: number, size: PlacementSize,
): PlacementTarget {
  const [worldX, worldY] = unprojectToPlane(projection, screenX, screenY, z);
  return clampTarget({
    x: snapRound(worldX - size.width / 2, settings.snap),
    y: snapRound(worldY - size.depth / 2, settings.snap),
    z,
  }, size, settings);
}

/** Index into buffers for a screen point, or −1 outside the canvas. */
export function pixelIndex(buffers: RenderBuffers, screenX: number, screenY: number): number {
  const x = Math.floor(screenX), y = Math.floor(screenY);
  if (x < 0 || y < 0 || x >= buffers.width || y >= buffers.height) return -1;
  return y * buffers.width + x;
}

/** The object under a screen point (null for floor / nothing). */
export function objectAt(buffers: RenderBuffers, screenX: number, screenY: number): SceneObject | null {
  const index = pixelIndex(buffers, screenX, screenY);
  if (index < 0) return null;
  const owner = buffers.owner[index];
  return owner >= 0 ? buffers.objects[owner] : null;
}

export function placementTarget(
  buffers: RenderBuffers,
  settings: SceneSettings,
  screenX: number,
  screenY: number,
  surface: PlacementSurface,
  activeLevel: number,
  size: PlacementSize,
): PlacementTarget | null {
  const { projection } = buffers;
  if (surface === 'plane') return targetOnPlane(projection, settings, screenX, screenY, activeLevel, size);

  const index = pixelIndex(buffers, screenX, screenY);
  if (index < 0) return null;
  const owner = buffers.owner[index];
  if (owner === OWNER_NONE) return targetOnPlane(projection, settings, screenX, screenY, activeLevel, size);
  if (owner === OWNER_FLOOR) {
    if (buffers.normalZ[index] < 0.9) return null; // the base's side walls aren't a surface to build on
    return targetOnPlane(projection, settings, screenX, screenY, 0, size);
  }

  const object = buffers.objects[owner];
  const t = buffers.depth[index];
  const [baseX, baseY] = unprojectToPlane(projection, screenX, screenY, 0);
  const hitX = baseX + t, hitY = baseY + t, hitZ = t * projection.viewZ;
  const normalX = buffers.normalX[index], normalY = buffers.normalY[index], normalZ = buffers.normalZ[index];
  const snap = settings.snap;
  const magnitudeX = Math.abs(normalX), magnitudeY = Math.abs(normalY), magnitudeZ = Math.abs(normalZ);

  let target: PlacementTarget;
  if (magnitudeZ >= magnitudeX && magnitudeZ >= magnitudeY) {
    // Upward-facing: sit on it. Flat tops give their exact height (so slabs
    // stack at half levels); slopes and curves defer to the object's top.
    const z = normalZ > 0.99 && !buffers.curved[index] ? snapRound(hitZ, 0.125) : object.z + object.height;
    target = { x: snapRound(hitX - size.width / 2, snap), y: snapRound(hitY - size.depth / 2, snap), z };
  } else {
    const z = object.z + snapFloor(hitZ - object.z, snap);
    if (magnitudeX >= magnitudeY) {
      const x = normalX > 0 ? snapRound(hitX, snap) : snapRound(hitX - size.width, snap);
      target = { x, y: snapRound(hitY - size.depth / 2, snap), z };
    } else {
      const y = normalY > 0 ? snapRound(hitY, snap) : snapRound(hitY - size.depth, snap);
      target = { x: snapRound(hitX - size.width / 2, snap), y, z };
    }
  }
  return clampTarget(target, size, settings);
}

/** Is there already an identical piece here? Prevents drag-stamping duplicates. */
export function isOccupiedBySame(objects: SceneObject[], candidate: Omit<SceneObject, 'id'>): boolean {
  const close = (first: number, second: number) => Math.abs(first - second) < 1e-6;
  return objects.some((object) =>
    object.type === candidate.type &&
    close(object.x, candidate.x) && close(object.y, candidate.y) && close(object.z, candidate.z) &&
    close(object.width, candidate.width) && close(object.depth, candidate.depth) && close(object.height, candidate.height),
  );
}
