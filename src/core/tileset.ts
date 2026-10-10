// Feature 10 — image-based combinatorics, EXPORT half. Pure TypeScript, no DOM:
// the same code runs in the browser and in node tests (PNG encoding is injected).
//
// The tileset enumerates a tile's connectivity under the requester's *open-corner*
// rule: a diagonal neighbour matters only when BOTH flanking orthogonal neighbours
// are ABSENT (an open / concave corner). This is deliberately NOT `blobNormalize`
// (which keeps a diagonal only when both orthogonals are PRESENT). Both rules yield
// 47 classes, but they are different tile sets — the classic rule's corner tiles are
// inner corners; the requester's are outer corners.
//
// Bit order matches `SIDES_8`: N=0, NE=1, E=2, SE=3, S=4, SW=5, W=6, NW=7.

import { analyseAdjacency, pairStride, rotateMask8 } from './combinatorics';
import { composeImage, upscale } from './compose';
import type { TilesetPlacement, TilesetSpriteImage } from './compose';
import { DIRECTIONAL_TYPES } from './primitives';
import { renderPrimitive, type RenderBuffers } from './render';
import type { PrimitiveType, RenderOptions, Rotation, SceneDocument, SceneObject } from './types';
import type { ZipEntry } from './zip';

export const TILESET_SCHEME = 'open-corner-8' as const;
export type TilesetScheme = typeof TILESET_SCHEME;

/** The eight sides, in bit order (bit 0 = N … bit 7 = NW). */
export const TILESET_SIDES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Diagonal bit → the two flanking orthogonal bits whose corner it fills. */
const CORNER_FLANKS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 2], // NE between N and E
  [3, 2, 4], // SE between E and S
  [5, 4, 6], // SW between S and W
  [7, 6, 0], // NW between W and N
];

/** Bits 0,2,4,6 (N, E, S, W) and 1,3,5,7 (NE, SE, SW, NW). */
const ORTHO_MASK = 0b01010101;
const DIAG_MASK = 0b10101010;

/** Opposite diagonal, for propagating a corner connection back to its partner. */
const OPPOSITE_DIAGONAL: Record<number, number> = { 2: 32, 32: 2, 8: 128, 128: 8 };

const TOLERANCE = 1e-3;

/**
 * The open-corner rule: clear every diagonal bit whose corner is NOT open, i.e.
 * keep a diagonal only where both flanking orthogonals are absent.
 * `openCornerNormalize(3)` (N+E, an inner corner) clears NE; `openCornerNormalize(0)`
 * keeps every diagonal (all four corners are open).
 */
export function openCornerNormalize(mask: number): number {
  let m = mask & 0xff;
  for (const [diagonal, a, b] of CORNER_FLANKS) {
    if ((m & (1 << a)) !== 0 || (m & (1 << b)) !== 0) m &= ~(1 << diagonal);
  }
  return m;
}

/** The diagonal side names whose corner is open (both flanking orthogonals absent). */
export function openCorners(mask: number): string[] {
  const names: string[] = [];
  for (const [diagonal, a, b] of CORNER_FLANKS) {
    if ((mask & (1 << a)) === 0 && (mask & (1 << b)) === 0) names.push(TILESET_SIDES[diagonal]);
  }
  return names;
}

export interface TilesetConfig {
  /** `c` + the normalized 8-bit mask as two lowercase hex digits, e.g. `c00`. */
  id: string;
  /** The normalized (open-corner) mask. */
  mask: number;
  /** Orthogonal bits only (0x55-masked). */
  ortho: number;
  /** Diagonal bits only (0xaa-masked). */
  diag: number;
  /** Diagonal side names whose corner is open. */
  openCorners: string[];
}

function enumerateConfigs(): TilesetConfig[] {
  const seen = new Map<number, TilesetConfig>();
  for (let mask = 0; mask < 256; mask++) {
    const normalized = openCornerNormalize(mask);
    if (seen.has(normalized)) continue;
    seen.set(normalized, {
      id: `c${normalized.toString(16).padStart(2, '0')}`,
      mask: normalized,
      ortho: normalized & ORTHO_MASK,
      diag: normalized & DIAG_MASK,
      openCorners: openCorners(normalized),
    });
  }
  return [...seen.values()].sort((a, b) => a.mask - b.mask);
}

/**
 * The 47 distinct open-corner configurations. The fully-empty tile (mask 0) is
 * one of them. A consumer that wants "47 + 1" adds a separate background entry;
 * that is bookkeeping, not mathematics — this enumeration includes the empty tile
 * in the 47.
 */
export const TILESET_CONFIGS: TilesetConfig[] = enumerateConfigs();

/** 47, verified: 1·16 + 4·4 + 4·2 + 2·1 + 4·1 + 1·1. */
export const TILESET_CONFIG_COUNT = TILESET_CONFIGS.length;

/**
 * The numerically smallest of the four quarter-turn rotations of an 8-bit mask.
 * The open-corner rule is rotation-equivariant, so the 47 normalized masks form
 * rotation orbits; this picks each orbit's representative. `rotateMask8` counts
 * eighth turns, so a quarter turn is two steps.
 */
export function canonicalTilesetMask(mask: number): number {
  let smallest = mask & 0xff;
  for (const step of [2, 4, 6]) smallest = Math.min(smallest, rotateMask8(mask, step));
  return smallest;
}

// ── 8-neighbour adjacency ─────────────────────────────────────────────────────

export interface Adjacency8 {
  /** 8-bit neighbour mask per object (index-aligned to the input). */
  masks: number[];
  /** Pair keys `a * stride + b` for every face- or corner-connected pair, both orders. */
  pairs: Set<number>;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < TOLERANCE;
}

/** Same type, same vertical span and the same `parameter` — as `abuttingDirection`. */
function compatible(a: SceneObject, b: SceneObject): boolean {
  return a.type === b.type && near(a.z, b.z) && near(a.height, b.height) &&
    near(a.parameter ?? 0, b.parameter ?? 0);
}

/**
 * The mask bit value from `a` toward `b` when their footprints touch at exactly
 * one corner (share a point within tolerance), else 0: NE=bit1=2, SE=bit3=8,
 * SW=bit5=32, NW=bit7=128.
 */
function cornerDirection(a: SceneObject, b: SceneObject): number {
  if (near(b.x, a.x + a.width) && near(b.y + b.depth, a.y)) return 1 << 1; // NE (bit1)
  if (near(b.x, a.x + a.width) && near(b.y, a.y + a.depth)) return 1 << 3; // SE (bit3)
  if (near(b.x + b.width, a.x) && near(b.y, a.y + a.depth)) return 1 << 5; // SW (bit5)
  if (near(b.x + b.width, a.x) && near(b.y + b.depth, a.y)) return 1 << 7; // NW (bit7)
  return 0;
}

/**
 * Extend `analyseAdjacency` with corner-touching detection. Reuses its
 * face-adjacency masks/pairs, then adds diagonal bits for compatible objects whose
 * footprints meet at a shared corner. Uses the same spatial-hash shape so a large
 * scene stays roughly O(n).
 */
export function analyseAdjacency8(objects: SceneObject[]): Adjacency8 {
  const base = analyseAdjacency(objects);
  // `analyseAdjacency` emits 4-bit masks in iso-4 order (N=1,E=2,S=4,W=8); remap
  // the orthogonals into the 8-bit SIDES_8 layout (N=bit0,E=bit2,S=bit4,W=bit6).
  const masks = base.masks.map((mask) =>
    ((mask & 1) ? 1 : 0) | ((mask & 2) ? 4 : 0) | ((mask & 4) ? 16 : 0) | ((mask & 8) ? 64 : 0));
  const pairs = new Set(base.pairs);
  const stride = pairStride(objects.length);

  const grid = new Map<number, number[]>();
  const cellKey = (cx: number, cy: number): number => cx * 65536 + cy;
  objects.forEach((object, index) => {
    const startX = Math.floor(object.x), endX = Math.floor(object.x + object.width - 1e-9);
    const startY = Math.floor(object.y), endY = Math.floor(object.y + object.depth - 1e-9);
    for (let cx = startX; cx <= endX; cx++) {
      for (let cy = startY; cy <= endY; cy++) {
        const key = cellKey(cx, cy);
        const bucket = grid.get(key);
        if (bucket) bucket.push(index);
        else grid.set(key, [index]);
      }
    }
  });

  const tested = new Set<number>();
  objects.forEach((a, ia) => {
    const lowX = Math.floor(a.x - 1 - TOLERANCE);
    const highX = Math.floor(a.x + a.width + 1 + TOLERANCE);
    const lowY = Math.floor(a.y - 1 - TOLERANCE);
    const highY = Math.floor(a.y + a.depth + 1 + TOLERANCE);
    for (let cx = lowX; cx <= highX; cx++) {
      for (let cy = lowY; cy <= highY; cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const ib of bucket) {
          if (ib === ia) continue;
          const key = ia * stride + ib;
          if (tested.has(key)) continue;
          tested.add(key);
          const b = objects[ib];
          if (!compatible(a, b)) continue;
          const direction = cornerDirection(a, b);
          if (direction === 0) continue;
          masks[ia] |= direction;
          masks[ib] |= OPPOSITE_DIAGONAL[direction];
          pairs.add(ia * stride + ib);
          pairs.add(ib * stride + ia);
        }
      }
    }
  });

  return { masks, pairs };
}

// ── Manifest types ────────────────────────────────────────────────────────────

export interface TilesetSprite {
  /** Zip-relative path, e.g. `tiles/block_1x1x1/c00.png`. */
  file: string;
  /** 1× sprite dimensions (the PNG at `scale` is this × `scale`). */
  width: number;
  height: number;
  /** Screen position of the footprint back corner at ground level, at 1× — the `kit.json` anchor. */
  anchorX: number;
  anchorY: number;
}

export interface TilesetTemplate {
  type: PrimitiveType;
  width: number;
  depth: number;
  height: number;
  rotation: Rotation;
  parameter?: number;
  slope?: number;
  slopeDirection?: 1 | -1;
}

export interface TilesetFace {
  /** Stable, human-readable directory name, e.g. `block_1x1x1`. */
  slug: string;
  type: PrimitiveType;
  template: TilesetTemplate;
  /** Whether the face's look changes with rotation (`DIRECTIONAL_TYPES`). */
  directional: boolean;
  /** Config id → file + geometry. Always the full 47 configs. */
  sprites: Record<string, TilesetSprite>;
}

export interface TilesetManifest {
  format: 'plinth.tileset';
  version: 1;
  generator: 'plinth';
  exportedAt: string;
  scheme: TilesetScheme;
  sides: string[];
  projection: { tileWidthPixels: number; levelHeightPixels: number };
  /** Nearest-neighbour upscale applied to the PNGs; 1 = pixel-exact. */
  scale: number;
  /** The 47, shared across faces. */
  configs: TilesetConfig[];
  faces: TilesetFace[];
}

// ── Manifest validation (mirrors `validateCombinatorics`) ─────────────────────

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'block', 'wall', 'stairs', 'ramp', 'cylinder', 'sphere', 'cone', 'pyramid', 'arch',
]);

export type TilesetWarning = (message: string) => void;

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateConfigEntry(entry: unknown, index: number, validIds: ReadonlySet<string>): TilesetConfig | null {
  if (!entry || typeof entry !== 'object') throw new Error(`invalid tileset config at index ${index}`);
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate.id !== 'string') throw new Error(`invalid tileset config at index ${index}: missing id`);
  if (!validIds.has(candidate.id)) return null; // unknown config id: ignore it (forward-compatible)
  if (!isNumber(candidate.mask) || !isNumber(candidate.ortho) || !isNumber(candidate.diag)) {
    throw new Error(`invalid tileset config ${candidate.id}: bad mask/ortho/diag`);
  }
  return {
    id: candidate.id,
    mask: candidate.mask & 0xff,
    ortho: candidate.ortho & 0xff,
    diag: candidate.diag & 0xff,
    openCorners: Array.isArray(candidate.openCorners)
      ? candidate.openCorners.filter((name): name is string => typeof name === 'string')
      : openCorners(candidate.mask & 0xff),
  };
}

function validateFaceEntry(entry: unknown, index: number, validIds: ReadonlySet<string>, warn?: TilesetWarning): TilesetFace | null {
  if (!entry || typeof entry !== 'object') throw new Error(`invalid tileset face at index ${index}`);
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate.type !== 'string' || !PRIMITIVE_TYPES.has(candidate.type)) {
    warn?.(`tileset face ${index}: unknown primitive type "${String(candidate.type)}", ignored`);
    return null;
  }
  if (typeof candidate.slug !== 'string') throw new Error(`tileset face ${index}: missing slug`);
  const template = candidate.template as Record<string, unknown> | undefined;
  if (!template || typeof template !== 'object' ||
    !isNumber(template.width) || !isNumber(template.depth) || !isNumber(template.height)) {
    throw new Error(`tileset face ${candidate.slug}: bad template`);
  }
  const sprites: Record<string, TilesetSprite> = {};
  const rawSprites = candidate.sprites;
  if (rawSprites && typeof rawSprites === 'object') {
    for (const [id, sprite] of Object.entries(rawSprites as Record<string, unknown>)) {
      if (!validIds.has(id)) { warn?.(`tileset face ${candidate.slug}: unknown config "${id}", ignored`); continue; }
      if (!sprite || typeof sprite !== 'object') throw new Error(`tileset face ${candidate.slug}: bad sprite ${id}`);
      const s = sprite as Record<string, unknown>;
      if (typeof s.file !== 'string') throw new Error(`tileset face ${candidate.slug}: sprite ${id} missing file`);
      sprites[id] = {
        file: s.file,
        width: isNumber(s.width) ? s.width : 0,
        height: isNumber(s.height) ? s.height : 0,
        anchorX: isNumber(s.anchorX) ? s.anchorX : 0,
        anchorY: isNumber(s.anchorY) ? s.anchorY : 0,
      };
    }
  }
  return {
    slug: candidate.slug,
    type: candidate.type as PrimitiveType,
    template: {
      type: candidate.type as PrimitiveType,
      width: template.width,
      depth: template.depth,
      height: template.height,
      rotation: (isNumber(template.rotation) ? template.rotation : 0) as Rotation,
      ...(isNumber(template.parameter) ? { parameter: template.parameter } : {}),
      ...(isNumber(template.slope) ? { slope: template.slope } : {}),
      ...(isNumber(template.slopeDirection) ? { slopeDirection: (template.slopeDirection as 1 | -1) } : {}),
    },
    directional: candidate.directional === true,
    sprites,
  };
}

/**
 * Validate a parsed `plinth.tileset` value. Rejects wrong `format`, unknown
 * `version`/`scheme` and malformed entries. Unknown config ids and primitive types
 * are dropped (with a warning) so a newer exporter's extra entries do not break an
 * older importer.
 */
export function validateTilesetManifest(value: unknown, warn?: TilesetWarning): TilesetManifest {
  if (!value || typeof value !== 'object') throw new Error('not a tileset manifest');
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== 'plinth.tileset') throw new Error('not a plinth.tileset file');
  if (candidate.version !== 1) throw new Error(`unsupported tileset version: ${String(candidate.version)}`);
  if (candidate.scheme !== TILESET_SCHEME) throw new Error(`unknown tileset scheme: ${String(candidate.scheme)}`);
  if (!Array.isArray(candidate.configs)) throw new Error('missing configs[]');
  if (!Array.isArray(candidate.faces)) throw new Error('missing faces[]');

  const validIds = new Set(TILESET_CONFIGS.map((config) => config.id));
  const configs = candidate.configs
    .map((entry, index) => validateConfigEntry(entry, index, validIds))
    .filter((entry): entry is TilesetConfig => entry !== null);
  const faces = candidate.faces
    .map((entry, index) => validateFaceEntry(entry, index, validIds, warn))
    .filter((entry): entry is TilesetFace => entry !== null);

  const projection = (candidate.projection ?? {}) as Record<string, unknown>;
  return {
    format: 'plinth.tileset',
    version: 1,
    generator: 'plinth',
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    scheme: TILESET_SCHEME,
    sides: Array.isArray(candidate.sides)
      ? candidate.sides.filter((name): name is string => typeof name === 'string')
      : [...TILESET_SIDES],
    projection: {
      tileWidthPixels: isNumber(projection.tileWidthPixels) ? projection.tileWidthPixels : 32,
      levelHeightPixels: isNumber(projection.levelHeightPixels) ? projection.levelHeightPixels : 16,
    },
    scale: isNumber(candidate.scale) ? candidate.scale : 1,
    configs,
    faces,
  };
}

/** Parse and validate `plinth.tileset` JSON text. Throws a clear error on bad input. */
export function parseTilesetManifest(text: string, warn?: TilesetWarning): TilesetManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  return validateTilesetManifest(value, warn);
}

// ── Import: resolve each object's sprite ──────────────────────────────────────

/** Decoded sprites per face slug → per config id. */
export type TilesetSpriteSet = Map<string, Map<string, TilesetSpriteImage>>;

/** Template key, matching the exporter's `faceKey` (rotation-independent). */
export function templateKey(template: {
  type: string; width: number; depth: number; height: number;
  parameter?: number; slope?: number; slopeDirection?: 1 | -1;
}): string {
  return [template.type, template.width, template.depth, template.height,
  template.parameter ?? '', template.slope ?? 0, template.slopeDirection ?? 1].join('|');
}

function rotateQuarterClockwise(image: TilesetSpriteImage): TilesetSpriteImage {
  const { width, height, data } = image;
  const outWidth = height;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const target = (x * outWidth + (height - 1 - y)) * 4;
      const source = (y * width + x) * 4;
      out[target] = data[source];
      out[target + 1] = data[source + 1];
      out[target + 2] = data[source + 2];
      out[target + 3] = data[source + 3];
    }
  }
  return { width: outWidth, height: width, data: out };
}

const rotationCache = new WeakMap<TilesetSpriteImage, TilesetSpriteImage[]>();

/** The sprite rotated `turns` quarter-turns clockwise (the exporter emits rotation 0). */
function rotateSprite(image: TilesetSpriteImage, turns: number): TilesetSpriteImage {
  const r = ((turns % 4) + 4) % 4;
  if (r === 0) return image;
  let variants = rotationCache.get(image);
  if (!variants) { variants = [image]; rotationCache.set(image, variants); }
  while (variants.length <= r) variants.push(rotateQuarterClockwise(variants[variants.length - 1]));
  return variants[r];
}

/** Rotate the sprite anchor with the same clockwise mapping (and track the new dims). */
function rotateAnchor(x: number, y: number, width: number, height: number, turns: number): [number, number] {
  let ax = x, ay = y, w = width, h = height;
  for (let i = 0; i < turns; i++) {
    const nextX = h - ay;
    ay = ax;
    ax = nextX;
    const nextW = h;
    h = w;
    w = nextW;
  }
  return [ax, ay];
}

/**
 * Feature 10 — resolve each object's tileset sprite. For every object it finds the
 * matching face by template key, derives the object's 8-neighbour mask, normalizes it
 * with the open-corner rule, looks up that config's sprite, and rotates the sprite for
 * the object's facing (the exporter emits rotation 0). The result is index-aligned to
 * `objects`; `null` means "no sprite — fall back to grey".
 */
export function buildTilesetPlacements(
  objects: SceneObject[],
  manifest: TilesetManifest,
  sprites: TilesetSpriteSet,
): (TilesetPlacement | null)[] {
  if (objects.length === 0 || manifest.faces.length === 0) return objects.map(() => null);
  const facesByKey = new Map<string, TilesetFace>();
  for (const face of manifest.faces) facesByKey.set(templateKey(face.template), face);
  const masks = analyseAdjacency8(objects).masks;
  const scale = manifest.scale > 0 ? manifest.scale : 1;
  const tileWidth = manifest.projection.tileWidthPixels;
  const levelHeight = manifest.projection.levelHeightPixels;

  return objects.map((object, index) => {
    const face = facesByKey.get(templateKey(object));
    if (!face) return null;
    const faceSprites = sprites.get(face.slug);
    if (!faceSprites) return null;
    const configId = `c${openCornerNormalize(masks[index] & 0xff).toString(16).padStart(2, '0')}`;
    const image = faceSprites.get(configId);
    const sprite = face.sprites[configId];
    if (!image || !sprite) return null; // partial tileset: fall back to grey
    const turns = face.directional ? (((object.rotation % 4) + 4) % 4) : 0;
    const [anchorX, anchorY] = rotateAnchor(sprite.anchorX * scale, sprite.anchorY * scale, image.width, image.height, turns);
    return { image: rotateSprite(image, turns), anchorX, anchorY, tileWidth, levelHeight, scale };
  });
}

// ── Export: render the 47 template sprites per face ───────────────────────────

/** Injected PNG encoder: RGBA pixels (already upscaled) → encoded bytes. */
export type TilesetPngEncoder = (rgba: Uint8ClampedArray, width: number, height: number) => Uint8Array | Promise<Uint8Array>;

export interface TilesetBuild {
  manifest: TilesetManifest;
  /** Zip entries: `manifest.json` first, then `tiles/<face>/<config>.png`. */
  entries: ZipEntry[];
  filename: string;
}

export interface TilesetBuildOptions {
  /** Injectable clock so tests can pin `exportedAt`. */
  now?: Date;
}

export function faceKey(object: SceneObject): string {
  return [object.type, object.width, object.depth, object.height,
  object.parameter ?? '', object.slope ?? 0, object.slopeDirection ?? 1].join('|');
}

export function faceSlug(object: SceneObject): string {
  const size = `${object.width}x${object.depth}x${object.height}`.replace(/\./g, 'p');
  const slope = object.slope && object.slope > 0
    ? `_s${String(object.slope).replace('.', 'p')}${object.slopeDirection === -1 ? 'n' : 'p'}`
    : '';
  return `${object.type}_${size}${slope}`;
}

function templateOf(object: SceneObject): TilesetTemplate {
  return {
    type: object.type,
    width: object.width,
    depth: object.depth,
    height: object.height,
    rotation: 0,
    ...(object.parameter !== undefined ? { parameter: object.parameter } : {}),
    ...(object.slope !== undefined ? { slope: object.slope } : {}),
    ...(object.slopeDirection !== undefined ? { slopeDirection: object.slopeDirection } : {}),
  };
}

/** Diagonal bit between two adjacent orthogonal side bits, or null. */
function cornerDiagonal(first: number, second: number): number | null {
  const pair = first < second ? `${first},${second}` : `${second},${first}`;
  switch (pair) {
    case '0,2': return 1; // N,E → NE
    case '2,4': return 3; // E,S → SE
    case '4,6': return 5; // S,W → SW
    case '0,6': return 7; // N,W → NW
    default: return null;
  }
}

/**
 * Return a copy of `buffers.outline` with the outline removed along the config's
 * open edges: an open orthogonal side draws no outline; a corner pixel is cleared
 * when both flanking orthogonals are open (its corner is open) and the diagonal is
 * present, or when exactly one flanking side is open. Interior seams are kept.
 */
export function suppressOpenEdges(buffers: RenderBuffers, mask: number): Uint8Array {
  const { width, height, projection, depth, outline, objects } = buffers;
  const { halfTile, quarterTile, originX, originY } = projection;
  const result = Uint8Array.from(outline);
  if (!objects[0]) return result;
  const x1 = objects[0].width, y1 = objects[0].depth;
  // A tile edge is one world unit; a tolerance well below that separates an edge
  // pixel (one coordinate on its bound) from a corner pixel (two coordinates on
  // their bounds) without the apex region conflating adjacent edges.
  const tolerance = 0.15;
  const isPresent = (bit: number): boolean => (mask & (1 << bit)) !== 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!outline[index]) continue;

      const sum = (y + 0.5 - originY) / quarterTile; // worldX + worldY at z = 0
      const difference = (x + 0.5 - originX) / halfTile; // worldX − worldY
      const t = depth[index];
      const worldX = (sum + difference) / 2 + t;
      const worldY = (sum - difference) / 2 + t;

      const sides: number[] = [];
      if (Math.abs(worldY) < tolerance) sides.push(0); // N (y = 0)
      if (Math.abs(worldX - x1) < tolerance) sides.push(2); // E (x = width)
      if (Math.abs(worldY - y1) < tolerance) sides.push(4); // S (y = depth)
      if (Math.abs(worldX) < tolerance) sides.push(6); // W (x = 0)
      if (sides.length === 0) continue;

      if (sides.length === 1) {
        if (!isPresent(sides[0])) result[index] = 0;
        continue;
      }

      const first = sides[0], second = sides[1];
      const openFirst = !isPresent(first), openSecond = !isPresent(second);
      if (openFirst && openSecond) {
        const diagonal = cornerDiagonal(first, second);
        if (diagonal !== null && isPresent(diagonal)) result[index] = 0;
      } else if (openFirst || openSecond) {
        result[index] = 0;
      }
    }
  }
  return result;
}

/**
 * Render the tileset for the active scene: for each distinct face (primitive
 * template key incl. slope), the 47 open-corner template PNGs (a grey isometric
 * block with open edges un-outlined), packaged with a `manifest.json`. Export is at
 * rotation 0; rotation is applied at import. `encodePng` is injected so the core
 * stays DOM-free (the app passes the canvas encoder).
 */
export async function buildTileset(
  document: SceneDocument,
  options: RenderOptions,
  scale: number,
  encodePng: TilesetPngEncoder,
  buildOptions: TilesetBuildOptions = {},
): Promise<TilesetBuild> {
  const settings = document.settings;

  interface FaceBuild { object: SceneObject; slug: string; template: TilesetTemplate; directional: boolean; buffers: RenderBuffers }
  const faces = new Map<string, FaceBuild>();
  for (const object of document.objects) {
    const key = faceKey(object);
    if (faces.has(key)) continue;
    const placed: SceneObject = {
      id: '__tile__', type: object.type, x: 0, y: 0, z: 0,
      width: object.width, depth: object.depth, height: object.height, rotation: 0,
      parameter: object.parameter, slope: object.slope, slopeDirection: object.slopeDirection,
    };
    faces.set(key, {
      object: placed,
      slug: faceSlug(object),
      template: templateOf(object),
      directional: DIRECTIONAL_TYPES.has(object.type),
      // Render the face once; the 47 configs only differ in their suppressed outline.
      buffers: renderPrimitive(settings, placed, { ...options, showFloor: false }),
    });
  }

  const entries: ZipEntry[] = [];
  const manifestFaces: TilesetFace[] = [];
  for (const face of faces.values()) {
    const { buffers } = face;
    const sprites: Record<string, TilesetSprite> = {};
    for (const config of TILESET_CONFIGS) {
      const withOutline = { ...buffers, outline: suppressOpenEdges(buffers, config.mask) };
      const rgba = composeTilesetImage(withOutline, options, settings);
      const png = await encodePng(
        scale > 1 ? upscale(rgba, buffers.width, buffers.height, scale) : rgba,
        buffers.width * scale,
        buffers.height * scale,
      );
      const file = `tiles/${face.slug}/${config.id}.png`;
      entries.push({ name: file, data: png instanceof Uint8Array ? png : new Uint8Array(png) });
      sprites[config.id] = {
        file,
        width: buffers.width,
        height: buffers.height,
        anchorX: buffers.projection.originX,
        anchorY: buffers.projection.originY,
      };
    }
    manifestFaces.push({
      slug: face.slug,
      type: face.object.type,
      template: face.template,
      directional: face.directional,
      sprites,
    });
  }

  const manifest: TilesetManifest = {
    format: 'plinth.tileset',
    version: 1,
    generator: 'plinth',
    exportedAt: (buildOptions.now ?? new Date()).toISOString(),
    scheme: TILESET_SCHEME,
    sides: [...TILESET_SIDES],
    projection: {
      tileWidthPixels: settings.tileWidthPixels,
      levelHeightPixels: settings.levelHeightPixels,
    },
    scale,
    configs: TILESET_CONFIGS.map((config) => ({
      id: config.id, mask: config.mask, ortho: config.ortho, diag: config.diag, openCorners: config.openCorners,
    })),
    faces: manifestFaces,
  };

  entries.unshift({
    name: 'manifest.json',
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  const filename = `plinth-tileset_${settings.tileWidthPixels}px${scale > 1 ? `@${scale}x` : ''}.zip`;
  return { manifest, entries, filename };
}

// The tileset sprite stays grey (no palette/colour) — it is a drawing template.
function composeTilesetImage(buffers: RenderBuffers, options: RenderOptions, settings: Pick<SceneDocument['settings'], 'levelCount'>): Uint8ClampedArray {
  return composeImage(buffers, { ...options, showFloor: false, background: 'transparent' }, settings);
}
