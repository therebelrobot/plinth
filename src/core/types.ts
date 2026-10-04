// Shared data model. Pure TypeScript — no DOM — so the renderer runs in the
// browser and in node tests identically.
//
// World units: one floor tile is 1×1 in x/y, and one level is 1 unit tall in z.
// A 1×1×1 block is therefore a geometric cube; the pixel size of a level
// (levelHeightPixels) only changes how that cube is projected, not its shape.

export type PrimitiveType =
  | 'block'
  | 'wall'
  | 'stairs'
  | 'ramp'
  | 'cylinder'
  | 'sphere'
  | 'cone'
  | 'pyramid'
  | 'arch';

/** Quarter turns about the vertical axis. */
export type Rotation = 0 | 1 | 2 | 3;

export interface SceneObject {
  id: string;
  type: PrimitiveType;
  /** Footprint origin in tiles (low-x, low-y corner). */
  x: number;
  y: number;
  /** Base elevation in levels. */
  z: number;
  /** Footprint size in tiles along world x / world y (already rotated). */
  width: number;
  depth: number;
  /** Height in levels. */
  height: number;
  rotation: Rotation;
  /** Type-specific: stairs = step count, wall/arch = thickness in tiles. */
  parameter?: number;
}

export interface SceneSettings {
  /** Width of one floor tile diamond in pixels. Tile height is always half (2:1 pixel iso). Multiple of 4. */
  tileWidthPixels: number;
  /** Vertical pixels per level. Half the tile width is the classic pixel-art cube. */
  levelHeightPixels: number;
  /** Floor size in tiles. */
  floorTilesX: number;
  floorTilesY: number;
  /** Levels of headroom above the floor; sets the canvas height. */
  levelCount: number;
  /** Thickness of the floor base below z = 0, in levels (0 = flat plane). */
  baseThicknessLevels: number;
  /** Empty pixels around the scene. */
  paddingPixels: number;
  /** Placement snap in tiles/levels: 1, 0.5 or 0.25. */
  snap: number;
}

export interface SceneDocument {
  version: 1;
  name: string;
  settings: SceneSettings;
  objects: SceneObject[];
}

export type ShadingMode = 'shaded' | 'height' | 'silhouette' | 'blank';
export type OutlineMode = 'none' | 'silhouette' | 'all';
export type BackgroundMode = 'transparent' | 'white' | 'neutral';

export interface RenderOptions {
  shading: ShadingMode;
  /** Number of value bands for 'shaded' mode (3–6). */
  bands: number;
  outlines: OutlineMode;
  /** Suppress outlines between flush, coplanar faces of different objects so stamped blocks read as one mass. */
  mergeCoplanarFaces: boolean;
  showFloor: boolean;
  showFloorGrid: boolean;
  background: BackgroundMode;
  /** Cutaway: when set, objects whose base is above this level are not drawn. */
  hideAboveLevel?: number | null;
}

export const DEFAULT_SETTINGS: SceneSettings = {
  tileWidthPixels: 32,
  levelHeightPixels: 16,
  floorTilesX: 10,
  floorTilesY: 10,
  levelCount: 4,
  baseThicknessLevels: 0.5,
  paddingPixels: 4,
  snap: 1,
};

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  shading: 'shaded',
  bands: 4,
  outlines: 'all',
  mergeCoplanarFaces: true,
  showFloor: true,
  showFloorGrid: true,
  background: 'transparent',
  hideAboveLevel: null,
};

export function newDocument(name = 'Untitled scene'): SceneDocument {
  return { version: 1, name, settings: { ...DEFAULT_SETTINGS }, objects: [] };
}

/** Random id that does not depend on crypto.randomUUID (unavailable over plain HTTP on iPadOS Safari). */
export function makeObjectId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
