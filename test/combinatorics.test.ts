import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SIDES, SIDES_8, blobNormalize, buildCombinatorics, canonicalCombinations, rotateMask, rotateMask8,
} from '../src/core/combinatorics';
import { DEFAULT_SETTINGS, newDocument, type PrimitiveType } from '../src/core/types';
import { sampleObjects } from './sample-scene';

test('rotateMask is a cyclic left rotation and four applications are the identity', () => {
  assert.equal(rotateMask(1, 0), 1);
  assert.equal(rotateMask(1, 1), 2); // N → E
  assert.equal(rotateMask(1, 2), 4); // N → S
  assert.equal(rotateMask(1, 3), 8); // N → W
  assert.equal(rotateMask(9, 1), 3); // N+W → N+E
  for (let mask = 0; mask < 16; mask++) {
    let rotated = mask;
    for (let i = 0; i < 4; i++) rotated = rotateMask(rotated, 1);
    assert.equal(rotated, mask, `mask ${mask}`);
  }
});

test('canonicalisation of all 16 masks partitions them into 1+4+2+4+4+1', () => {
  const combinations = canonicalCombinations('iso-4');
  const byId = new Map(combinations.map((combination) => [combination.id, combination]));
  assert.deepEqual([...byId.keys()], ['single', 'end', 'straight', 'corner', 'tee', 'center']);
  assert.equal(byId.get('single')!.rotations.length, 1);
  assert.equal(byId.get('end')!.rotations.length, 4);
  assert.equal(byId.get('straight')!.rotations.length, 2);
  assert.equal(byId.get('corner')!.rotations.length, 4);
  assert.equal(byId.get('tee')!.rotations.length, 4);
  assert.equal(byId.get('center')!.rotations.length, 1);

  // Every mask 0..15 appears exactly once across all rotation lists.
  const covered = combinations.flatMap((combination) => combination.rotations.map((rotation) => rotation.mask));
  assert.equal(covered.length, 16);
  assert.deepEqual([...covered].sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index));
});

test('center, edge (straight) and corner are always present; corner has four rotations', () => {
  const combinations = canonicalCombinations('iso-4');
  const ids = combinations.map((combination) => combination.id);
  assert.ok(ids.includes('center'));
  assert.ok(ids.includes('straight')); // `edge` is an alias of `straight`
  assert.ok(ids.includes('corner'));
  const corner = combinations.find((combination) => combination.id === 'corner')!;
  assert.equal(corner.mask, 3); // numerically smallest of {3, 6, 9, 12}
  assert.deepEqual(corner.rotations.map((rotation) => rotation.mask), [3, 6, 12, 9]);
});

test('buildCombinatorics emits one entry per distinct template, covering every scene type', () => {
  const document = { ...newDocument('sample'), objects: sampleObjects() };
  const payload = buildCombinatorics(document, { now: new Date('2026-10-09T22:00:00.000Z') });

  const sceneTypes = new Set<PrimitiveType>(document.objects.map((object) => object.type));
  const emittedTypes = new Set(payload.primitives.map((primitive) => primitive.type));
  assert.deepEqual([...emittedTypes].sort(), [...sceneTypes].sort());

  // Keyed by full template: no two entries share a template.
  const keys = payload.primitives.map((primitive) => {
    const { type, width, depth, height, parameter } = primitive.template;
    return `${type}|${width}|${depth}|${height}|${parameter ?? ''}`;
  });
  assert.equal(new Set(keys).size, keys.length);

  // Every template corresponds to a real object and is emitted at rotation 0.
  for (const primitive of payload.primitives) {
    assert.equal(primitive.template.rotation, 0);
    assert.ok(document.objects.some((object) =>
      object.type === primitive.template.type &&
      object.width === primitive.template.width &&
      object.depth === primitive.template.depth &&
      object.height === primitive.template.height &&
      object.parameter === primitive.template.parameter));
  }

  // Directional flag follows DIRECTIONAL_TYPES.
  assert.equal(payload.primitives.find((primitive) => primitive.type === 'wall')!.directional, true);
  assert.equal(payload.primitives.find((primitive) => primitive.type === 'sphere')!.directional, false);
});

test('the export round-trips through JSON and carries the v1 header', () => {
  const document = { ...newDocument('round trip'), objects: sampleObjects() };
  const payload = buildCombinatorics(document, { now: new Date('2026-10-09T22:00:00.000Z') });
  const parsed = JSON.parse(JSON.stringify(payload));

  assert.equal(parsed.format, 'plinth.combinatorics');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.generator, 'plinth');
  assert.equal(parsed.scheme, 'iso-4');
  assert.equal(parsed.exportedAt, '2026-10-09T22:00:00.000Z');
  assert.deepEqual(parsed.sides, [...SIDES]);
  assert.deepEqual(parsed.projection, {
    tileWidthPixels: DEFAULT_SETTINGS.tileWidthPixels,
    levelHeightPixels: DEFAULT_SETTINGS.levelHeightPixels,
  });
  assert.deepEqual(parsed, payload);
});

test('iso-8 expands the class count to the 47 blob classes without breaking iso-4', () => {
  const iso4 = canonicalCombinations('iso-4');
  const iso8 = canonicalCombinations('iso-8');
  assert.equal(iso4.length, 6);
  assert.equal(iso8.length, 47);
  assert.ok(iso8.length > iso4.length);

  // The blob rule drops diagonals whose adjacent orthogonals are absent.
  assert.equal(blobNormalize(0b0000_0010), 0); // lone NE → nothing
  assert.equal(blobNormalize(0b0000_0111), 0b0000_0111); // N+E+NE → kept
  assert.equal(rotateMask8(1, 1), 2);

  const document = { ...newDocument('iso8'), objects: sampleObjects() };
  const payload = buildCombinatorics(document, { scheme: 'iso-8' });
  assert.equal(payload.scheme, 'iso-8');
  assert.deepEqual(payload.sides, [...SIDES_8]);
  assert.equal(payload.primitives[0].combinations.length, 47);
});
