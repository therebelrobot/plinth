stdout:
;
// Feature 7 follow-up — the PSD cutaway layer stack.
//
// The stack must reproduce the editor's cutaway exactly: compositing the layers
// up to cut `k` must be byte-identical to rendering with `hideAboveLevel = k`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeColorImage, composeCutawayLayers, composeImage, composeLayers } from '../src/core/compose';
import { OWNER_NONE, renderScene } from '../src/core/render';
import {
  DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS,
  type RenderOptions, type SceneObject, type SceneSettings,
} from '../src/core/types';

const settings: SceneSettings = { ...DEFAULT_SETTINGS, floorTilesX: 4, floorTilesY: 4, levelCount: 4 };
const options: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, background: 'transparent' };
const noFloor: RenderOptions = { ...options, showFloor: false, showFloorGrid: false };

function block(id: string, x: number, y: number, z: number, height = 1): SceneObject {
  return { id, type: 'block', x, y, z, width: 1, depth: 1, height, rotation: 0 };
}

// `b` sits directly on `a`, so it takes over pixels `a` would otherwise show.
const stacked: SceneObject[] = [block('a', 0, 0, 0), block('b', 0, 0, 1), block('c', 2, 1, 0)];

/** Straight-alpha "over" compositing, mirroring psd.ts's flatten(). */
function compositeOver(layers: Uint8ClampedArray[]): Uint8ClampedArray {
  const output = new Uint8ClampedArray(layers[0].length);
  for (const layer of layers) {
    for (let index = 0; index < layer.length; index += 4) {
      const alpha = layer[index + 3] / 255;
      if (alpha === 0) continue;
      for (let channel = 0; channel < 3; channel++) {
        output[index + channel] = alpha === 1
          ? layer[index + channel]
          : Math.round(layer[index + channel] * alpha + output[index + channel] * (1 - alpha));
      }
      output[index + 3] = Math.max(output[index + 3], layer[index + 3]);
    }
  }
  return output;
}

function opaqueCount(rgba: Uint8ClampedArray): number {
  let count = 0;
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index] > 0) count++;
  return count;
}

test('every cutaway prefix composites to exactly the viewer cutaway at that level', () => {
  const layers = composeCutawayLayers(settings, stacked, options);
  assert.deepEqual(layers.map((layer) => layer.name), ['Cutaway · level 0', 'Cutaway · level 1']);
  layers.forEach((_, cut) => {
    const pixels = compositeOver(layers.slice(0, cut + 1).map((layer) => layer.rgba));
    const expected = composeImage(renderScene(settings, stacked, { ...options, hideAboveLevel: cut }), options, settings);
    assert.deepEqual(pixels, expected, `prefix through cut ${cut} must equal hideAboveLevel=${cut}`);
  });
});

test('hiding the top layer reveals the surface underneath instead of a hole', () => {
  const at0 = renderScene(settings, stacked, { ...noFloor, hideAboveLevel: 0 });
  const at1 = renderScene(settings, stacked, { ...noFloor, hideAboveLevel: 1 });
  let index = -1;
  for (let i = 0; i < at0.owner.length; i++) {
    if (at0.owner[i] !== at1.owner[i] && at0.owner[i] !== OWNER_NONE && at1.owner[i] !== OWNER_NONE) { index = i; break; }
  }
  assert.ok(index >= 0, 'the stacked block must take over pixels from the block below it');

  // Old behaviour: winner-take-all layers leave a transparent hole behind.
  const legacy = composeLayers(at1, noFloor, settings);
  const upper = legacy.findIndex((layer) => layer.name === 'Level 1');
  assert.ok(upper > 0, `expected a Level 1 layer, got ${legacy.map((layer) => layer.name).join(', ')}`);
  const legacyHidden = compositeOver(legacy.slice(0, upper).map((layer) => layer.rgba));
  assert.equal(legacyHidden[index * 4 + 3], 0, 'the old layer stack leaves a hole where the upper level was');

  // Fixed behaviour: the cutaway prefix is the render with the upper level removed.
  const cutaway = composeCutawayLayers(settings, stacked, noFloor);
  const cutawayHidden = compositeOver(cutaway.slice(0, 1).map((layer) => layer.rgba));
  const expected = composeImage(at0, noFloor, settings);
  assert.equal(cutawayHidden[index * 4 + 3], 255, 'the cutaway stack must reveal the lower surface');
  assert.equal(cutawayHidden[index * 4], expected[index * 4]);
  assert.equal(cutawayHidden[index * 4 + 1], expected[index * 4 + 1]);
  assert.equal(cutawayHidden[index * 4 + 2], expected[index * 4 + 2]);
});

test('upper cutaway layers are differences, not full renders', () => {
  const layers = composeCutawayLayers(settings, stacked, options);
  const full = composeImage(renderScene(settings, stacked, options), options, settings);
  assert.ok(opaqueCount(layers[1].rgba) > 0, 'cut level 1 must hold the pixels it newly reveals');
  assert.ok(opaqueCount(layers[1].rgba) < opaqueCount(full), 'a cut layer must be a difference, not the whole scene');
});

test('layer count follows base levels, not object height', () => {
  const layers = composeCutawayLayers(settings, [block('tall', 0, 0, 0, 3)], options);
  assert.deepEqual(layers.map((layer) => layer.name), ['Cutaway · level 0']);
});

test('a non-transparent background becomes one opaque layer under the stack', () => {
  const layers = composeCutawayLayers(settings, stacked, { ...options, background: 'white' });
  assert.equal(layers[0].name, 'Background');
  assert.equal(opaqueCount(layers[0].rgba), layers[0].rgba.length / 4);
  assert.equal(layers[1].name, 'Cutaway · level 0');
  assert.deepEqual(
    compositeOver(layers.slice(1, 2).map((layer) => layer.rgba)),
    composeImage(renderScene(settings, stacked, { ...options, hideAboveLevel: 0 }), options, settings),
  );
});

test('a single-level scene produces one layer equal to the full render', () => {
  const flat = [block('a', 0, 0, 0), block('b', 2, 1, 0)];
  const layers = composeCutawayLayers(settings, flat, options);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].rgba, composeImage(renderScene(settings, flat, options), options, settings));
});

test('the colour path composes the same cutaway stack', () => {
  const palette = { source: 'rampart' as const, name: 'Test', colors: ['#101010', '#303030', '#707070', '#f0f0f0'] };
  const colorSettings = { enabled: true, assign: 'cycle' as const };
  const layers = composeCutawayLayers(settings, stacked, options, undefined, palette, colorSettings);
  assert.deepEqual(layers.map((layer) => layer.name), ['Cutaway · level 0', 'Cutaway · level 1']);
  layers.forEach((_, cut) => {
    const pixels = compositeOver(layers.slice(0, cut + 1).map((layer) => layer.rgba));
    const expected = composeColorImage(renderScene(settings, stacked, { ...options, hideAboveLevel: cut }), options, settings, palette, colorSettings);
    assert.deepEqual(pixels, expected, `colour prefix through cut ${cut} must equal the hideAboveLevel=${cut} render`);
  });
});

test('the legacy per-level layer set is unchanged', () => {
  const legacy = composeLayers(renderScene(settings, stacked, options), options, settings);
  assert.deepEqual(legacy.map((layer) => layer.name), ['Floor', 'Floor grid', 'Level 0', 'Level 1', 'Outlines']);
});