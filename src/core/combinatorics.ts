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
import type { PrimitiveType, SceneDocument } from './types';

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
