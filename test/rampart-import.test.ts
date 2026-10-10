// Feature 7 — importing a rampart palette export. Pure-core tests: no DOM.
//
// Mirrors rampart's `mergeImportedJson` acceptance: a full library export, a
// bare `SavedPalette[]`, or a single `SavedPalette`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRampartPalette } from '../src/core/color';

const savedPalette = (name: string, hexColors: string[]) => ({
  id: name, name, createdAt: '', updatedAt: '', recipe: {}, hexColors,
});

const COLORS = ['#101010', '#303030', '#505050', '#707070', '#f0f0f0'];

test('parseRampartPalette accepts a LibraryExport, a bare array, and a single palette', () => {
  const library = { application: 'rampart', formatVersion: 1, exportedAt: '2026-01-01', palettes: [savedPalette('Dusk', COLORS)] };
  const fromLibrary = parseRampartPalette(JSON.stringify(library));
  assert.equal(fromLibrary.length, 1);
  assert.equal(fromLibrary[0].source, 'rampart');
  assert.equal(fromLibrary[0].name, 'Dusk');
  assert.deepEqual(fromLibrary[0].colors, COLORS);

  const fromArray = parseRampartPalette(JSON.stringify([savedPalette('A', COLORS), savedPalette('B', COLORS)]));
  assert.equal(fromArray.length, 2);
  assert.deepEqual(fromArray.map((palette) => palette.name), ['A', 'B']);

  const fromSingle = parseRampartPalette(JSON.stringify(savedPalette('Solo', COLORS)));
  assert.equal(fromSingle.length, 1);
  assert.equal(fromSingle[0].name, 'Solo');
});

test('parseRampartPalette preserves hexColors order and normalises case', () => {
  const parsed = parseRampartPalette(JSON.stringify(savedPalette('Ordered', ['#AABBCC', '#112233', '#445566'])));
  assert.deepEqual(parsed[0].colors, ['#aabbcc', '#112233', '#445566']);
});

test('parseRampartPalette rejects invalid hex and skips palettes without hexColors', () => {
  assert.throws(() => parseRampartPalette('{ not json'), /not valid JSON/);
  assert.throws(
    () => parseRampartPalette(JSON.stringify({ application: 'rampart', formatVersion: 1, palettes: [] })),
    /no usable palettes/,
  );
  assert.throws(() => parseRampartPalette(JSON.stringify(savedPalette('Bad', ['#12345']))), /invalid hex colour/);
  assert.throws(() => parseRampartPalette(JSON.stringify(savedPalette('Bad', ['red']))), /invalid hex colour/);

  const warnings: string[] = [];
  const parsed = parseRampartPalette(JSON.stringify([
    { id: 'x', name: 'NoColors', recipe: {} },
    savedPalette('Good', ['#000000', '#ffffff']),
  ]), (message) => warnings.push(message));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Good');
  assert.ok(warnings.some((message) => message.includes('NoColors')), warnings.join('; '));
});

test('parseRampartPalette warns on a non-rampart application but still reads hexColors', () => {
  const warnings: string[] = [];
  const parsed = parseRampartPalette(
    JSON.stringify({ application: 'other', formatVersion: 1, palettes: [savedPalette('P', ['#000000', '#ffffff'])] }),
    (message) => warnings.push(message),
  );
  assert.equal(parsed.length, 1);
  assert.ok(warnings.some((message) => message.includes('unexpected application')), warnings.join('; '));
});
