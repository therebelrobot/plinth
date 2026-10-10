// Shared data model. Pure TypeScript — no DOM — so the renderer runs in the
// browser and in node tests identically.
//
// World units: one floor tile is 1×1 in x/y, and one level is 1 unit tall in z.
// A 1×1×1 block is therefore a geometric cube; the pixel size of a level
// (levelHeightPixels) only changes how that cube is projected, not its shape.

// Type-only import: `PrimitiveCombinatorics` (the Feature-2 export shape) lives
// with the rest of the combinatorics code. `import type` is erased at build, so
// this does not create a runtime import cycle.
import type { PrimitiveCombinatorics } from './combinatorics';

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
  /**
   * Walls only. 0 = flat top (default); 1 = full run-axis slope (ramp-like).
   * The slope runs along the wall's length (canonical y), never its thickness.
   */
  slope?: number;
  /** Walls only. Which end the slope rises from. Defaults to +1 (low-y end). */
  slopeDirection?: 1 | -1;
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

/**
 * An imported `plinth.combinatorics` v1 document (Feature 2 export), validated
 * on import and attached to the scene so it persists via the whole-document save.
 * `version` is a one-way door: importers reject unknown versions rather than guess.
 */
export interface CombinatoricsSet {
  format: 'plinth.combinatorics';
  version: 1;
  scheme: 'iso-4' | 'iso-8';
  source?: { name?: string; exportedAt?: string };
  primitives: PrimitiveCombinatorics[];
}

/**
 * Feature 7 — an imported rampart palette. `colors` is the resolved, ordered
 * `hexColors` list: shared shadow, then each ramp dark→light, then shared
 * highlight. plinth never regenerates rampart's palette; it only consumes the
 * export.
 */
export interface Palette {
  source: 'rampart';
  name: string;
  /** Ordered: shared shadow, then each ramp dark→light, then shared highlight. */
  colors: string[]; // '#rrggbb'
}

/** Feature 7 — how the palette is applied. Persisted with the document. */
export interface ColorSettings {
  enabled: boolean;
  /** How to choose a ramp per object. */
  assign: 'cycle' | 'byType' | 'byLevel';
  /** How many palette slots form one ramp (excluding shared ends). */
  rampSize?: number;
  /** Outline colour; defaults to the palette's shared shadow. */
  outlineColor?: string;
  /** Floor colour; defaults to the palette's shared shadow. */
  floorColor?: string;
}

export interface SceneDocument {
  version: 1;
  name: string;
  settings: SceneSettings;
  objects: SceneObject[];
  /** Imported connectivity classes used to drive primitive surfaces. Absent = legacy geometry. */
  combinatorics?: CombinatoricsSet;
  /** Feature 7 — imported rampart palette. Absent = greyscale only. */
  palette?: Palette;
  /** Feature 7 — colour enablement and mapping. */
  colorSettings?: ColorSettings;
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
  /**
   * Feature 4: merge perpendicular wall corners — suppress the interior seam and
   * union a mitre post so the two walls read as one solid. Derived at render time
   * (no document change). Defaults to true when omitted.
   */
  mergeWallCorners?: boolean;
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
  mergeWallCorners: true,
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
