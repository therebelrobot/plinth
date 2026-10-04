// Palette thumbnails drawn by the same renderer the scene uses.
import { composeImage } from '../core/compose';
import { PRIMITIVE_PRESETS } from '../core/primitives';
import { renderPrimitive } from '../core/render';
import { DEFAULT_RENDER_OPTIONS, type Rotation } from '../core/types';
import { rgbaToCanvas } from './exporters';

const cache = new Map<string, string>();

export function presetIcon(key: string, rotation: Rotation = 0): string {
  const cacheKey = `${key}:${rotation}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const preset = PRIMITIVE_PRESETS.find((candidate) => candidate.key === key)!;
  const swapped = rotation % 2 === 1;
  const buffers = renderPrimitive({ tileWidthPixels: 20, levelHeightPixels: 10 }, {
    id: 'icon', type: preset.type, x: 0, y: 0, z: 0,
    width: swapped ? preset.depth : preset.width,
    depth: swapped ? preset.width : preset.depth,
    height: preset.height, rotation, parameter: preset.parameter,
  }, { ...DEFAULT_RENDER_OPTIONS, showFloor: false });
  const rgba = composeImage(buffers, { ...DEFAULT_RENDER_OPTIONS, showFloor: false }, { levelCount: 4 });
  const url = rgbaToCanvas(rgba, buffers.width, buffers.height).toDataURL('image/png');
  cache.set(cacheKey, url);
  return url;
}
