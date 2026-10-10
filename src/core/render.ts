// Scene rasteriser: per-pixel raycast into a z-buffer, then derived passes
// (outline edges, floor grid) computed from the buffers.
//
// Every output pixel is exactly one sample at the pixel centre — no
// antialiasing — so edges come out as the clean 2:1 staircases pixel art wants.

import { analyseAdjacency, analyseWallCorners, pairStride, resolveCombination } from './combinatorics';
import { intersectCanonical, makeHit, prepareShape, type CanonicalShape, type CornerPost } from './geometry';
import { parameterOf } from './primitives';
import { makeProjection, sceneProjection, type Projection } from './projection';
import type { CombinatoricsSet, RenderOptions, SceneObject, SceneSettings } from './types';

export const OWNER_NONE = -1;
export const OWNER_FLOOR = -2;

export interface RenderBuffers {
  projection: Projection;
  width: number;
  height: number;
  /** Ray parameter of the visible surface; larger is nearer the viewer. −∞ = empty. */
  depth: Float32Array;
  /** Index into `objects`, or OWNER_FLOOR / OWNER_NONE. */
  owner: Int32Array;
  normalX: Float32Array;
  normalY: Float32Array;
  normalZ: Float32Array;
  /** n·p of the hit point — identifies which flat plane a pixel lies on. */
  planeOffset: Float32Array;
  curved: Uint8Array;
  outline: Uint8Array;
  grid: Uint8Array;
  /** The objects that were considered, in index order (cutaway-hidden ones included but never drawn). */
  objects: SceneObject[];
  /**
   * Adjacency pairs (`a * stride + b`, both orders) that are "open" against each
   * other because an imported combinatorics set says so. `null` when nothing is
   * imported — the edge pass then falls back to `mergeCoplanarFaces` alone.
   */
  joinPairs: Set<number> | null;
}

interface PreparedObject {
  index: number;
  shape: CanonicalShape;
  object: SceneObject;
  /** Canonical ray direction for this object's rotation. */
  directionX: number;
  directionY: number;
}

function canonicalDirection(rotation: number, dx: number, dy: number): [number, number] {
  switch (rotation) {
    case 1: return [dy, -dx];
    case 2: return [-dx, -dy];
    case 3: return [-dy, dx];
    default: return [dx, dy];
  }
}

function prepare(object: SceneObject, index: number, posts?: CornerPost[]): PreparedObject {
  const swapped = object.rotation % 2 === 1;
  const a = swapped ? object.depth : object.width;
  const b = swapped ? object.width : object.depth;
  const [directionX, directionY] = canonicalDirection(object.rotation, 1, 1);
  return {
    index,
    object,
    shape: prepareShape(object.type, a, b, object.height, parameterOf(object), posts, object.slope ?? 0, object.slopeDirection ?? 1),
    directionX,
    directionY,
  };
}

function allocate(projection: Projection, objects: SceneObject[]): RenderBuffers {
  const size = projection.width * projection.height;
  const depth = new Float32Array(size);
  depth.fill(-Infinity);
  const owner = new Int32Array(size);
  owner.fill(OWNER_NONE);
  return {
    projection,
    width: projection.width,
    height: projection.height,
    depth,
    owner,
    normalX: new Float32Array(size),
    normalY: new Float32Array(size),
    normalZ: new Float32Array(size),
    planeOffset: new Float32Array(size),
    curved: new Uint8Array(size),
    outline: new Uint8Array(size),
    grid: new Uint8Array(size),
    objects,
    joinPairs: null,
  };
}

const hit = makeHit();

/** Raycast one prepared object into the buffers over its screen bounding box. */
function rasterise(buffers: RenderBuffers, prepared: PreparedObject, ownerValue: number): void {
  const { projection } = buffers;
  const { object, shape, directionX, directionY } = prepared;
  const { halfTile, quarterTile, originX, originY, viewZ } = projection;

  // Screen bounds of the object's bounding box.
  const x0 = object.x, x1 = object.x + object.width;
  const y0 = object.y, y1 = object.y + object.depth;
  const z0 = object.z, z1 = object.z + object.height;
  const left = originX + (x0 - y1) * halfTile;
  const right = originX + (x1 - y0) * halfTile;
  const top = originY + (x0 + y0) * quarterTile - z1 * projection.levelHeight;
  const bottom = originY + (x1 + y1) * quarterTile - z0 * projection.levelHeight;
  const startX = Math.max(0, Math.floor(left));
  const endX = Math.min(buffers.width, Math.ceil(right));
  const startY = Math.max(0, Math.floor(top));
  const endY = Math.min(buffers.height, Math.ceil(bottom));

  const rotation = object.rotation;
  const width = object.width, depthTiles = object.depth;

  for (let pixelY = startY; pixelY < endY; pixelY++) {
    const sum = (pixelY + 0.5 - originY) / quarterTile; // x + y on the z = 0 plane
    for (let pixelX = startX; pixelX < endX; pixelX++) {
      const difference = (pixelX + 0.5 - originX) / halfTile; // x − y
      // Ray origin in object-local, un-rotated coordinates.
      const u = (sum + difference) / 2 - x0;
      const v = (sum - difference) / 2 - y0;
      let localX: number, localY: number;
      switch (rotation) {
        case 1: localX = v; localY = width - u; break;
        case 2: localX = width - u; localY = depthTiles - v; break;
        case 3: localX = depthTiles - v; localY = u; break;
        default: localX = u; localY = v;
      }
      if (!intersectCanonical(shape, localX, localY, -z0, directionX, directionY, viewZ, hit)) continue;
      const index = pixelY * buffers.width + pixelX;
      if (hit.t <= buffers.depth[index]) continue;

      // Normal back to world orientation.
      let normalX: number, normalY: number;
      switch (rotation) {
        case 1: normalX = -hit.ny; normalY = hit.nx; break;
        case 2: normalX = -hit.nx; normalY = -hit.ny; break;
        case 3: normalX = hit.ny; normalY = -hit.nx; break;
        default: normalX = hit.nx; normalY = hit.ny;
      }
      const worldX = (sum + difference) / 2 + hit.t;
      const worldY = (sum - difference) / 2 + hit.t;
      const worldZ = hit.t * viewZ;
      buffers.depth[index] = hit.t;
      buffers.owner[index] = ownerValue;
      buffers.normalX[index] = normalX;
      buffers.normalY[index] = normalY;
      buffers.normalZ[index] = hit.nz;
      buffers.planeOffset[index] = normalX * worldX + normalY * worldY + hit.nz * worldZ;
      buffers.curved[index] = hit.curved ? 1 : 0;
    }
  }
}

function floorObject(settings: SceneSettings): SceneObject {
  // A flat floor still needs a sliver of thickness so the top face is a solid.
  const thickness = Math.max(settings.baseThicknessLevels, 1e-4);
  return {
    id: '__floor__',
    type: 'block',
    x: 0,
    y: 0,
    z: -thickness,
    width: settings.floorTilesX,
    depth: settings.floorTilesY,
    height: thickness,
    rotation: 0,
  };
}

function isVisible(object: SceneObject, options: RenderOptions): boolean {
  if (options.hideAboveLevel === null || options.hideAboveLevel === undefined) return true;
  return object.z < options.hideAboveLevel + 1 - 1e-6;
}

/**
 * Render the full scene to buffers. When an imported `combinatorics` set is
 * present, each placed object's in-plane neighbour mask is derived from the
 * scene and its open faces suppress the interior seams between connected pieces.
 * With no set, behaviour is exactly the legacy geometry + `mergeCoplanarFaces`.
 */
export function renderScene(
  settings: SceneSettings,
  objects: SceneObject[],
  options: RenderOptions,
  combinatorics?: CombinatoricsSet,
): RenderBuffers {
  const buffers = allocate(sceneProjection(settings), objects);
  // Feature 4: perpendicular wall corners are derived at render time (no document
  // change) so matching walls merge at the back corner even without an import.
  const wallCorners = options.mergeWallCorners === false ? null : analyseWallCorners(objects);
  // `joinPairs` is a Set of `a * stride + b` keys (both orders) the edge pass
  // consults: imported combinatorics pairs plus the derived wall corner pairs.
  const adjacency = combinatorics ? analyseAdjacency(objects) : null;
  if (adjacency || wallCorners) {
    const merged = new Set<number>();
    if (adjacency && combinatorics) {
      const stride = pairStride(objects.length);
      // Spec §3(b): the imported class table is authoritative. Each object's
      // derived mask is canonicalised and looked up; only when the class is
      // present in the imported set are its faces open, so a set that omits a
      // class suppresses nothing for that class. `iso-8` masks are 8-bit and
      // cannot be derived from the 4-neighbour pass, so that scheme keeps the
      // presence-based behaviour.
      if (combinatorics.scheme === 'iso-8') {
        for (const key of adjacency.pairs) merged.add(key);
      } else {
        const resolved = objects.map((object, index) =>
          resolveCombination(combinatorics, object.type, adjacency.masks[index]));
        for (const key of adjacency.pairs) {
          const a = Math.floor(key / stride);
          const b = key % stride;
          if (resolved[a].combination && resolved[b].combination) merged.add(key);
        }
      }
    }
    if (wallCorners) for (const key of wallCorners.pairs) merged.add(key);
    buffers.joinPairs = merged;
  }
  if (options.showFloor) rasterise(buffers, prepare(floorObject(settings), -1), OWNER_FLOOR);
  objects.forEach((object, index) => {
    const posts = wallCorners?.joins[index]?.map((join) => join.post);
    if (isVisible(object, options)) rasterise(buffers, prepare(object, index, posts), index);
  });
  computeEdges(buffers, options);
  if (options.showFloor && options.showFloorGrid) computeFloorGrid(buffers);
  return buffers;
}

/** Render one primitive alone on a canvas cropped exactly to its bounding box. */
export function renderPrimitive(
  settings: Pick<SceneSettings, 'tileWidthPixels' | 'levelHeightPixels'>,
  object: SceneObject,
  options: RenderOptions,
): RenderBuffers {
  const placed: SceneObject = { ...object, x: 0, y: 0, z: 0 };
  const projection = makeProjection({
    tileWidthPixels: settings.tileWidthPixels,
    levelHeightPixels: settings.levelHeightPixels,
    extentX: placed.width,
    extentY: placed.depth,
    top: placed.height,
    bottom: 0,
    padding: 0,
  });
  const buffers = allocate(projection, [placed]);
  rasterise(buffers, prepare(placed, 0), 0);
  computeEdges(buffers, { ...options, showFloor: false });
  return buffers;
}

// ── Edge pass ───────────────────────────────────────────────────────────────
//
// Two neighbouring pixels form an edge when they belong to different surfaces.
// The line is drawn on the *nearer* pixel only, so every edge is exactly one
// pixel wide and silhouettes sit inside the shape (the pixel-art convention).

function sameFlatSurface(buffers: RenderBuffers, first: number, second: number): boolean {
  if (buffers.curved[first] || buffers.curved[second]) return false;
  const dot =
    buffers.normalX[first] * buffers.normalX[second] +
    buffers.normalY[first] * buffers.normalY[second] +
    buffers.normalZ[first] * buffers.normalZ[second];
  return dot > 0.999 && Math.abs(buffers.planeOffset[first] - buffers.planeOffset[second]) < 1e-3;
}

function isEdge(buffers: RenderBuffers, first: number, second: number, options: RenderOptions): boolean {
  const ownerFirst = buffers.owner[first];
  const ownerSecond = buffers.owner[second];
  if (ownerFirst === OWNER_NONE && ownerSecond === OWNER_NONE) return false;
  if (ownerFirst === OWNER_NONE || ownerSecond === OWNER_NONE) return true;
  if (ownerFirst !== ownerSecond) {
    // Imported combinatorics: an open face meeting its compatible neighbour draws
    // no seam, even when the two faces are perpendicular (Feature 4's join).
    if (buffers.joinPairs) {
      const stride = pairStride(buffers.objects.length);
      if (buffers.joinPairs.has(ownerFirst * stride + ownerSecond)) return false;
    }
    return !(options.mergeCoplanarFaces && sameFlatSurface(buffers, first, second));
  }
  if (options.outlines !== 'all') return false;
  if (buffers.curved[first] && buffers.curved[second]) return false;
  return !sameFlatSurface(buffers, first, second);
}

function computeEdges(buffers: RenderBuffers, options: RenderOptions): void {
  buffers.outline.fill(0);
  if (options.outlines === 'none') return;
  const { width, height, depth } = buffers;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      // Outside the canvas counts as empty, so tightly-cropped sprites keep their silhouette.
      if ((x === 0 || y === 0 || x === width - 1 || y === height - 1) && buffers.owner[index] !== OWNER_NONE) {
        buffers.outline[index] = 1;
      }
      if (x + 1 < width && isEdge(buffers, index, index + 1, options)) {
        buffers.outline[depth[index] >= depth[index + 1] ? index : index + 1] = 1;
      }
      if (y + 1 < height && isEdge(buffers, index, index + width, options)) {
        buffers.outline[depth[index] >= depth[index + width] ? index : index + width] = 1;
      }
    }
  }
}

function computeFloorGrid(buffers: RenderBuffers): void {
  const { width, height, projection } = buffers;
  const cellOf = new Int32Array(width * height).fill(-1);
  const tilesY = 1 << 15;
  for (let y = 0; y < height; y++) {
    const sum = (y + 0.5 - projection.originY) / projection.quarterTile;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (buffers.owner[index] !== OWNER_FLOOR || buffers.normalZ[index] < 0.99) continue;
      const difference = (x + 0.5 - projection.originX) / projection.halfTile;
      const worldX = (sum + difference) / 2 + buffers.depth[index];
      const worldY = (sum - difference) / 2 + buffers.depth[index];
      cellOf[index] = Math.floor(worldX) * tilesY + Math.floor(worldY);
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const cell = cellOf[index];
      if (cell < 0) continue;
      const right = x + 1 < width ? cellOf[index + 1] : -1;
      const below = y + 1 < height ? cellOf[index + width] : -1;
      if ((right >= 0 && right !== cell) || (below >= 0 && below !== cell)) buffers.grid[index] = 1;
    }
  }
}
