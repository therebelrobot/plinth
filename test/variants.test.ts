import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTIONAL_TYPES, LEVEL_CHANGING_TYPES, PRIMITIVE_PRESETS, TALL_VARIANTS, baseHeight } from '../src/core/primitives';
import { renderPrimitive, renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, type PrimitiveType } from '../src/core/types';
import { makeObject } from './sample-scene';

const noFloor = { ...DEFAULT_RENDER_OPTIONS, showFloor: false };
const levelChanging: PrimitiveType[] = ['ramp', 'stairs', 'pyramid', 'cone'];

test('level-changing types are exactly ramp, stairs, pyramid and cone', () => {
  assert.deepEqual([...LEVEL_CHANGING_TYPES].sort(), [...levelChanging].sort());
});

test('covered pixels increase monotonically with tallness for every level-changing type', () => {
  for (const type of levelChanging) {
    const counts = TALL_VARIANTS.map((tallness) => {
      const object = makeObject(type, 0, 0, 0, 1, 1, baseHeight(type) * tallness, 0, type === 'stairs' ? 4 : undefined);
      const buffers = renderPrimitive(DEFAULT_SETTINGS, object, noFloor);
      return buffers.owner.filter((owner) => owner === 0).length;
    });
    for (let index = 1; index < counts.length; index++) {
      assert.ok(counts[index] > counts[index - 1], `${type} coverage ${counts.join(' < ')}`);
    }
  }
});

test('a ramp top row rises by one level height per level of tallness', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 2, floorTilesY: 2, paddingPixels: 0 };
  const firstRow = (height: number) => {
    const buffers = renderScene(settings, [makeObject('ramp', 0, 0, 0, 1, 1, height)], noFloor);
    for (let y = 0; y < buffers.height; y++) {
      if (buffers.owner.subarray(y * buffers.width, (y + 1) * buffers.width).some((owner) => owner >= 0)) return y;
    }
    return -1;
  };
  const one = firstRow(1);
  const two = firstRow(2);
  assert.ok(Math.abs((one - two) - settings.levelHeightPixels) <= 1, `1× ${one}, 2× ${two}`);
});

test('stairs risers scale with height at a fixed step count', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 2, floorTilesY: 2, paddingPixels: 0 };
  const firstRow = (height: number) => {
    const buffers = renderScene(settings, [makeObject('stairs', 0, 0, 0, 1, 1, height, 0, 4)], noFloor);
    for (let y = 0; y < buffers.height; y++) {
      if (buffers.owner.subarray(y * buffers.width, (y + 1) * buffers.width).some((owner) => owner >= 0)) return y;
    }
    return -1;
  };
  const one = firstRow(1);
  const two = firstRow(2);
  assert.ok(Math.abs((one - two) - settings.levelHeightPixels) <= 1, `1× ${one}, 2× ${two}`);
});

test('every level-changing base preset has exactly four tall variants', () => {
  for (const type of levelChanging) {
    const variants = PRIMITIVE_PRESETS.filter((preset) => preset.type === type);
    assert.equal(variants.length, TALL_VARIANTS.length, type);
    assert.deepEqual(variants.map((preset) => preset.tallness).sort((a, b) => a - b), [...TALL_VARIANTS]);
    const base = variants.find((preset) => preset.tallness === 1)!;
    assert.equal(base.height, baseHeight(type));
    assert.equal(base.key, type);
  }
});

test('non-level-changing types are not expanded into variants', () => {
  for (const type of ['block', 'wall', 'cylinder', 'sphere', 'arch'] as PrimitiveType[]) {
    const presets = PRIMITIVE_PRESETS.filter((preset) => preset.type === type);
    assert.ok(presets.length > 0, type);
    assert.ok(presets.every((preset) => preset.tallness === 1), type);
  }
});

test('kit sprite names are unique across every preset and rotation', () => {
  const seen = new Set<string>();
  for (const preset of PRIMITIVE_PRESETS) {
    const rotations = DIRECTIONAL_TYPES.has(preset.type) ? [0, 1, 2, 3] : [0];
    for (const rotation of rotations) {
      const name = `${preset.key}_r${rotation}`;
      assert.ok(!seen.has(name), `duplicate sprite ${name}`);
      seen.add(name);
    }
  }
});
