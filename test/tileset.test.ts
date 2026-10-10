import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rotateMask8 } from '../src/core/combinatorics';
import { renderPrimitive } from '../src/core/render';
import {
  TILESET_CONFIG_COUNT,
  TILESET_CONFIGS,
  analyseAdjacency8,
  canonicalTilesetMask,
  openCornerNormalize,
  openCorners,
  parseTilesetManifest,
  suppressOpenEdges,
} from '../src/core/tileset';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, newDocument, type SceneObject } from '../src/core/types';
import { readZip } from '../src/core/zip';
import { exportTileset } from '../src/lib/tileset';
import { encodePng } from './png-node';

const encode: (rgba: Uint8ClampedArray, width: number, height: number) => Uint8Array =
  (rgba, width, height) => new Uint8Array(encodePng(rgba, width, height));

const block = (x: number, y: number, id: string): SceneObject =>
  ({ id, type: 'block', x, y, z: 0, width: 1, depth: 1, height: 1, rotation: 0 });

const popcount = (value: number): number => value.toString(2).split('1').length - 1;

test('tileset enumerates exactly 47 open-corner configs', () => {
  assert.equal(TILESET_CONFIG_COUNT, 47);
  assert.equal(TILESET_CONFIGS.length, 47);

  const normalized = new Set<number>();
  for (let mask = 0; mask < 256; mask++) normalized.add(openCornerNormalize(mask));
  assert.equal(normalized.size, 47);

  // 1·16 + 4·4 + 4·2 + 2·1 + 4·1 + 1·1 — grouped by orthogonal popcount.
  const distribution: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const config of TILESET_CONFIGS) distribution[popcount(config.ortho)]++;
  assert.deepEqual(distribution, { 0: 16, 1: 16, 2: 10, 3: 4, 4: 1 });

  // The empty tile is one of the 47 and is named c00.
  assert.ok(TILESET_CONFIGS.some((config) => config.mask === 0 && config.id === 'c00'));
});

test('openCornerNormalize keeps a diagonal only at an open corner', () => {
  // Normalization only clears diagonals; the empty mask already satisfies the rule.
  assert.equal(openCornerNormalize(0), 0);
  // All orthogonals present → no corner open → diagonals cleared.
  assert.equal(openCornerNormalize(0xff), 0b01010101);
  // N + NE + E: NE is an inner corner (both flanking orthogonals present) → cleared.
  assert.equal(openCornerNormalize(0b00000111), 0b00000101);

  assert.deepEqual(openCorners(0), ['NE', 'SE', 'SW', 'NW']);
  assert.deepEqual(openCorners(0b00000101), ['SW']); // N + E present → only the far SW corner is open
});

test('the open-corner rule is rotation-equivariant under quarter turns', () => {
  // rotateMask8 counts eighth turns, so quarter turns are 2, 4, 6 — the grid's
  // actual symmetries (a 45° step maps orthogonals onto diagonals, which is not
  // a symmetry of the square grid).
  for (const rotation of [0, 2, 4, 6]) {
    for (let mask = 0; mask < 256; mask++) {
      assert.equal(
        openCornerNormalize(rotateMask8(mask, rotation)),
        rotateMask8(openCornerNormalize(mask), rotation),
      );
    }
  }
  // canonicalTilesetMask picks the smallest quarter-turn rotation and is stable.
  const canonical = canonicalTilesetMask(openCornerNormalize(0b00000010));
  assert.equal(canonicalTilesetMask(rotateMask8(canonical, 2)), canonical);
});

test('analyseAdjacency8 adds diagonals on a 3×3 block grid', () => {
  const grid: SceneObject[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.push(block(x, y, `${x}-${y}`));
  const { masks } = analyseAdjacency8(grid);
  const at = (x: number, y: number): number => masks[y * 3 + x];
  assert.equal(at(1, 1), 0xff);
  // Corner (0,0): E (bit2) + SE (bit3) + S (bit4).
  assert.equal(at(0, 0), 0b00011100);
  // Top-middle (1,0): E + W + SE + S + SW.
  assert.equal(at(1, 0), 0b01111100);
});

test('manifest round-trips and rejects the wrong header', async () => {
  const document = newDocument('Tiles');
  document.objects = [block(0, 0, 'a')];
  const { manifest } = await exportTileset(document, DEFAULT_RENDER_OPTIONS, 1, encode, new Date('2026-10-10T00:00:00.000Z'));
  assert.equal(manifest.scheme, 'open-corner-8');
  assert.equal(manifest.configs.length, 47);
  assert.equal(manifest.faces.length, 1);
  assert.equal(Object.keys(manifest.faces[0].sprites).length, 47);

  const round = parseTilesetManifest(JSON.stringify(manifest));
  assert.deepEqual(round, manifest);

  assert.throws(() => parseTilesetManifest(JSON.stringify({ ...manifest, format: 'other' })));
  assert.throws(() => parseTilesetManifest(JSON.stringify({ ...manifest, version: 2 })));
  assert.throws(() => parseTilesetManifest(JSON.stringify({ ...manifest, scheme: 'blob-8' })));
});

test('exportTileset produces a zip with manifest.json + 47 PNGs per face', async () => {
  const document = newDocument('Tiles');
  document.objects = [
    block(0, 0, 'a'),
    block(1, 0, 'b'), // same face as 'a'
    { id: 'w', type: 'wall', x: 0, y: 2, z: 0, width: 1, depth: 1, height: 2, rotation: 0, parameter: 0.25 },
  ];
  const { blob, filename, manifest } = await exportTileset(document, DEFAULT_RENDER_OPTIONS, 1, encode);
  assert.match(filename, /^plinth-tileset_32px\.zip$/);
  assert.equal(manifest.faces.length, 2);

  const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(entries.length, 1 + 2 * 47);
  const names = new Set(entries.map((entry) => entry.name));
  assert.ok(names.has('manifest.json'));
  for (const face of manifest.faces) {
    for (const sprite of Object.values(face.sprites)) assert.ok(names.has(sprite.file), sprite.file);
  }

  const png = entries.find((entry) => entry.name.endsWith('/c00.png'))!;
  assert.deepEqual([...png.data.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // The manifest in the zip matches the returned one.
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')!;
  assert.deepEqual(parseTilesetManifest(new TextDecoder().decode(manifestEntry.data)), manifest);
});

test('open edges are un-outlined (isolated tile has fewer outline pixels than fully joined)', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, block(0, 0, 'a'), DEFAULT_RENDER_OPTIONS);
  const count = (outline: Uint8Array): number => outline.reduce((total, value) => total + (value ? 1 : 0), 0);
  const isolated = count(suppressOpenEdges(buffers, 0));
  const joined = count(suppressOpenEdges(buffers, 0b01010101));
  assert.ok(isolated < joined, `isolated=${isolated}, joined=${joined}`);
});
