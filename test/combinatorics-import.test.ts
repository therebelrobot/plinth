// Feature 3 — importing `plinth.combinatorics` and using its classes as the
// surfaces of the primitives. Pure-core tests: no DOM, no network.
//
// `exportSceneJson` builds a Blob but touches no DOM at import time, so it is
// safe to exercise here (Node 22 has global Blob + blob.text()).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCombinatorics, canonicalMask, neighbourMasks, parseCombinatorics, validateCombinatorics,
} from '../src/core/combinatorics';
import { renderScene } from '../src/core/render';
import { DEFAULT_RENDER_OPTIONS, DEFAULT_SETTINGS, newDocument, type CombinatoricsSet, type SceneObject } from '../src/core/types';
import { exportSceneJson } from '../src/lib/exporters';
import { validDocument } from '../server/main';
import { makeObject } from './sample-scene';

const noFloor = { ...DEFAULT_RENDER_OPTIONS, showFloor: false };

function scene(objects: SceneObject[]) {
  return { ...newDocument('test'), objects };
}

// ── 1. parse / validate ───────────────────────────────────────────────────────

test('parseCombinatorics accepts a Feature-2 export', () => {
  const objects = [makeObject('wall', 0, 0, 0, 1, 1, 2, 0, 0.25), makeObject('wall', 1, 0, 0, 1, 1, 2, 0, 0.25)];
  const text = JSON.stringify(buildCombinatorics(scene(objects), { now: new Date('2026-10-09T22:00:00.000Z') }));
  const parsed = parseCombinatorics(text);
  assert.equal(parsed.format, 'plinth.combinatorics');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.scheme, 'iso-4');
  assert.equal(parsed.primitives.length, 1);
  assert.equal(parsed.primitives[0].type, 'wall');
  assert.equal(parsed.primitives[0].combinations.length, 6);
  assert.equal(parsed.source?.exportedAt, '2026-10-09T22:00:00.000Z');
});

test('parseCombinatorics rejects malformed and unknown-version files', () => {
  assert.throws(() => parseCombinatorics('{ not json'), /not valid JSON/);
  assert.throws(() => parseCombinatorics('null'), /not a combinatorics file/);
  assert.throws(() => parseCombinatorics(JSON.stringify({ format: 'other', version: 1 })), /plinth\.combinatorics/);
  assert.throws(
    () => parseCombinatorics(JSON.stringify({ format: 'plinth.combinatorics', version: 2, scheme: 'iso-4', primitives: [] })),
    /unsupported combinatorics version/,
  );
  assert.throws(
    () => parseCombinatorics(JSON.stringify({ format: 'plinth.combinatorics', version: 1, scheme: 'iso-9', primitives: [] })),
    /unknown connectivity scheme/,
  );
  assert.throws(
    () => parseCombinatorics(JSON.stringify({
      format: 'plinth.combinatorics', version: 1, scheme: 'iso-4', primitives: [{ type: 'wall' }],
    })),
    /bad template/,
  );
});

test('validateCombinatorics drops unknown primitive types instead of throwing', () => {
  const payload = {
    format: 'plinth.combinatorics',
    version: 1,
    scheme: 'iso-4',
    primitives: [
      {
        type: 'wall',
        template: { type: 'wall', width: 1, depth: 1, height: 2, rotation: 0 },
        combinations: [{ id: 'single', mask: 0, rotations: [{ rotation: 0, mask: 0 }] }],
      },
      { type: 'obelisk', template: { type: 'obelisk', width: 1, depth: 1, height: 1, rotation: 0 }, combinations: [] },
    ],
  };
  const parsed = validateCombinatorics(payload);
  assert.equal(parsed.primitives.length, 1);
  assert.equal(parsed.primitives[0].type, 'wall');
});

// ── 2. neighbour masks ────────────────────────────────────────────────────────

test('neighbourMasks derives end / corner / straight / center from scene adjacency', () => {
  const objects = [
    makeObject('wall', 0, 0, 0, 1, 1, 2, 0, 0.25), // straight run: end (E only)
    makeObject('wall', 1, 0, 0, 1, 1, 2, 0, 0.25), // straight (E + W)
    makeObject('wall', 2, 0, 0, 1, 1, 2, 0, 0.25), // corner (W + S)
    makeObject('wall', 2, 1, 0, 1, 1, 2, 0, 0.25), // end (N only)
    makeObject('wall', 5, 5, 0, 1, 1, 2, 0, 0.25), // plus centre: center (all four)
    makeObject('wall', 4, 5, 0, 1, 1, 2, 0, 0.25),
    makeObject('wall', 6, 5, 0, 1, 1, 2, 0, 0.25),
    makeObject('wall', 5, 4, 0, 1, 1, 2, 0, 0.25),
    makeObject('wall', 5, 6, 0, 1, 1, 2, 0, 0.25),
  ];
  const masks = neighbourMasks(objects);
  // Canonical representative per class: single 0, end 1, straight 5, corner 3, center 15.
  assert.deepEqual(masks.map(canonicalMask), [1, 5, 3, 1, 15, 1, 1, 1, 1]);
});

test('a lone object has mask 0 (single); mismatched height/thickness never connects', () => {
  const objects = [
    makeObject('wall', 0, 0, 0, 1, 1, 2, 0, 0.25), // thin wall
    makeObject('wall', 1, 0, 0, 1, 1, 2, 0, 0.25), // same thickness + height → connects
    makeObject('wall', 2, 0, 0, 1, 1, 2, 0, 0.5), // thicker → must NOT connect to wall1
    makeObject('wall', 3, 0, 0, 1, 1, 3, 0, 0.5), // thicker + taller → must NOT connect to wall2
    makeObject('block', 0, 5, 0), // isolated → single
  ];
  const masks = neighbourMasks(objects);
  assert.ok((masks[0] & 2) !== 0, 'wall0 should see the matching wall1 to the east');
  assert.equal(canonicalMask(masks[0]), 1); // end
  assert.equal(canonicalMask(masks[1]), 1); // end (east neighbour rejected on thickness)
  assert.equal(masks[2] & 8, 0, 'wall2 (thicker) must not see wall1 to the west');
  assert.equal(masks[3] & 8, 0, 'wall3 (taller) must not see wall2 to the west');
  assert.equal(canonicalMask(masks[4]), 0); // lone block = single
});

// ── 3. surfaces affect the edge pass ─────────────────────────────────────────

test('an imported set suppresses interior seams on a run of blocks', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 4, floorTilesY: 1 };
  const objects = [0, 1, 2].map((index) => makeObject('block', index, 0, 0));
  const options = { ...noFloor, outlines: 'all' as const, mergeCoplanarFaces: false };
  const legacy = renderScene(settings, objects, options);
  const imported = renderScene(settings, objects, options, buildCombinatorics(scene(objects)));
  const count = (buffers: typeof legacy) => buffers.outline.reduce((total, value) => total + value, 0);
  assert.ok(count(imported) < count(legacy), `imported ${count(imported)} should be < legacy ${count(legacy)}`);
});

test('a set that omits a class suppresses nothing for that class (spec §3(b))', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 4, floorTilesY: 1 };
  const objects = [0, 1, 2].map((index) => makeObject('block', index, 0, 0));
  const options = { ...noFloor, outlines: 'all' as const, mergeCoplanarFaces: false };
  const legacy = renderScene(settings, objects, options);
  // A hand-edited set that only carries `center` (mask 15). The run's blocks have
  // `end`/`straight` masks, so the class lookup must find nothing and suppress no
  // seams — the imported table is authoritative, not the set's mere presence.
  const onlyCenter: CombinatoricsSet = {
    format: 'plinth.combinatorics',
    version: 1,
    scheme: 'iso-4',
    primitives: [{
      type: 'block',
      directional: false,
      template: { type: 'block', width: 1, depth: 1, height: 1, rotation: 0 },
      combinations: [{ id: 'center', mask: 15, rotations: [{ rotation: 0, mask: 15 }] }],
    }],
  };
  const imported = renderScene(settings, objects, options, onlyCenter);
  const count = (buffers: typeof legacy) => buffers.outline.reduce((total, value) => total + value, 0);
  assert.equal(count(imported), count(legacy), 'omitted classes must not suppress seams');
});

// ── 4. persistence round-trip ─────────────────────────────────────────────────

test('a combinatorics set survives a document JSON round-trip', async () => {
  const objects = [makeObject('block', 0, 0, 0), makeObject('block', 1, 0, 0)];
  const set = validateCombinatorics(JSON.parse(JSON.stringify(buildCombinatorics(scene(objects)))));
  const document = { ...scene(objects), combinatorics: set };
  const { blob } = exportSceneJson(document);
  const parsed = JSON.parse(await blob.text());
  const reparsed = parseCombinatorics(JSON.stringify(parsed.combinatorics));
  assert.deepEqual(reparsed, set);
});

// ── 5. fallback parity ────────────────────────────────────────────────────────

test('a scene with no neighbours maps to single and renders exactly as legacy', () => {
  const settings = { ...DEFAULT_SETTINGS, floorTilesX: 6, floorTilesY: 6 };
  const objects = [makeObject('block', 0, 0, 0), makeObject('block', 3, 3, 0), makeObject('cylinder', 5, 1, 0)];
  const masks = neighbourMasks(objects);
  assert.ok(masks.every((mask) => canonicalMask(mask) === 0), 'every object should be single');
  const options = { ...noFloor };
  const legacy = renderScene(settings, objects, options);
  const imported = renderScene(settings, objects, options, buildCombinatorics(scene(objects)));
  assert.deepEqual(imported.outline, legacy.outline);
  assert.deepEqual(imported.owner, legacy.owner);
});

// ── 6. server boundary ────────────────────────────────────────────────────────

test('validDocument accepts a document carrying combinatorics and rejects a bad set', () => {
  const objects = [makeObject('wall', 0, 0, 0, 1, 1, 2, 0, 0.25)];
  const set = buildCombinatorics(scene(objects));
  const good = { ...newDocument('v'), objects, combinatorics: set };
  assert.equal(validDocument(good), true);
  assert.equal(validDocument({ ...newDocument('plain'), objects }), true); // absent is fine
  assert.equal(
    validDocument({ ...good, combinatorics: { format: 'nope', version: 1, scheme: 'iso-4', primitives: [] } }),
    false,
  );
  assert.equal(
    validDocument({ ...good, combinatorics: { format: 'plinth.combinatorics', version: 2, scheme: 'iso-4', primitives: [] } }),
    false,
  );
});
