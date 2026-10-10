// Turning renders into files the user can save or send to Procreate.

import { colorActive } from '../core/color';
import { buildCombinatorics, type CombinatoricsOptions } from '../core/combinatorics';
import { composeColorImage, composeImage, composeLayers, upscale } from '../core/compose';
import { PRIMITIVE_PRESETS, DIRECTIONAL_TYPES } from '../core/primitives';
import { encodePsd } from '../core/psd';
import { renderPrimitive, renderScene } from '../core/render';
import type { RenderOptions, Rotation, SceneDocument, SceneObject } from '../core/types';
import { createZip, type ZipEntry } from '../core/zip';

export function rgbaToCanvas(rgba: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

async function rgbaToPng(rgba: Uint8ClampedArray, width: number, height: number, scale: number): Promise<Blob> {
  const scaled = upscale(rgba, width, height, scale);
  return canvasToPng(rgbaToCanvas(scaled, width * scale, height * scale));
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene';
}

/**
 * Hand a file to the user. On iPad the share sheet is the useful path
 * (Procreate appears in it, as does "Save to Files"); on desktop, a download.
 * navigator.share needs a secure context, so plain-HTTP LAN use falls back to
 * download, which iPadOS Safari also supports.
 */
export async function deliverFile(blob: Blob, filename: string, preferShare: boolean): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type });
  if (preferShare && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return 'cancelled';
      // Fall through to download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}

export function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

export async function exportScenePng(document: SceneDocument, options: RenderOptions, scale: number, color = false): Promise<{ blob: Blob; filename: string }> {
  const buffers = renderScene(document.settings, document.objects, options, document.combinatorics);
  const rgba = color && colorActive(document)
    ? composeColorImage(buffers, options, document.settings, document.palette!, document.colorSettings!)
    : composeImage(buffers, options, document.settings);
  const blob = await rgbaToPng(rgba, buffers.width, buffers.height, scale);
  return { blob, filename: `${slug(document.name)}${scale > 1 ? `@${scale}x` : ''}.png` };
}

export function exportScenePsd(document: SceneDocument, options: RenderOptions, scale: number): { blob: Blob; filename: string } {
  const buffers = renderScene(document.settings, document.objects, options, document.combinatorics);
  const palette = colorActive(document) ? document.palette : undefined;
  const layers = composeLayers(buffers, options, document.settings, palette, document.colorSettings).map((layer) => ({
    ...layer,
    rgba: upscale(layer.rgba, buffers.width, buffers.height, scale),
  }));
  const bytes = encodePsd(buffers.width * scale, buffers.height * scale, layers);
  return {
    blob: new Blob([bytes as BlobPart], { type: 'image/vnd.adobe.photoshop' }),
    filename: `${slug(document.name)}${scale > 1 ? `@${scale}x` : ''}.psd`,
  };
}

export function primitiveFilename(object: Pick<SceneObject, 'type' | 'width' | 'depth' | 'height' | 'rotation' | 'slope' | 'slopeDirection'>, scale: number): string {
  const size = `${object.width}x${object.depth}x${object.height}`.replace(/\./g, 'p');
  // Sloped and flat walls share a type, so the slope must be in the name to keep kit sprites unique.
  const slope = object.slope && object.slope > 0
    ? `_s${String(object.slope).replace('.', 'p')}${object.slopeDirection === -1 ? 'n' : 'p'}`
    : '';
  return `${object.type}_${size}_r${object.rotation}${slope}${scale > 1 ? `@${scale}x` : ''}.png`;
}

export async function exportPrimitivePng(
  settings: SceneDocument['settings'], object: SceneObject, options: RenderOptions, scale: number,
): Promise<{ blob: Blob; filename: string }> {
  const buffers = renderPrimitive(settings, object, options);
  const rgba = composeImage(buffers, { ...options, background: options.background, showFloor: false }, settings);
  return { blob: await rgbaToPng(rgba, buffers.width, buffers.height, scale), filename: primitiveFilename(object, scale) };
}

/**
 * Every palette preset at its default size, in every distinct rotation,
 * each cropped to its own bounding box — plus a single sheet with all of them
 * on a fixed cell grid (sheet.png) and an index (kit.json) giving each
 * sprite's cell and its ground-anchor offset.
 */
export async function exportPrimitiveKit(
  settings: SceneDocument['settings'], options: RenderOptions, scale: number,
): Promise<{ blob: Blob; filename: string }> {
  interface Sprite { name: string; rgba: Uint8ClampedArray; width: number; height: number; anchorX: number; anchorY: number }
  const sprites: Sprite[] = [];
  const seen = new Set<string>();
  for (const preset of PRIMITIVE_PRESETS) {
    const rotations: Rotation[] = DIRECTIONAL_TYPES.has(preset.type) ? [0, 1, 2, 3] : [0];
    for (const rotation of rotations) {
      const object: SceneObject = {
        id: 'kit', type: preset.type, x: 0, y: 0, z: 0,
        width: rotation % 2 ? preset.depth : preset.width,
        depth: rotation % 2 ? preset.width : preset.depth,
        height: preset.height, rotation, parameter: preset.parameter,
        slope: preset.slope, slopeDirection: preset.slopeDirection,
      };
      const name = `${preset.key}_r${rotation}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const buffers = renderPrimitive(settings, object, options);
      sprites.push({
        name,
        rgba: composeImage(buffers, options, settings),
        width: buffers.width,
        height: buffers.height,
        // Screen position of the footprint's back corner at z = 0 — the point that sits on the grid.
        anchorX: buffers.projection.originX,
        anchorY: buffers.projection.originY,
      });
    }
  }

  const entries: ZipEntry[] = [];
  for (const sprite of sprites) {
    const blob = await rgbaToPng(sprite.rgba, sprite.width, sprite.height, scale);
    entries.push({ name: `sprites/${sprite.name}${scale > 1 ? `@${scale}x` : ''}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
  }

  // Sheet: uniform cells sized to the largest sprite, one preset per row.
  const cellWidth = Math.max(...sprites.map((sprite) => sprite.width)) + 2;
  const cellHeight = Math.max(...sprites.map((sprite) => sprite.height)) + 2;
  const columns = 4;
  const rows = Math.ceil(sprites.length / columns);
  const sheet = document.createElement('canvas');
  sheet.width = cellWidth * columns;
  sheet.height = cellHeight * rows;
  const context = sheet.getContext('2d')!;
  const index: Record<string, { cellX: number; cellY: number; width: number; height: number; anchorX: number; anchorY: number }> = {};
  sprites.forEach((sprite, spriteIndex) => {
    const column = spriteIndex % columns, row = Math.floor(spriteIndex / columns);
    const offsetX = column * cellWidth + 1, offsetY = row * cellHeight + 1 + (cellHeight - 2 - sprite.height);
    context.drawImage(rgbaToCanvas(sprite.rgba, sprite.width, sprite.height), offsetX, offsetY);
    index[sprite.name] = { cellX: offsetX, cellY: offsetY, width: sprite.width, height: sprite.height, anchorX: sprite.anchorX, anchorY: sprite.anchorY };
  });
  const sheetData = context.getImageData(0, 0, sheet.width, sheet.height).data;
  const sheetBlob = await rgbaToPng(sheetData, sheet.width, sheet.height, scale);
  entries.push({ name: `sheet${scale > 1 ? `@${scale}x` : ''}.png`, data: new Uint8Array(await sheetBlob.arrayBuffer()) });
  entries.push({
    name: 'kit.json',
    data: new TextEncoder().encode(JSON.stringify({
      tileWidthPixels: settings.tileWidthPixels,
      levelHeightPixels: settings.levelHeightPixels,
      scale,
      note: 'Coordinates are at 1× scale. anchor = screen position of the footprint back corner at ground level.',
      sprites: index,
    }, null, 2)),
  });

  const bytes = createZip(entries);
  return {
    blob: new Blob([bytes as BlobPart], { type: 'application/zip' }),
    filename: `plinth-kit_${settings.tileWidthPixels}px${scale > 1 ? `@${scale}x` : ''}.zip`,
  };
}

export function exportSceneJson(document: SceneDocument): { blob: Blob; filename: string } {
  return {
    blob: new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }),
    filename: `${slug(document.name)}.plinth.json`,
  };
}

/**
 * The connectivity classes (center / edge / corner, plus single / end / tee) for
 * every distinct primitive template in the scene, as a `plinth.combinatorics` v1
 * document. Mirrors `exportSceneJson`.
 */
export function exportCombinatoricsJson(document: SceneDocument, options: CombinatoricsOptions = {}): { blob: Blob; filename: string } {
  const payload = buildCombinatorics(document, options);
  return {
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    filename: `${slug(document.name)}.combinatorics.json`,
  };
}
