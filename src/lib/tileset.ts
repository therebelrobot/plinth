// Feature 10 EXPORT half — the DOM side. Renders the tileset via the canvas PNG
// path and packages it with `createZip`. The heavy lifting (enumeration, adjacency,
// per-config outline suppression, manifest) lives in `src/core/tileset.ts` so it
// runs in node tests too.

import { buildTileset, parseTilesetManifest, type TilesetManifest, type TilesetPngEncoder, type TilesetSpriteSet } from '../core/tileset';
import type { TilesetSpriteImage } from '../core/compose';
import { makeObjectId, type RenderOptions, type SceneDocument, type TilesetRef } from '../core/types';
import { createZip, readZip } from '../core/zip';
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

// ── Feature 10 IMPORT half ────────────────────────────────────────────────────

export interface DecodedSprite {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Injected PNG decoder so the importer is testable without a DOM. */
export type TilesetPngDecoder = (bytes: Uint8Array) => Promise<DecodedSprite>;

/** Browser PNG decoder: bytes → Blob → ImageBitmap → canvas → RGBA. */
export const canvasPngDecoder: TilesetPngDecoder = async (bytes) => {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  (bitmap as ImageBitmap & { close?: () => void }).close?.();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: image.width, height: image.height, data: image.data };
};

export interface ImportedTileset {
  ref: TilesetRef;
  sprites: TilesetSpriteSet;
}

/**
 * Feature 10 — read a `plinth.tileset` zip, validate its manifest, decode every
 * sprite PNG, and return the manifest reference plus the decoded sprites. Missing
 * or undecodable sprite files are skipped with a warning so a partially-drawn
 * tileset still renders (the grey tone fills the gaps).
 */
export async function importTilesetBytes(
  bytes: Uint8Array,
  decodePng: TilesetPngDecoder = canvasPngDecoder,
  warn: (message: string) => void = () => { },
): Promise<ImportedTileset> {
  const entries = readZip(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  const manifestData = byName.get('manifest.json');
  if (!manifestData) throw new Error('not a tileset: missing manifest.json');
  const manifest = parseTilesetManifest(new TextDecoder().decode(manifestData), warn);

  const sprites: TilesetSpriteSet = new Map();
  let missing = 0;
  let mismatched = 0;
  for (const face of manifest.faces) {
    const configs = new Map<string, TilesetSpriteImage>();
    for (const [id, sprite] of Object.entries(face.sprites)) {
      const data = byName.get(sprite.file);
      if (!data) { missing++; continue; }
      try {
        const decoded = await decodePng(data);
        // §10(b)(3): the decoded PNG must match the manifest's declared size.
        // A wrong-size sprite is skipped (grey fallback), like a missing file.
        if (decoded.width !== sprite.width || decoded.height !== sprite.height) {
          mismatched++;
          continue;
        }
        configs.set(id, { width: decoded.width, height: decoded.height, data: decoded.data });
      } catch {
        missing++;
      }
    }
    sprites.set(face.slug, configs);
  }
  if (missing > 0) warn(`tileset: ${missing} sprite file(s) missing or unreadable — grey fallback used`);
  if (mismatched > 0) warn(`tileset: ${mismatched} sprite(s) skipped — PNG size does not match the manifest`);
  return { ref: { id: `tileset-${makeObjectId()}`, manifest }, sprites };
}

/** Read a `plinth.tileset` zip File/Blob and decode it. */
export async function importTileset(
  file: Blob,
  decodePng: TilesetPngDecoder = canvasPngDecoder,
  warn?: (message: string) => void,
): Promise<ImportedTileset> {
  return importTilesetBytes(new Uint8Array(await file.arrayBuffer()), decodePng, warn);
}

// ── IndexedDB sprite store ────────────────────────────────────────────────────
//
// The decoded sprites are large, so only the manifest reference lives in the
// document; the sprites live here keyed by `TilesetRef.id`. When IndexedDB is
// unavailable (private-mode Safari), an in-memory fallback keeps the tileset for
// the session (it is lost on reload) rather than breaking rendering.

interface StoredSprite { width: number; height: number; data: Uint8ClampedArray }
interface StoredTileset { faces: Record<string, Record<string, StoredSprite>> }

const DB_NAME = 'plinth';
const STORE_NAME = 'tilesets';
const memoryStore = new Map<string, StoredTileset>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function serialize(sprites: TilesetSpriteSet): StoredTileset {
  const faces: StoredTileset['faces'] = {};
  for (const [slug, configs] of sprites) {
    const record: Record<string, StoredSprite> = {};
    for (const [id, image] of configs) record[id] = { width: image.width, height: image.height, data: image.data };
    faces[slug] = record;
  }
  return { faces };
}

function deserialize(stored: StoredTileset): TilesetSpriteSet {
  const sprites: TilesetSpriteSet = new Map();
  for (const [slug, configs] of Object.entries(stored.faces)) {
    const map = new Map<string, TilesetSpriteImage>();
    for (const [id, image] of Object.entries(configs)) {
      map.set(id, { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) });
    }
    sprites.set(slug, map);
  }
  return sprites;
}

/** Persist decoded sprites for a `TilesetRef.id`. Falls back to memory when IDB is absent. */
export async function saveTilesetSprites(id: string, sprites: TilesetSpriteSet): Promise<void> {
  const record = serialize(sprites);
  if (!hasIndexedDb()) { memoryStore.set(id, record); return; }
  try {
    await withStore('readwrite', (store) => store.put(record, id));
  } catch {
    memoryStore.set(id, record);
  }
}

/** Load decoded sprites for a `TilesetRef.id`, or null when none are stored. */
export async function loadTilesetSprites(id: string): Promise<TilesetSpriteSet | null> {
  if (hasIndexedDb()) {
    try {
      const stored = await withStore<StoredTileset | undefined>('readonly', (store) => store.get(id));
      if (stored) return deserialize(stored);
    } catch { /* fall through to memory */ }
  }
  const fallback = memoryStore.get(id);
  return fallback ? deserialize(fallback) : null;
}

/** Remove stored sprites for a `TilesetRef.id`. */
export async function deleteTilesetSprites(id: string): Promise<void> {
  memoryStore.delete(id);
  if (!hasIndexedDb()) return;
  try {
    await withStore('readwrite', (store) => store.delete(id));
  } catch { /* best effort */ }
}
