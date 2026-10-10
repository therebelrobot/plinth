// Feature 10 EXPORT half — the DOM side. Renders the tileset via the canvas PNG
// path and packages it with `createZip`. The heavy lifting (enumeration, adjacency,
// per-config outline suppression, manifest) lives in `src/core/tileset.ts` so it
// runs in node tests too.

import { buildTileset, type TilesetManifest, type TilesetPngEncoder } from '../core/tileset';
import type { RenderOptions, SceneDocument } from '../core/types';
import { createZip } from '../core/zip';
import { canvasToPng, rgbaToCanvas } from './exporters';

/** Browser PNG encoder: RGBA → canvas → PNG bytes. */
export const canvasPngEncoder: TilesetPngEncoder = async (rgba, width, height) => {
  const blob = await canvasToPng(rgbaToCanvas(rgba, width, height));
  return new Uint8Array(await blob.arrayBuffer());
};

/**
 * Emit the discrete block-image tileset for the active scene: one PNG per
 * open-corner configuration (47) for each distinct face, plus `manifest.json`,
 * packaged as a zip. Export is at rotation 0; rotation is applied at import.
 *
 * The PNG encoder is injectable so tests can run this without a DOM (the default
 * uses the canvas path).
 */
export async function exportTileset(
  document: SceneDocument,
  options: RenderOptions,
  scale = 1,
  encodePng: TilesetPngEncoder = canvasPngEncoder,
  now: Date = new Date(),
): Promise<{ blob: Blob; filename: string; manifest: TilesetManifest }> {
  const { manifest, entries, filename } = await buildTileset(document, options, scale, encodePng, { now });
  const bytes = createZip(entries, now);
  return {
    blob: new Blob([bytes as BlobPart], { type: 'application/zip' }),
    filename,
    manifest,
  };
}
