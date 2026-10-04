// 2:1 pixel-art isometric projection.
//
//   screenX = originX + (x − y) · halfTile
//   screenY = originY + (x + y) · quarterTile − z · levelHeight
//
// halfTile = tileWidth/2 and quarterTile = tileWidth/4, so every floor edge is
// an exact 2-across-1-down pixel staircase. Points that share a screen pixel lie
// on the view ray direction (1, 1, halfTile/levelHeight): moving along it changes
// neither screen coordinate. With the classic levelHeight = tileWidth/2 that
// direction is (1,1,1) — a true isometric view of geometric cubes.

import type { SceneSettings } from './types';

export interface Projection {
  halfTile: number;
  quarterTile: number;
  levelHeight: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** z component of the view direction (1, 1, viewZ). */
  viewZ: number;
}

export interface ProjectionExtent {
  tileWidthPixels: number;
  levelHeightPixels: number;
  extentX: number; // tiles
  extentY: number; // tiles
  top: number; // levels above z = 0
  bottom: number; // levels below z = 0
  padding: number;
}

export function makeProjection(extent: ProjectionExtent): Projection {
  const halfTile = extent.tileWidthPixels / 2;
  const quarterTile = extent.tileWidthPixels / 4;
  const levelHeight = extent.levelHeightPixels;
  const originX = extent.padding + extent.extentY * halfTile;
  const originY = extent.padding + extent.top * levelHeight;
  const width = Math.ceil(originX + extent.extentX * halfTile + extent.padding);
  const height = Math.ceil(originY + (extent.extentX + extent.extentY) * quarterTile + extent.bottom * levelHeight + extent.padding);
  return { halfTile, quarterTile, levelHeight, originX, originY, width, height, viewZ: halfTile / levelHeight };
}

export function sceneProjection(settings: SceneSettings): Projection {
  return makeProjection({
    tileWidthPixels: settings.tileWidthPixels,
    levelHeightPixels: settings.levelHeightPixels,
    extentX: settings.floorTilesX,
    extentY: settings.floorTilesY,
    top: settings.levelCount,
    bottom: settings.baseThicknessLevels,
    padding: settings.paddingPixels,
  });
}

export function projectPoint(projection: Projection, x: number, y: number, z: number): [number, number] {
  return [
    projection.originX + (x - y) * projection.halfTile,
    projection.originY + (x + y) * projection.quarterTile - z * projection.levelHeight,
  ];
}

/** World point where the screen ray through (screenX, screenY) crosses the horizontal plane at height z. */
export function unprojectToPlane(projection: Projection, screenX: number, screenY: number, z: number): [number, number] {
  const difference = (screenX - projection.originX) / projection.halfTile; // x − y
  const sum = (screenY - projection.originY + z * projection.levelHeight) / projection.quarterTile; // x + y
  return [(sum + difference) / 2, (sum - difference) / 2];
}

/** Ray origin on the z = 0 plane for a screen point; direction is (1, 1, viewZ). */
export function rayOrigin(projection: Projection, screenX: number, screenY: number): [number, number, number] {
  const [x, y] = unprojectToPlane(projection, screenX, screenY, 0);
  return [x, y, 0];
}
