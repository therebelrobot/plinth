// Feature 10 IMPORT half: manifest round-trip through the importer, open-corner
// adjacency → config lookup, per-pixel compositing with grey fallback, rotation at
// import, and a no-tileset regression guard.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeImage, type TilesetSpriteImage } from '../src/core/compose';
import { renderScene } from '../src/core/render';
import {
  TILESET_CONFIGS, analyseAdjacency8, buildTileset, buildTilesetPlacements, openCornerNormalize,
  validateTilesetManifest, type TilesetManifest, type TilesetSpriteSet,
} from '../src/core/tileset';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, type RenderOptions, type SceneDocument, type SceneObject } from '../src/core/types';
import { readZip, createZip } from '../src/core/zip';
import { exportTileset, importTilesetBytes } from '../src/lib/tileset';
import { decodePng, encodePng } from './png-node';

const OPTIONS: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, showFloor: false, showFloorGrid: false };

function block(x: number, y: number, id = `b${x}-${y}`): SceneObject {
  return { id, type: 'block', x, y, z: 0, width: 1, depth: 1, height: 1, rotation: 0 };
}

function singleBlockDocument(): SceneDocument {
  return { version: 1, name: 'tileset-test', settings: { ...DEFAULT_SETTINGS }, objects: [block(0, 0, 'a')] };
}

function sprite(fill: readonly [number, number, number, number], width = 32, height = 32): TilesetSpriteImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = fill[0]; data[index * 4 + 1] = fill[1];
    data[index * 4 + 2] = fill[2]; data[index * 4 + 3] = fill[3];
  }
  return { width, height, data };
}

function manifestFor(face: Partial<TilesetManifest['faces'][number]> & { slug: string; type: string }, template: Record<string, unknown>, sprites: Record<string, { anchorX: number; anchorY: number }>): TilesetManifest {
  return {
    format: 'plinth.tileset', version: 1, generator: 'plinth', exportedAt: '', scheme: 'open-corner-8',
    sides: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
    projection: { tileWidthPixels: DEFAULT_SETTINGS.tileWidthPixels, levelHeightPixels: DEFAULT_SETTINGS.levelHeightPixels },
    scale: 1,
    configs: TILESET_CONFIGS.map((config) => ({ ...config })),
    faces: [{
      slug: face.slug, type: face.type as SceneObject['type'],
      template: { type: template.type, width: template.width, depth: template.depth, height: template.height, rotation: 0, ...(template.parameter !== undefined ? { parameter: template.parameter } : {}) } as unknown as TilesetManifest['faces'][number]['template'],
      directional: face.directional === true,
      sprites: Object.fromEntries(Object.entries(sprites).map(([id, geometry]) => [id, { file: `tiles/${face.slug}/${id}.png`, width: 32, height: 32, ...geometry }])),
    }],
  };
}

test('open-corner enumeration is 47 and the empty mask is included', () => {
  assert.equal(TILESET_CONFIGS.length, 47);
  assert.ok(TILESET_CONFIGS.some((config) => config.mask === 0));
});

test('analyseAdjacency8 yields the expected open-corner config per tile', () => {
  const grid: SceneObject[] = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) grid.push(block(x, y));
  const { masks } = analyseAdjacency8(grid);
  // Centre tile (x=1,y=1 → index 4) has all four orthogonals → diagonals cleared → 0x55.
  assert.equal(openCornerNormalize(masks[4]), 0x55);
  // A lone tile has mask 0 → config c00.
  const lone = analyseAdjacency8([block(0, 0)]).masks[0];
  assert.equal(openCornerNormalize(lone), 0);
});

test('manifest round-trips through the zip importer', async () => {
  const build = await buildTileset(singleBlockDocument(), OPTIONS, 1, (_rgba, width, height) => {
    // Dummy PNG bytes that carry the dimensions the fake decoder reads back.
    return new Uint8Array([width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff]);
  }, { now: new Date('2026-01-01T00:00:00Z') });
  const zip = createZip(build.entries);
  assert.equal(readZip(zip).length, 48); // manifest + 47 configs

  const decode = async (bytes: Uint8Array) => {
    const width = bytes[0] | (bytes[1] << 8);
    const height = bytes[2] | (bytes[3] << 8);
    return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
  };
  const warnings: string[] = [];
  const imported = await importTilesetBytes(zip, decode, (message) => warnings.push(message));

  assert.equal(imported.ref.manifest.scheme, 'open-corner-8');
  assert.equal(imported.ref.manifest.faces.length, 1);
  assert.equal(warnings.length, 0);
  const face = imported.sprites.get(imported.ref.manifest.faces[0].slug)!;
  assert.equal(face.size, 47);
  assert.ok(face.has('c00'));
  assert.equal(face.get('c00')!.width, 32);
});

test('import rejects a bad manifest format', () => {
  assert.throws(() => validateTilesetManifest({ format: 'nope', version: 1, scheme: 'open-corner-8' }), /plinth\.tileset/);
  assert.throws(() => validateTilesetManifest({ format: 'plinth.tileset', version: 2, scheme: 'open-corner-8' }), /version/);
  assert.throws(() => validateTilesetManifest({ format: 'plinth.tileset', version: 1, scheme: 'classic' }), /scheme/);
});

test('opaque sprite pixels replace grey; transparent pixels fall back to grey', () => {
  const document = singleBlockDocument();
  const objects = document.objects;
  const buffers = renderScene(document.settings, objects, OPTIONS);

  const opaque = sprite([10, 20, 30, 255]);
  const manifest = manifestFor({ slug: 'block_1x1x1', type: 'block' }, { type: 'block', width: 1, depth: 1, height: 1 }, { c00: { anchorX: 16, anchorY: 16 } });
  const sprites: TilesetSpriteSet = new Map([['block_1x1x1', new Map([['c00', opaque]])]]);

  const placements = buildTilesetPlacements(objects, manifest, sprites);
  assert.ok(placements[0]);
  const withTileset = composeImage(buffers, OPTIONS, document.settings, { tileset: placements });

  let owned = 0;
  for (let index = 0; index < buffers.width * buffers.height; index++) {
    if (buffers.owner[index] < 0) continue;
    owned++;
    const offset = index * 4;
    assert.equal(withTileset[offset], 10, `pixel ${index} red`);
    assert.equal(withTileset[offset + 1], 20, `pixel ${index} green`);
    assert.equal(withTileset[offset + 2], 30, `pixel ${index} blue`);
  }
  assert.ok(owned > 0, 'the block covers some pixels');

  // A fully transparent sprite is a no-op: identical to the grey render.
  const transparent = sprite([10, 20, 30, 0]);
  const transparentPlacements = buildTilesetPlacements(objects, manifest, new Map([['block_1x1x1', new Map([['c00', transparent]])]]));
  const baseline = composeImage(buffers, OPTIONS, document.settings, {});
  assert.deepEqual(
    Array.from(composeImage(buffers, OPTIONS, document.settings, { tileset: transparentPlacements })),
    Array.from(baseline),
  );
});

test('a missing sprite falls back to grey (byte-identical to no tileset)', () => {
  const document = singleBlockDocument();
  const buffers = renderScene(document.settings, document.objects, OPTIONS);
  const manifest = manifestFor({ slug: 'block_1x1x1', type: 'block' }, { type: 'block', width: 1, depth: 1, height: 1 }, {});
  // Face present but no sprites stored, and an entirely absent face, both resolve to null.
  const emptyFace: TilesetSpriteSet = new Map([['block_1x1x1', new Map()]]);
  const noFace: TilesetSpriteSet = new Map();
  const baseline = Array.from(composeImage(buffers, OPTIONS, document.settings));
  assert.equal(buildTilesetPlacements(document.objects, manifest, emptyFace)[0], null);
  assert.equal(buildTilesetPlacements(document.objects, manifest, noFace)[0], null);
  assert.deepEqual(Array.from(composeImage(buffers, OPTIONS, document.settings, { tileset: buildTilesetPlacements(document.objects, manifest, emptyFace) })), baseline);
});

test('directional faces are rotated at import (non-square sprite swaps dimensions)', () => {
  const wall: SceneObject = { id: 'w', type: 'wall', x: 0, y: 0, z: 0, width: 1, depth: 2, height: 1, rotation: 0, parameter: 0.25 };
  const manifest = manifestFor({ slug: 'wall_1x2x1', type: 'wall', directional: true }, { type: 'wall', width: 1, depth: 2, height: 1, parameter: 0.25 }, { c00: { anchorX: 5, anchorY: 10 } });
  const image = sprite([1, 2, 3, 255], 10, 20);
  const sprites: TilesetSpriteSet = new Map([['wall_1x2x1', new Map([['c00', image]])]]);

  const upright = buildTilesetPlacements([wall], manifest, sprites)[0]!;
  assert.equal(upright.image.width, 10);
  assert.equal(upright.image.height, 20);
  assert.equal(upright.anchorX, 5);

  const turned = buildTilesetPlacements([{ ...wall, rotation: 1 }], manifest, sprites)[0]!;
  assert.equal(turned.image.width, 20);
  assert.equal(turned.image.height, 10);
  assert.equal(turned.anchorX, 10); // h - anchorY = 20 - 10
  assert.equal(turned.anchorY, 5);
});

test('export → import → compose round-trips real PNG bytes (Feature 10)', async () => {
  const document = singleBlockDocument();

  // Export with the real node:zlib PNG encoder (not a fake).
  const { blob, manifest } = await exportTileset(document, OPTIONS, 1, encodePng, new Date('2026-01-01T00:00:00Z'));
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // Import with the real PNG decoder (parses IHDR/IDAT, inflates, un-filters).
  const warnings: string[] = [];
  const imported = await importTilesetBytes(bytes, async (data) => decodePng(data), (message) => warnings.push(message));
  assert.deepEqual(warnings, []);

  // The decoder read the real IHDR: dimensions match the manifest's declaration.
  const face = imported.ref.manifest.faces[0];
  const declared = face.sprites.c00;
  const decoded = imported.sprites.get(face.slug)!.get('c00')!;
  assert.equal(decoded.width, declared.width);
  assert.equal(decoded.height, declared.height);
  assert.equal(decoded.width, manifest.faces[0].sprites.c00.width);

  // The exported sprite is a grey template with opaque pixels.
  let opaque = 0;
  for (let index = 0; index < decoded.width * decoded.height; index++) {
    if (decoded.data[index * 4 + 3] === 0) continue;
    opaque++;
    assert.equal(decoded.data[index * 4], decoded.data[index * 4 + 1]);
    assert.equal(decoded.data[index * 4 + 1], decoded.data[index * 4 + 2]);
  }
  assert.ok(opaque > 0, 'the exported sprite has opaque pixels');

  // Compose the imported tileset over the scene: the sprite replaces grey on owned
  // pixels and leaves the background untouched.
  const buffers = renderScene(document.settings, document.objects, OPTIONS);
  const placements = buildTilesetPlacements(document.objects, imported.ref.manifest, imported.sprites);
  const composed = composeImage(buffers, OPTIONS, document.settings, { tileset: placements });
  const baseline = composeImage(buffers, OPTIONS, document.settings, {});

  let changed = 0;
  for (let index = 0; index < buffers.width * buffers.height; index++) {
    const offset = index * 4;
    const same = composed[offset] === baseline[offset]
      && composed[offset + 1] === baseline[offset + 1]
      && composed[offset + 2] === baseline[offset + 2]
      && composed[offset + 3] === baseline[offset + 3];
    if (buffers.owner[index] < 0) assert.ok(same, `background pixel ${index} is unchanged`);
    else if (!same) changed++;
  }
  assert.ok(changed > 0, 'the imported sprite changed at least one owned pixel');
});

test('a sprite whose PNG size disagrees with the manifest is skipped with a warning', async () => {
  const manifest = manifestFor({ slug: 'block_1x1x1', type: 'block' }, { type: 'block', width: 1, depth: 1, height: 1 }, { c00: { anchorX: 16, anchorY: 16 } });
  const zip = createZip([
    { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
    { name: 'tiles/block_1x1x1/c00.png', data: new Uint8Array([0]) },
  ]);
  const warnings: string[] = [];
  // The manifest declares 32×32; the decoder returns 16×16 → mismatch → skip.
  const decode = async () => ({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) });
  const imported = await importTilesetBytes(zip, decode, (message) => warnings.push(message));
  assert.equal(imported.sprites.get('block_1x1x1')!.size, 0);
  assert.ok(warnings.some((message) => /size does not match/.test(message)), 'a size-mismatch warning is emitted');
});
