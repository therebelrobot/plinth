// Feature 7 — colour mapping and the PSD `Base color` layer. Pure-core tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorActive, colorForBand, hexToRgb, rampCount, rampSize, valueBands } from '../src/core/color';
import { composeColorImage, composeImage, composeLayers } from '../src/core/compose';
import { renderPrimitive, renderScene } from '../src/core/render';
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
  assert.equal(colorForBand(palette, settings, object, 0, 0, DEFAULT_RENDER_OPTIONS.bands), '#3a1a1a');
  assert.equal(colorForBand(palette, settings, object, 0, 1, DEFAULT_RENDER_OPTIONS.bands), '#e05a5a');
});

// Viewport regression guard: colour mode must keep the editor selection tint,
// and exporters (which pass no highlight) must stay byte-identical.
test('composeColorImage highlight tints only the selected object', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), noFloor);
  const base = composeColorImage(buffers, noFloor, DEFAULT_SETTINGS, palette, settings);
  const accent = [255, 122, 61] as const;
  const tinted = composeColorImage(buffers, noFloor, DEFAULT_SETTINGS, palette, settings, undefined, {
    highlightOwner: 0,
    highlightColor: accent,
  });
  const pixel = (image: Uint8ClampedArray, x: number, y: number) => {
    const offset = (y * buffers.width + x) * 4;
    return [image[offset], image[offset + 1], image[offset + 2]] as const;
  };
  const before = pixel(base, 16, 6), after = pixel(tinted, 16, 6);
  const expected = before.map((channel, channelIndex) => (channel * 0.45 + accent[channelIndex] * 0.55) | 0);
  assert.deepEqual([...after], expected);
  assert.ok(after[0] > before[0], `expected red to rise: ${before} → ${after}`);
  // A pixel not owned by the highlighted object (empty background) is untouched.
  assert.deepEqual(pixel(tinted, 0, 0), pixel(base, 0, 0));
});

// Feature 7 follow-up — Outline and Floor are chosen from the imported swatches
// and stored as a hex in `colorSettings`, so the composed colour must be exactly
// that swatch hex. These guard the data-model contract the swatch grid relies on.
test('outline colour comes from the chosen swatch hex', () => {
  const options = { ...DEFAULT_RENDER_OPTIONS, outlines: 'all' as const, showFloor: false };
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), options);
  const chosen = palette.colors[3]; // '#b03a3a' — a slot the user can click
  const other = palette.colors[4];
  const a = composeColorImage(buffers, options, DEFAULT_SETTINGS, palette, { ...settings, outlineColor: chosen });
  const b = composeColorImage(buffers, options, DEFAULT_SETTINGS, palette, { ...settings, outlineColor: other });
  const [r, g, blue] = hexToRgb(chosen);
  let changed = 0, matched = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      changed++;
      if (a[i] === r && a[i + 1] === g && a[i + 2] === blue) matched++;
    }
  }
  assert.ok(changed > 0, 'expected the outline colour to change pixels');
  assert.equal(matched, changed, 'every outline pixel should be the chosen swatch hex');
});

test('floor colour comes from the chosen swatch hex', () => {
  // The floor is scene-level: `renderPrimitive` rasterises only the object, so
  // this must go through `renderScene`.
  const options = { ...DEFAULT_RENDER_OPTIONS, outlines: 'none' as const, showFloor: true, showFloorGrid: false };
  const buffers = renderScene(DEFAULT_SETTINGS, [makeObject('block', 0, 0, 0)], options);
  const chosen = palette.colors[5]; // '#ffffff' — a swatch the ramps never paint
  const other = palette.colors[3];
  const present = (image: Uint8ClampedArray, hex: string) => {
    const [r, g, blue] = hexToRgb(hex);
    for (let i = 0; i < image.length; i += 4) {
      if (image[i] === r && image[i + 1] === g && image[i + 2] === blue) return true;
    }
    return false;
  };
  const a = composeColorImage(buffers, options, DEFAULT_SETTINGS, palette, { ...settings, floorColor: chosen });
  const b = composeColorImage(buffers, options, DEFAULT_SETTINGS, palette, { ...settings, floorColor: other });
  assert.ok(present(a, chosen), 'expected the chosen floor swatch to paint the floor');
  assert.ok(!present(b, chosen), 'the unchosen swatch should not appear');
});

// Feature 7 follow-up — the explicit value → colour map (`colorMode: 'bands'`).
// `valueBands` must reproduce the object greys the colour path actually paints.
test('valueBands(4) is the exact object greys and matches the rendered pixels', () => {
  assert.deepEqual(valueBands(4), ['#404040', '#787878', '#b0b0b0', '#e8e8e8']);
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), noFloor);
  const image = composeImage(buffers, noFloor, DEFAULT_SETTINGS);
  const allowed = new Set(valueBands(4).map((hex) => hexToRgb(hex)[0]));
  for (let i = 0; i < image.length; i += 4) {
    if (image[i + 3] === 0) continue; // transparent background
    assert.ok(allowed.has(image[i]), `grey ${image[i]} is not a value band`);
  }
});

test('colorMode bands maps each band to the chosen hex regardless of object/assign/rampSize', () => {
  const bandColors = ['#111111', '#222222', '#333333', '#444444'];
  const banded: ColorSettings = { ...settings, colorMode: 'bands', bandColors, assign: 'byLevel', rampSize: 2 };
  const object = makeObject('block', 0, 0, 0);
  for (let band = 0; band < 4; band++) {
    assert.equal(colorForBand(palette, banded, object, 0, band / 3, 4), bandColors[band]);
  }
  // A different object and index still resolve by band, not by ramp.
  const other = makeObject('wall', 1, 1, 2);
  assert.equal(colorForBand(palette, banded, other, 3, 0, 4), bandColors[0]);
});

test('a short bandColors falls back to positional derivation for the missing bands only', () => {
  const banded: ColorSettings = { ...settings, colorMode: 'bands', bandColors: ['#111111'] };
  const object = makeObject('block', 0, 0, 0);
  assert.equal(colorForBand(palette, banded, object, 0, 0, 4), '#111111'); // mapped
  assert.equal(colorForBand(palette, banded, object, 0, 1 / 3, 4), '#7a2a2a'); // ramp fallback
  assert.equal(colorForBand(palette, banded, object, 0, 2 / 3, 4), '#b03a3a');
  assert.equal(colorForBand(palette, banded, object, 0, 1, 4), '#e05a5a');
});

test('colorMode absent or ramps is byte-identical to the ramp path', () => {
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), noFloor);
  const base = composeColorImage(buffers, noFloor, DEFAULT_SETTINGS, palette, settings);
  const ramps = composeColorImage(buffers, noFloor, DEFAULT_SETTINGS, palette, { ...settings, colorMode: 'ramps' });
  const emptyMap = composeColorImage(buffers, noFloor, DEFAULT_SETTINGS, palette, { ...settings, colorMode: 'bands', bandColors: [] });
  const ignoredMap = composeColorImage(buffers, noFloor, DEFAULT_SETTINGS, palette, { ...settings, bandColors: ['#111111'] });
  assert.deepEqual(ramps, base);
  assert.deepEqual(emptyMap, base);
  assert.deepEqual(ignoredMap, base);
});

test('outline overrides still win under colorMode bands', () => {
  const options = { ...DEFAULT_RENDER_OPTIONS, outlines: 'all' as const, showFloor: false };
  const buffers = renderPrimitive(DEFAULT_SETTINGS, makeObject('block', 0, 0, 0), options);
  const chosen = palette.colors[3]; // '#b03a3a'
  const banded: ColorSettings = {
    ...settings,
    colorMode: 'bands',
    bandColors: ['#111111', '#222222', '#333333', '#444444'],
    outlineColor: chosen,
  };
  const image = composeColorImage(buffers, options, DEFAULT_SETTINGS, palette, banded);
  const [r, g, b] = hexToRgb(chosen);
  let outlinePixels = 0;
  for (let i = 0; i < image.length; i += 4) {
    if (image[i] === r && image[i + 1] === g && image[i + 2] === b) outlinePixels++;
  }
  assert.ok(outlinePixels > 0, 'expected the chosen outline hex to paint outline pixels');
});

test('colorActive suppresses the band map when a combinatorics set is present', () => {
  const banded: ColorSettings = { ...settings, colorMode: 'bands', bandColors: ['#111111'] };
  assert.equal(colorActive({ palette, colorSettings: banded }), true);
  assert.equal(colorActive({
    palette,
    colorSettings: banded,
    combinatorics: { format: 'plinth.combinatorics', version: 1, scheme: 'iso-4', primitives: [] },
  }), false);
});
