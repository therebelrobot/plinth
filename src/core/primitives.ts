import type { PrimitiveType, SceneObject } from './types';

export interface PrimitivePreset {
  key: string;
  label: string;
  type: PrimitiveType;
  width: number;
  depth: number;
  height: number;
  parameter?: number;
  /** Keyboard shortcut on desktop. */
  shortcut: string;
}

/**
 * Palette entries. Several presets share a type (a slab is a short block) so the
 * inspector stays small: every preset is just a starting size.
 */
export const PRIMITIVE_PRESETS: PrimitivePreset[] = [
  { key: 'block', label: 'Block', type: 'block', width: 1, depth: 1, height: 1, shortcut: '1' },
  { key: 'slab', label: 'Slab', type: 'block', width: 1, depth: 1, height: 0.5, shortcut: '2' },
  { key: 'plate', label: 'Plate', type: 'block', width: 1, depth: 1, height: 0.25, shortcut: '3' },
  { key: 'wall', label: 'Wall', type: 'wall', width: 1, depth: 1, height: 2, parameter: 0.25, shortcut: '4' },
  { key: 'stairs', label: 'Stairs', type: 'stairs', width: 1, depth: 1, height: 1, parameter: 4, shortcut: '5' },
  { key: 'ramp', label: 'Ramp', type: 'ramp', width: 1, depth: 1, height: 1, shortcut: '6' },
  { key: 'cylinder', label: 'Cylinder', type: 'cylinder', width: 1, depth: 1, height: 1, shortcut: '7' },
  { key: 'sphere', label: 'Sphere', type: 'sphere', width: 1, depth: 1, height: 1, shortcut: '8' },
  { key: 'cone', label: 'Cone', type: 'cone', width: 1, depth: 1, height: 1, shortcut: '9' },
  { key: 'pyramid', label: 'Pyramid', type: 'pyramid', width: 1, depth: 1, height: 1, shortcut: '0' },
  { key: 'arch', label: 'Arch', type: 'arch', width: 1, depth: 1, height: 2, parameter: 0.25, shortcut: '-' },
];

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
