stdout:
;
// Feature 7 — rampart `.swatches` import: HSB swatches inside a stored ZIP.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hsbToHex, parseRampartFile, parseRampartPalette, resolveRamps, usedColors } from '../src/core/color';
import type { ColorSettings } from '../src/core/types';
import { createZip } from '../src/core/zip';

const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#000000', '#ffffff', '#406080', '#a1b2c3', '#123456', '#fedcba', '#0a0b0c'];
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** The RGB→HSB half of rampart's `hexToHsb`, so the fixtures do not reuse hsbToHex. */
function rgbToHsb(hex: string): [number, number, number] {
  const red = parseInt(hex.slice(1, 3), 16) / 255;
  const green = parseInt(hex.slice(3, 5), 16) / 255;
  const blue = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

function swatchesJson(name: string, hexColors: string[]): string {
  return JSON.stringify([{
    name,
    swatches: hexColors.map((hex) => {
      const [hue, saturation, brightness] = rgbToHsb(hex);
      return { hue: round6(hue / 360), saturation: round6(saturation), brightness: round6(brightness), alpha: 1, colorSpace: 0 };
    }),
  }]);
}

const swatchesBytes = (name: string, hexColors: string[]) =>
  createZip([{ name: 'Swatches.json', data: new TextEncoder().encode(swatchesJson(name, hexColors)) }]);

test('hsbToHex matches known HSB values', () => {
  assert.equal(hsbToHex(0, 1, 1), '#ff0000');
  assert.equal(hsbToHex(120, 1, 1), '#00ff00');
  assert.equal(hsbToHex(240, 1, 1), '#0000ff');
  assert.equal(hsbToHex(0, 0, 0), '#000000');
  assert.equal(hsbToHex(0, 0, 1), '#ffffff');
  assert.equal(hsbToHex(210, 0.5, 0.5), '#406080');
  assert.equal(hsbToHex(360, 1, 1), '#ff0000');
  assert.equal(hsbToHex(-120, 1, 1), '#0000ff');
});

test('a rampart .swatches ZIP imports as one palette, in order', () => {
  const palettes = parseRampartFile(swatchesBytes('Dusk', COLORS), 'Dusk.swatches');
  assert.equal(palettes.length, 1);
  assert.equal(palettes[0].source, 'rampart');
  assert.equal(palettes[0].name, 'Dusk');
  assert.deepEqual(palettes[0].colors, COLORS);
});

test('reading .swatches as text (the old code path) still fails loudly', () => {
  assert.throws(() => parseRampartPalette(new TextDecoder().decode(swatchesBytes('Dusk', COLORS))), /not valid JSON/);
});

test('the 30-colour Procreate cap is reported', () => {
  const many = Array.from({ length: 30 }, (_, index) => `#${((index * 8 + 1) % 256).toString(16).padStart(2, '0').repeat(3)}`);
  const warnings: string[] = [];
  const palettes = parseRampartFile(swatchesBytes('Big', many), 'Big.swatches', (message) => warnings.push(message));
  assert.equal(palettes[0].colors.length, 30);
  assert.ok(warnings.some((message) => message.includes('30-colour')), warnings.join('; '));
});

test('an archive without Swatches.json is rejected', () => {
  const other = createZip([{ name: 'notes.txt', data: new TextEncoder().encode('nothing here') }]);
  assert.throws(() => parseRampartFile(other, 'other.swatches'), /no Swatches\.json/);
});

test('a deflate-compressed .swatches fails with a clear message', () => {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(readFileSync('/mnt/data/pt/fixtures/deflated.swatches')); } catch { return; }
  assert.throws(() => parseRampartFile(bytes, 'deflated.swatches'), /unsupported zip compression method/);
});

test('a bare Swatches.json (not zipped) also imports', () => {
  const palettes = parseRampartFile(new TextEncoder().encode(swatchesJson('Bare', COLORS)), 'Bare.json');
  assert.deepEqual(palettes[0].colors, COLORS);
});

test('the JSON library export still imports through parseRampartFile', () => {
  const library = {
    application: 'rampart', formatVersion: 1, exportedAt: '2026-01-01',
    palettes: [{ id: 'x', name: 'Lib', createdAt: '', updatedAt: '', recipe: {}, hexColors: ['#101010', '#f0f0f0'] }],
  };
  assert.deepEqual(parseRampartFile(new TextEncoder().encode(JSON.stringify(library)), 'lib.json')[0].colors, ['#101010', '#f0f0f0']);
});

test('.gpl and .hex text exports import', () => {
  const gpl = ['GIMP Palette', 'Name: Gimp', 'Columns: 4', '#', ' 16  16  16\t101010', '240 240 240\tf0f0f0'].join('\n');
  const fromGpl = parseRampartFile(new TextEncoder().encode(gpl), 'Gimp.gpl');
  assert.equal(fromGpl[0].name, 'Gimp');
  assert.deepEqual(fromGpl[0].colors, ['#101010', '#f0f0f0']);
  const fromHex = parseRampartFile(new TextEncoder().encode(['101010', '#F0F0F0'].join('\n')), 'List.hex');
  assert.deepEqual(fromHex[0].colors, ['#101010', '#f0f0f0']);
});

test('unrecognised bytes fail loudly', () => {
  assert.throws(() => parseRampartFile(new TextEncoder().encode('this is not a palette'), 'x.txt'), /unrecognised palette file/);
});

test('swatchUse narrows the slots the ramps are built from', () => {
  const palette = { source: 'rampart' as const, name: 'P', colors: ['#000000', '#111111', '#222222', '#333333', '#ffffff'] };
  const base: ColorSettings = { enabled: true, assign: 'cycle' };
  assert.deepEqual(usedColors(palette, base), palette.colors);
  assert.deepEqual(resolveRamps(palette, base), [['#111111', '#222222', '#333333']]);

  const narrowed: ColorSettings = { ...base, rampSize: 2, swatchUse: { used: [0, 1, 2, 3] } };
  assert.deepEqual(usedColors(palette, narrowed), ['#000000', '#111111', '#222222', '#333333']);
  assert.deepEqual(resolveRamps(palette, narrowed), [['#111111', '#222222']]);

  assert.deepEqual(usedColors(palette, { ...base, swatchUse: { used: [] } }), palette.colors);
  assert.deepEqual(usedColors(palette, { ...base, swatchUse: { used: [99] } }), palette.colors);
});