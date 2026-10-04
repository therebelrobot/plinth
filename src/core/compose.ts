// Turns render buffers into pixels: grey values per shading mode, then the
// composite image or separate layers (for PSD export).

import { OWNER_FLOOR, OWNER_NONE, type RenderBuffers } from './render';
import type { RenderOptions, SceneSettings } from './types';

// Light from upper-left-front. In this projection the +y face is the visible
// left face and +x the right face, so with this vector a block reads as
// top = lightest, left = middle, right = darkest at every band count ≥ 3.
const LIGHT = (() => {
  const x = 0.35, y = 0.7, z = 1;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length] as const;
})();

const OBJECT_RAMP = [64, 232] as const;
const FLOOR_RAMP = [118, 204] as const;
export const OUTLINE_GREY = 34;
const GRID_DARKEN = 26;

function rampValue(ramp: readonly [number, number], fraction: number): number {
  return Math.round(ramp[0] + (ramp[1] - ramp[0]) * Math.min(1, Math.max(0, fraction)));
}

function bandFraction(buffers: RenderBuffers, index: number, bands: number): number {
  const lambert =
    buffers.normalX[index] * LIGHT[0] + buffers.normalY[index] * LIGHT[1] + buffers.normalZ[index] * LIGHT[2];
  const band = Math.min(bands - 1, Math.max(0, Math.floor(lambert * bands)));
  return bands > 1 ? band / (bands - 1) : 1;
}

/** Grey value 0–255 for a covered pixel, or −1 for empty. */
export function toneAt(buffers: RenderBuffers, index: number, options: RenderOptions, settings: Pick<SceneSettings, 'levelCount'>): number {
  const owner = buffers.owner[index];
  if (owner === OWNER_NONE) return -1;
  const isFloor = owner === OWNER_FLOOR;
  const ramp = isFloor ? FLOOR_RAMP : OBJECT_RAMP;
  switch (options.shading) {
    case 'blank':
      return isFloor ? 236 : 255;
    case 'silhouette':
      return isFloor ? 206 : 150;
    case 'height': {
      if (isFloor) return rampValue(FLOOR_RAMP, bandFraction(buffers, index, 3) * 0.6);
      // Tops belong to the level they cap, hence the small downward nudge.
      const surfaceZ = buffers.depth[index] * buffers.projection.viewZ;
      const level = Math.max(0, Math.floor(surfaceZ - 1e-3));
      const levels = Math.max(1, settings.levelCount - 1);
      const base = rampValue(OBJECT_RAMP, level / levels);
      // Subtle per-face modulation so tops and sides of one level stay distinct.
      const lambert =
        buffers.normalX[index] * LIGHT[0] + buffers.normalY[index] * LIGHT[1] + buffers.normalZ[index] * LIGHT[2];
      return Math.round(base * (0.82 + 0.18 * Math.max(0, lambert)));
    }
    case 'shaded':
    default:
      return rampValue(ramp, bandFraction(buffers, index, options.bands));
  }
}

function backgroundGrey(options: RenderOptions): number {
  if (options.background === 'white') return 255;
  if (options.background === 'neutral') return 128;
  return -1;
}

export interface ComposeExtras {
  /** Editor-only: tint this object's pixels. */
  highlightOwner?: number;
  highlightColor?: readonly [number, number, number];
}

function write(rgba: Uint8ClampedArray, index: number, grey: number): void {
  const offset = index * 4;
  rgba[offset] = grey; rgba[offset + 1] = grey; rgba[offset + 2] = grey; rgba[offset + 3] = 255;
}

/** Flattened RGBA image. */
export function composeImage(
  buffers: RenderBuffers,
  options: RenderOptions,
  settings: Pick<SceneSettings, 'levelCount'>,
  extras: ComposeExtras = {},
): Uint8ClampedArray {
  const { width, height } = buffers;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const background = backgroundGrey(options);
  for (let index = 0; index < width * height; index++) {
    let grey = toneAt(buffers, index, options, settings);
    if (grey >= 0 && buffers.grid[index]) grey = Math.max(0, grey - GRID_DARKEN);
    if (buffers.outline[index] && buffers.owner[index] !== OWNER_NONE) grey = OUTLINE_GREY;
    if (grey < 0) {
      if (background >= 0) write(rgba, index, background);
      continue;
    }
    write(rgba, index, grey);
    if (extras.highlightOwner !== undefined && buffers.owner[index] === extras.highlightOwner && extras.highlightColor) {
      const offset = index * 4;
      const [red, green, blue] = extras.highlightColor;
      rgba[offset] = (rgba[offset] * 0.45 + red * 0.55) | 0;
      rgba[offset + 1] = (rgba[offset + 1] * 0.45 + green * 0.55) | 0;
      rgba[offset + 2] = (rgba[offset + 2] * 0.45 + blue * 0.55) | 0;
    }
  }
  return rgba;
}

export interface ImageLayer {
  name: string;
  rgba: Uint8ClampedArray;
  hidden?: boolean;
}

/**
 * Layers for PSD export, bottom to top. Each object layer holds only the
 * pixels its objects *won* in the z-buffer, so the layers never overlap and the
 * stack order cannot break occlusion — hiding "Level 2" in Procreate simply
 * reveals nothing (empty) where level 2 was, and the rest stays correct.
 */
export function composeLayers(
  buffers: RenderBuffers,
  options: RenderOptions,
  settings: Pick<SceneSettings, 'levelCount'>,
): ImageLayer[] {
  const { width, height } = buffers;
  const size = width * height;
  const layers: ImageLayer[] = [];

  const background = backgroundGrey(options);
  if (background >= 0) {
    const rgba = new Uint8ClampedArray(size * 4);
    for (let index = 0; index < size; index++) write(rgba, index, background);
    layers.push({ name: 'Background', rgba });
  }

  const floor = new Uint8ClampedArray(size * 4);
  const grid = new Uint8ClampedArray(size * 4);
  const levelLayers = new Map<number, Uint8ClampedArray>();
  const outline = new Uint8ClampedArray(size * 4);
  let hasFloor = false, hasGrid = false, hasOutline = false;

  for (let index = 0; index < size; index++) {
    const owner = buffers.owner[index];
    if (owner === OWNER_NONE) continue;
    const grey = toneAt(buffers, index, options, settings);
    if (owner === OWNER_FLOOR) {
      write(floor, index, grey); hasFloor = true;
      if (buffers.grid[index]) { write(grid, index, Math.max(0, grey - GRID_DARKEN)); hasGrid = true; }
    } else {
      const level = Math.floor(buffers.objects[owner].z + 1e-6);
      let target = levelLayers.get(level);
      if (!target) { target = new Uint8ClampedArray(size * 4); levelLayers.set(level, target); }
      write(target, index, grey);
    }
    if (buffers.outline[index]) { write(outline, index, OUTLINE_GREY); hasOutline = true; }
  }

  if (hasFloor) layers.push({ name: 'Floor', rgba: floor });
  if (hasGrid) layers.push({ name: 'Floor grid', rgba: grid });
  [...levelLayers.keys()].sort((first, second) => first - second).forEach((level) => {
    layers.push({ name: `Level ${level}`, rgba: levelLayers.get(level)! });
  });
  if (hasOutline) layers.push({ name: 'Outlines', rgba: outline });
  return layers;
}

/** Nearest-neighbour integer upscale. */
export function upscale(rgba: Uint8ClampedArray, width: number, height: number, factor: number): Uint8ClampedArray {
  if (factor === 1) return rgba;
  const scaledWidth = width * factor;
  const output = new Uint8ClampedArray(scaledWidth * height * factor * 4);
  const source = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const target = new Uint32Array(output.buffer);
  for (let y = 0; y < height * factor; y++) {
    const sourceRow = Math.floor(y / factor) * width;
    for (let x = 0; x < scaledWidth; x++) target[y * scaledWidth + x] = source[sourceRow + Math.floor(x / factor)];
  }
  return output;
}
