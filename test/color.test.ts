// Feature 7 — colour mapping and the PSD `Base color` layer. Pure-core tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorActive, colorForBand, rampCount, rampSize } from '../src/core/color';
import { composeColorImage, composeImage, composeLayers } from '../src/core/compose';
import { renderPrimitive } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, type ColorSettings, type Palette } from '../src/core/types';
import { makeObject } from './sample-scene';

const noFloor = { ...DEFAULT_RENDER_OPTIONS, showFloor: false, outlines: 'none' as const };

// Shared shadow, four ramp slots dark→light, shared highlight.
const palette: Palette = {
  source: 'rampart',
  name: 'Test',
  colors: ['#000000', '#3a1a1a', '#7a2a2a', '#b03a3a', '#e05a5a', '#ffffff'],
};
const settings: ColorSettings = { enabled: true, assign: 'cycle' };

const luminance = ([r, g, b]: readonly [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b;

test('composeColorImage writes non-grey RGB; top is lighter than the sides', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), noFloor);
  const image = composeColorImage(buffers, noFloor, DEFAULT_SETTINGS, palette, settings);
  const rgb = (x: number, y: number) => {
    const offset = (y * buffers.width + x) * 4;
    return [image[offset], image[offset + 1], image[offset + 2]] as const;
  };
  const top = rgb(16, 6), left = rgb(6, 22), right = rgb(26, 22);
  assert.ok(top[0] !== top[1], `expected non-grey, got ${top.join(',')}`);
  assert.ok(luminance(top) > luminance(left) && luminance(left) > luminance(right),
    `top ${top} left ${left} right ${right}`);
});

test('composeLayers adds a Base color layer under the greyscale trace layers', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), noFloor);
  const layers = composeLayers(buffers, noFloor, DEFAULT_SETTINGS, palette, settings);
  const names = layers.map((layer) => layer.name);
  assert.ok(names.includes('Base color'), names.join(','));
  assert.equal(names[0], 'Base color'); // bottom, above the (transparent) background
  assert.ok(names.includes('Level 0'), names.join(','));
});

test('with colour disabled the greyscale render is unchanged', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), noFloor);
  const grey = composeImage(buffers, noFloor, DEFAULT_SETTINGS);
  const layers = composeLayers(buffers, noFloor, DEFAULT_SETTINGS, palette, { ...settings, enabled: false });
  assert.ok(!layers.some((layer) => layer.name === 'Base color'));
  assert.deepEqual(composeImage(buffers, noFloor, DEFAULT_SETTINGS), grey);
});

test('colour is suppressed when a combinatorics set is imported', () => {
  assert.equal(colorActive({ palette, colorSettings: settings }), true);
  assert.equal(colorActive({
    palette,
    colorSettings: settings,
    combinatorics: { format: 'plinth.combinatorics', version: 1, scheme: 'iso-4', primitives: [] },
  }), false);
  assert.equal(colorActive({ palette, colorSettings: { ...settings, enabled: false } }), false);
  assert.equal(colorActive({ colorSettings: settings }), false);
});

test('ramp helpers: size defaults to the middle list, count divides it, bands map dark→light', () => {
  assert.equal(rampSize(palette, settings), 4);
  assert.equal(rampCount(palette, settings), 1);
  assert.equal(rampCount(palette, { ...settings, rampSize: 2 }), 2);
  const object = makeObject('block', 0, 0, 0);
  assert.equal(colorForBand(palette, settings, object, 0, 0), '#3a1a1a');
  assert.equal(colorForBand(palette, settings, object, 0, 1), '#e05a5a');
});
