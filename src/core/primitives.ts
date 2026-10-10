import type { PrimitiveType, SceneObject } from './types';

export interface PrimitivePreset {
  key: string;
  label: string;
  type: PrimitiveType;
  width: number;
  depth: number;
  height: number;
  parameter?: number;
  /** Keyboard shortcut on desktop. Empty for generated tall variants. */
  shortcut: string;
  /** Height multiplier relative to the type's base preset. 1 for every non-variant. */
  tallness: number;
}

/**
 * Palette entries. Several presets share a type (a slab is a short block) so the
 * inspector stays small: every preset is just a starting size.
 */
const BASE_PRESETS: PrimitivePreset[] = [
  { key: 'block', label: 'Block', type: 'block', width: 1, depth: 1, height: 1, shortcut: '1', tallness: 1 },
  { key: 'slab', label: 'Slab', type: 'block', width: 1, depth: 1, height: 0.5, shortcut: '2', tallness: 1 },
  { key: 'plate', label: 'Plate', type: 'block', width: 1, depth: 1, height: 0.25, shortcut: '3', tallness: 1 },
  { key: 'wall', label: 'Wall', type: 'wall', width: 1, depth: 1, height: 2, parameter: 0.25, shortcut: '4', tallness: 1 },
  { key: 'stairs', label: 'Stairs', type: 'stairs', width: 1, depth: 1, height: 1, parameter: 4, shortcut: '5', tallness: 1 },
  { key: 'ramp', label: 'Ramp', type: 'ramp', width: 1, depth: 1, height: 1, shortcut: '6', tallness: 1 },
  { key: 'cylinder', label: 'Cylinder', type: 'cylinder', width: 1, depth: 1, height: 1, shortcut: '7', tallness: 1 },
  { key: 'sphere', label: 'Sphere', type: 'sphere', width: 1, depth: 1, height: 1, shortcut: '8', tallness: 1 },
  { key: 'cone', label: 'Cone', type: 'cone', width: 1, depth: 1, height: 1, shortcut: '9', tallness: 1 },
  { key: 'pyramid', label: 'Pyramid', type: 'pyramid', width: 1, depth: 1, height: 1, shortcut: '0', tallness: 1 },
  { key: 'arch', label: 'Arch', type: 'arch', width: 1, depth: 1, height: 2, parameter: 0.25, shortcut: '-', tallness: 1 },
];

/**
 * Types whose top surface transitions between levels: ramps and stairs
 * (traversal) plus pyramids and cones (taper to an apex). These get tall
 * variants; blocks, walls, cylinders, spheres and arches do not.
 */
export const LEVEL_CHANGING_TYPES: ReadonlySet<PrimitiveType> = new Set(['ramp', 'stairs', 'pyramid', 'cone']);

/** Height multipliers offered for level-changing primitives. */
export const TALL_VARIANTS = [0.5, 1, 1.5, 2] as const;

const TALL_VARIANT_LABELS: Record<number, string> = {
  0.5: '½×',
  1: '1×',
  1.5: '1½×',
  2: '2×',
};

export function tallVariantLabel(tallness: number): string {
  return TALL_VARIANT_LABELS[tallness] ?? `${tallness}×`;
}

/** `ramp` → `ramp_tall05` / `ramp` / `ramp_tall15` / `ramp_tall2`. */
function tallVariantKey(baseKey: string, tallness: number): string {
  return tallness === 1 ? baseKey : `${baseKey}_tall${String(tallness).replace('.', '')}`;
}

/**
 * The palette: every base preset, plus a 0.5×/1×/1.5×/2× tall variant for each
 * level-changing type. The 1× variant is the base preset itself, so it is not
 * duplicated. Generated in code so the kit and icon exports stay in sync.
 */
export const PRIMITIVE_PRESETS: PrimitivePreset[] = BASE_PRESETS.flatMap((preset) => {
  if (!LEVEL_CHANGING_TYPES.has(preset.type)) return [preset];
  return TALL_VARIANTS.map((tallness) => ({
    ...preset,
    key: tallVariantKey(preset.key, tallness),
    label: tallness === 1 ? preset.label : `${preset.label} ${tallVariantLabel(tallness)}`,
    height: Number((preset.height * tallness).toFixed(4)),
    tallness,
    shortcut: tallness === 1 ? preset.shortcut : '',
  }));
});

/** Base (1×) height for a type, used to derive the current tall variant. */
export function baseHeight(type: PrimitiveType): number {
  const base = BASE_PRESETS.find((preset) => preset.type === type && preset.tallness === 1);
  return base?.height ?? 1;
}

export const TYPE_LABELS: Record<PrimitiveType, string> = {
  block: 'Block',
  wall: 'Wall',
  stairs: 'Stairs',
  ramp: 'Ramp',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  cone: 'Cone',
  pyramid: 'Pyramid',
  arch: 'Arch',
};

/** Types whose look changes with rotation (the rest are symmetric under quarter turns of a square footprint). */
export const DIRECTIONAL_TYPES: ReadonlySet<PrimitiveType> = new Set(['wall', 'stairs', 'ramp', 'arch']);

export interface ParameterSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  fallback: number;
}

export const PARAMETER_SPECS: Partial<Record<PrimitiveType, ParameterSpec>> = {
  stairs: { label: 'Steps', min: 2, max: 16, step: 1, fallback: 4 },
  wall: { label: 'Thickness', min: 0.125, max: 1, step: 0.125, fallback: 0.25 },
  arch: { label: 'Thickness', min: 0.125, max: 1, step: 0.125, fallback: 0.25 },
};

export function parameterOf(object: Pick<SceneObject, 'type' | 'parameter'>): number {
  const spec = PARAMETER_SPECS[object.type];
  if (!spec) return 0;
  return object.parameter ?? spec.fallback;
}

/**
 * Rotating a non-square footprint by a quarter turn swaps its world width/depth.
 * Returns the footprint after rotating from `from` to `to`.
 */
export function rotatedFootprint(width: number, depth: number, from: number, to: number): [number, number] {
  return (from - to) % 2 === 0 ? [width, depth] : [depth, width];
}
