// Combinatorics export: the connectivity classes of a primitive tile,
// enumerated as center / edge / corner (plus the degenerate single / end / tee).
//
// A tile's connectivity is a bitmask of which in-plane neighbours it touches.
// The primary scheme `iso-4` uses the four orthogonal neighbours N, E, S, W
// (bit 0 = N, bit 1 = E, bit 2 = S, bit 3 = W). Masks are canonicalised by the
// four quarter-turn rotations: each rotation class keeps its numerically
// smallest mask as the representative.
//
// The optional `iso-8` scheme adds the four diagonals (8-bit mask) and applies
// the classic "blob" rule — a diagonal only counts when both of its adjacent
// orthogonal neighbours are present — which collapses the 256 raw masks to the
// well-known 47 canonical classes. It is opt-in to keep the file small.
//
// Pure TypeScript, no DOM: the same code runs in the browser and in node tests.

import { DIRECTIONAL_TYPES } from './primitives';
import type { CombinatoricsSet, PrimitiveType, SceneDocument, SceneObject } from './types';

export type CombinatoricsScheme = 'iso-4' | 'iso-8';

/**
 * The named connectivity classes for `iso-4`. `edge` is an alias of
 * `straight` (two opposite connections); the exporter emits `straight`.
 */
export type CombinationClass = 'single' | 'end' | 'straight' | 'corner' | 'tee' | 'center';

/** The four orthogonal sides, in bit order (bit 0 = N … bit 3 = W). */
export const SIDES = ['N', 'E', 'S', 'W'] as const;

/** The eight sides for `iso-8`, in bit order (bit 0 = N … bit 7 = NW). */
export const SIDES_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Emission order of the named `iso-4` classes (matches the spec example). */
const CLASS_ORDER: CombinationClass[] = ['single', 'end', 'straight', 'corner', 'tee', 'center'];

/**
 * Representative mask → class name, for the numerically-smallest
 * canonicalisation. `corner` is 0011 (N+E), the smallest of {3, 6, 9, 12}.
 */
const CLASS_BY_MASK: Record<number, CombinationClass> = {
  0: 'single',
  1: 'end',
  5: 'straight',
  3: 'corner',
  7: 'tee',
  15: 'center',
};

export interface CombinationRotation {
  rotation: number;
  mask: number;
}

export interface Combination {
  /** `CombinationClass` for `iso-4`; `iso8-<mask>` for `iso-8`. */
  id: string;
  /** The canonical (numerically smallest) mask of the class. */
  mask: number;
  rotations: CombinationRotation[];
}

/** A `SceneObject` shape minus `id`, always at rotation 0. */
export interface PrimitiveTemplate {
  type: PrimitiveType;
  width: number;
  depth: number;
  height: number;
  rotation: 0;
  parameter?: number;
}

export interface PrimitiveCombinatorics {
  type: PrimitiveType;
  /** Whether the primitive's look changes with rotation (from `DIRECTIONAL_TYPES`). */
  directional: boolean;
  template: PrimitiveTemplate;
  combinations: Combination[];
}

export interface CombinatoricsExport {
  format: 'plinth.combinatorics';
  version: 1;
  generator: 'plinth';
  exportedAt: string;
  scheme: CombinatoricsScheme;
  sides: string[];
  projection: { tileWidthPixels: number; levelHeightPixels: number };
  primitives: PrimitiveCombinatorics[];
}

export interface CombinatoricsOptions {
  /** Connectivity scheme. Defaults to `iso-4`. */
  scheme?: CombinatoricsScheme;
  /** Injectable clock so tests can pin `exportedAt`. */
  now?: Date;
}

/**
 * Cyclic left rotation of a 4-bit mask by `rotation` quarter turns.
 * `rotateMask(1, 1) === 2` (N → E); four applications are the identity.
 */
export function rotateMask(mask: number, rotation: number): number {
  const r = ((rotation % 4) + 4) % 4;
  return ((mask << r) | (mask >> (4 - r))) & 0xf;
}

/** Cyclic left rotation of an 8-bit mask by `rotation` eighth turns. */
export function rotateMask8(mask: number, rotation: number): number {
  const r = ((rotation % 8) + 8) % 8;
  return ((mask << r) | (mask >> (8 - r))) & 0xff;
}

/** Diagonal bit → the two orthogonal bits that must both be set for it to count. */
const DIAGONAL_REQUIRES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 2], // NE requires N and E
  [3, 2, 4], // SE requires E and S
  [5, 4, 6], // SW requires S and W
  [7, 6, 0], // NW requires W and N
];

/** Apply the blob rule: drop any diagonal whose adjacent orthogonals are not both present. */
export function blobNormalize(mask: number): number {
  let m = mask & 0xff;
  for (const [diagonal, a, b] of DIAGONAL_REQUIRES) {
    if ((m & (1 << a)) === 0 || (m & (1 << b)) === 0) m &= ~(1 << diagonal);
  }
  return m;
}

function canonicalIso4(): Combination[] {
  const seen = new Set<number>();
  const byClass = new Map<CombinationClass, Combination>();
  for (let mask = 0; mask < 16; mask++) {
    if (seen.has(mask)) continue;
    const rep = Math.min(rotateMask(mask, 0), rotateMask(mask, 1), rotateMask(mask, 2), rotateMask(mask, 3));
    const rotations: CombinationRotation[] = [];
    for (let r = 0; r < 4; r++) {
      const rotated = rotateMask(rep, r);
      seen.add(rotated);
      // Stop at the first repeat: single/center have one orientation, straight two.
      if (r > 0 && rotated === rep) break;
      rotations.push({ rotation: r, mask: rotated });
    }
    const id = CLASS_BY_MASK[rep];
    byClass.set(id, { id, mask: rep, rotations });
  }
  return CLASS_ORDER.map((id) => byClass.get(id)!).filter(Boolean);
}

/**
 * The 47 blob classes: every distinct blob-normalised 8-bit mask. The blob rule
 * is not rotation-equivariant, so these are the canonical tiles themselves (not
 * rotation orbits); each class lists its eight 45° orientations, re-normalised.
 */
function canonicalIso8(): Combination[] {
  const normalized = new Set<number>();
  for (let mask = 0; mask < 256; mask++) normalized.add(blobNormalize(mask));
  const classes: Combination[] = [];
  for (const mask of [...normalized].sort((a, b) => a - b)) {
    const rotations: CombinationRotation[] = [];
    for (let r = 0; r < 8; r++) {
      const rotated = blobNormalize(rotateMask8(mask, r));
      if (r > 0 && rotated === mask) break;
      rotations.push({ rotation: r, mask: rotated });
    }
    classes.push({ id: `iso8-${mask}`, mask, rotations });
  }
  return classes;
}

/**
 * The canonical connectivity classes for a scheme. `iso-4` yields the six named
 * classes (single, end, straight, corner, tee, center); `iso-8` yields the 47
 * blob classes.
 */
export function canonicalCombinations(scheme: CombinatoricsScheme = 'iso-4'): Combination[] {
  return scheme === 'iso-8' ? canonicalIso8() : canonicalIso4();
}

/**
 * Build the `plinth.combinatorics` v1 document for the distinct primitive
 * templates present in a scene. Keyed by full template (type + footprint +
 * height + parameter), so walls of different thicknesses are distinct entries.
 */
export function buildCombinatorics(document: SceneDocument, options: CombinatoricsOptions = {}): CombinatoricsExport {
  const scheme = options.scheme ?? 'iso-4';
  const combinations = canonicalCombinations(scheme);
  const seen = new Set<string>();
  const primitives: PrimitiveCombinatorics[] = [];
  for (const object of document.objects) {
    const key = `${object.type}|${object.width}|${object.depth}|${object.height}|${object.parameter ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    primitives.push({
      type: object.type,
      directional: DIRECTIONAL_TYPES.has(object.type),
      template: {
        type: object.type,
        width: object.width,
        depth: object.depth,
        height: object.height,
        rotation: 0,
        ...(object.parameter !== undefined ? { parameter: object.parameter } : {}),
      },
      combinations,
    });
  }
  return {
    format: 'plinth.combinatorics',
    version: 1,
    generator: 'plinth',
    exportedAt: (options.now ?? new Date()).toISOString(),
    scheme,
    sides: scheme === 'iso-8' ? [...SIDES_8] : [...SIDES],
    projection: {
      tileWidthPixels: document.settings.tileWidthPixels,
      levelHeightPixels: document.settings.levelHeightPixels,
    },
    primitives,
  };
}

// ── Import / validation ───────────────────────────────────────────────────────

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'block', 'wall', 'stairs', 'ramp', 'cylinder', 'sphere', 'cone', 'pyramid', 'arch',
]);

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Shape-check one `primitives[]` entry. Returns `null` for an unknown type (ignored, not thrown). */
function validatePrimitiveEntry(entry: unknown, index: number): PrimitiveCombinatorics | null {
  if (!entry || typeof entry !== 'object') throw new Error(`invalid combinatorics primitive at index ${index}`);
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate.type !== 'string') throw new Error(`invalid combinatorics primitive at index ${index}: missing type`);
  if (!PRIMITIVE_TYPES.has(candidate.type)) return null; // unknown primitive type: ignore it
  const template = candidate.template as Record<string, unknown> | undefined;
  if (!template || typeof template !== 'object' ||
    !isNumber(template.width) || !isNumber(template.depth) || !isNumber(template.height)) {
    throw new Error(`invalid combinatorics primitive at index ${index}: bad template`);
  }
  if (!Array.isArray(candidate.combinations)) {
    throw new Error(`invalid combinatorics primitive at index ${index}: missing combinations[]`);
  }
  for (const combination of candidate.combinations) {
    if (!combination || typeof combination !== 'object') throw new Error(`invalid combination in ${candidate.type}`);
    const combo = combination as Record<string, unknown>;
    if (typeof combo.id !== 'string' || !isNumber(combo.mask) || !Array.isArray(combo.rotations)) {
      throw new Error(`invalid combination in ${candidate.type}`);
    }
    for (const rotation of combo.rotations) {
      if (!rotation || typeof rotation !== 'object' ||
        !isNumber((rotation as Record<string, unknown>).rotation) ||
        !isNumber((rotation as Record<string, unknown>).mask)) {
        throw new Error(`invalid rotation in ${candidate.type}`);
      }
    }
  }
  return candidate as unknown as PrimitiveCombinatorics;
}

/**
 * Validate a parsed `plinth.combinatorics` value. Rejects wrong `format`,
 * unknown `version`, unknown `scheme`, and malformed combinations with a clear
 * message. Unknown primitive *types* are dropped rather than thrown, so a newer
 * exporter's extra entries do not break an older importer.
 */
export function validateCombinatorics(value: unknown): CombinatoricsSet {
  if (!value || typeof value !== 'object') throw new Error('not a combinatorics file');
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== 'plinth.combinatorics') throw new Error('not a plinth.combinatorics file');
  if (candidate.version !== 1) throw new Error(`unsupported combinatorics version: ${String(candidate.version)}`);
  if (candidate.scheme !== 'iso-4' && candidate.scheme !== 'iso-8') {
    throw new Error(`unknown connectivity scheme: ${String(candidate.scheme)}`);
  }
  if (!Array.isArray(candidate.primitives)) throw new Error('missing primitives[]');
  const primitives = candidate.primitives
    .map((entry, index) => validatePrimitiveEntry(entry, index))
    .filter((entry): entry is PrimitiveCombinatorics => entry !== null);
  const source = typeof candidate.exportedAt === 'string'
    ? { exportedAt: candidate.exportedAt }
    : typeof candidate.source === 'object' && candidate.source !== null
      ? (candidate.source as { name?: string; exportedAt?: string })
      : undefined;
  return {
    format: 'plinth.combinatorics',
    version: 1,
    scheme: candidate.scheme,
    ...(source ? { source } : {}),
    primitives,
  };
}

/** Parse and validate `plinth.combinatorics` JSON text. Throws a clear error on bad input. */
export function parseCombinatorics(text: string): CombinatoricsSet {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  return validateCombinatorics(value);
}

// ── Surfaces ─────────────────────────────────────────────────────────────────

/** Which side faces of a primitive are "open" (joined to a compatible neighbour). */
export interface FaceOpenFlags {
  px: boolean;
  nx: boolean;
  py: boolean;
  ny: boolean;
}

/** Expand a world-space neighbour mask into per-face open flags. Top/bottom never open. */
export function openFacesFromMask(mask: number): FaceOpenFlags {
  return {
    px: (mask & 2) !== 0,
    nx: (mask & 8) !== 0,
    py: (mask & 4) !== 0,
    ny: (mask & 1) !== 0,
  };
}

/** The numerically smallest of the four rotations of `mask` — the class representative. */
export function canonicalMask(mask: number): number {
  return Math.min(rotateMask(mask, 0), rotateMask(mask, 1), rotateMask(mask, 2), rotateMask(mask, 3));
}

export interface ResolvedCombination {
  /** The imported class for this mask, or `null` if the set has no entry for the type/mask. */
  combination: Combination | null;
  className: string | null;
  open: FaceOpenFlags;
}

/**
 * Canonicalise a world-space mask and look it up in the imported set. The open
 * flags come from the *actual* mask (world-space), so the class lookup and the
 * surface flags never double-count rotation.
 */
export function resolveCombination(set: CombinatoricsSet, type: PrimitiveType, mask: number): ResolvedCombination {
  const representative = canonicalMask(mask);
  const primitive = set.primitives.find((entry) => entry.type === type);
  const combination = primitive?.combinations.find((entry) => entry.mask === representative) ?? null;
  return { combination, className: combination?.id ?? null, open: openFacesFromMask(mask) };
}

// ── Adjacency ─────────────────────────────────────────────────────────────────

const ADJACENCY_TOLERANCE = 1e-3;

/** Mask bits: N (toward −y) = 1, E (+x) = 2, S (+y) = 4, W (−x) = 8. */
const OPPOSITE: Record<number, number> = { 1: 4, 4: 1, 2: 8, 8: 2 };

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < ADJACENCY_TOLERANCE;
}

/**
 * The direction bit from `a` toward `b` when the two are compatible, face-adjacent
 * primitives, else 0. Compatibility = same type, same vertical span (z, height),
 * the same `parameter` (wall/arch thickness, stair count), a coincident abutting
 * plane, and matching footprint edge length — so a thick wall never falsely
 * connects to a thin one (spec §3(g)).
 */
export function abuttingDirection(a: SceneObject, b: SceneObject): number {
  if (a.type !== b.type) return 0;
  if (!near(a.z, b.z) || !near(a.height, b.height)) return 0;
  if (!near(a.parameter ?? 0, b.parameter ?? 0)) return 0;
  // E: b's low-x edge abuts a's high-x edge, full depth matching.
  if (near(b.x, a.x + a.width) && near(a.y, b.y) && near(a.depth, b.depth)) return 2;
  // W: a's low-x edge abuts b's high-x edge.
  if (near(a.x, b.x + b.width) && near(a.y, b.y) && near(a.depth, b.depth)) return 8;
  // S: b's low-y edge abuts a's high-y edge, full width matching.
  if (near(b.y, a.y + a.depth) && near(a.x, b.x) && near(a.width, b.width)) return 4;
  // N: a's low-y edge abuts b's high-y edge.
  if (near(a.y, b.y + b.depth) && near(a.x, b.x) && near(a.width, b.width)) return 1;
  return 0;
}

export interface Adjacency {
  /** Neighbour mask per object (index-aligned to the input). */
  masks: number[];
  /** Pair keys `a * stride + b` for every connected pair, in both orders. */
  pairs: Set<number>;
}

/** Pair-key stride for a scene of `size` objects; shared by adjacency and the edge pass. */
export function pairStride(size: number): number {
  return size + 1;
}

/**
 * Derive each object's in-plane neighbour mask and the set of connected pairs,
 * using a spatial hash so a 20 000-object scene stays O(n)-ish rather than O(n²).
 */
export function analyseAdjacency(objects: SceneObject[]): Adjacency {
  const masks = new Array<number>(objects.length).fill(0);
  const pairs = new Set<number>();
  const stride = pairStride(objects.length);

  // Register each object in every unit cell its footprint overlaps.
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
    // Any face-adjacent neighbour lies within one tile, so query the expanded box.
    const lowX = Math.floor(a.x - 1 - ADJACENCY_TOLERANCE);
    const highX = Math.floor(a.x + a.width + 1 + ADJACENCY_TOLERANCE);
    const lowY = Math.floor(a.y - 1 - ADJACENCY_TOLERANCE);
    const highY = Math.floor(a.y + a.depth + 1 + ADJACENCY_TOLERANCE);
    for (let cx = lowX; cx <= highX; cx++) {
      for (let cy = lowY; cy <= highY; cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const ib of bucket) {
          if (ib === ia) continue;
          const key = ia * stride + ib;
          if (tested.has(key)) continue;
          tested.add(key);
          const direction = abuttingDirection(a, objects[ib]);
          if (direction === 0) continue;
          masks[ia] |= direction;
          masks[ib] |= OPPOSITE[direction];
          pairs.add(ia * stride + ib);
          pairs.add(ib * stride + ia);
        }
      }
    }
  });

  return { masks, pairs };
}

/** Convenience wrapper: just the neighbour mask per object. */
export function neighbourMasks(objects: SceneObject[]): number[] {
  return analyseAdjacency(objects).masks;
}
