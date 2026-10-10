# plinth — Feature Implementation Audit

**Status:** Complete
**Auditor:** Code mode (spec-compliance audit)
**Spec of record:** [`docs/plinth-features-spec.md`](plinth-features-spec.md)
**Scope:** the seven features implemented across commits `530b7a8`, `a5528dc`, `fbac19d`, `816bcfd`, `f43d87d`, `b93e4b9`, `ac4c19d` (all local, unpushed).
**Method:** read the spec sections and the corresponding source + tests; ran the verification recipe once each.

---

## 0. Verification results (run once each)

| Command | Result | Notes |
|---|---|---|
| `npm run typecheck` | **PASS** (exit 0) | `tsc --noEmit`, no output. |
| `npm test` | **PASS** (exit 0) | 74 tests · 73 pass · 0 fail · 1 skipped. The skip is `layered PSD opens in psd-tools` — `psd_tools` is not installed, so it self-skips as designed ([`test/export.test.ts`](../test/export.test.ts:37)). |
| `npm run build` | **PASS** (exit 0) | Client: 36 modules → `dist/public` (301.33 kB JS / 13.30 kB CSS). Server: `dist/server.mjs` 16.3 kB. |

The stray `scratch-inspect.ts` at the repo root was present and has been **deleted**.

---

## 1. Overall verdict

**PASS with two PARTIALs.** All seven features are implemented, build, and are covered by tests. Two features deviate from the spec in ways that are real but non-blocking:

- **Feature 3 (combinatorics import)** — the imported class table is never consulted at render time; only the *presence* of a set toggles adjacency-based seam suppression. The spec's per-mask class lookup is implemented (`resolveCombination`) but unused → dead code.
- **Feature 7 (rampart colour)** — the PNG colour mode exists in the exporter but is **not wired to the UI**, so colour is only reachable through the PSD path. Outline/floor colour overrides and `colorMap` are also unexposed/unused.

Everything else matches the spec, including the deviations the implementation tasks reported (which are accurately described and acceptable).

---

## 2. Per-feature findings

### Feature 1 — ENV-VAR server token auth gate — **PASS**

**Spec-required behaviours present**

- `PLINTH_TOKEN` read once at startup, trimmed; empty ⇒ auth disabled ([`server/auth.ts`](../server/auth.ts:28), [`server/main.ts`](../server/main.ts:146)).
- Loud warning when unset ([`server/main.ts`](../server/main.ts:276)).
- Companion vars `PLINTH_COOKIE_SECURE` (`auto|true|false`) and `PLINTH_SESSION_TTL` (default 2592000) ([`server/auth.ts`](../server/auth.ts:30)).
- HMAC-signed, store-less session cookie `base64url(hmacSHA256(token, issuedAt)) + '.' + issuedAt` ([`server/auth.ts`](../server/auth.ts:45)); constant-time compare via `timingSafeEqual` ([`server/auth.ts`](../server/auth.ts:38)); TTL check ([`server/auth.ts`](../server/auth.ts:50)).
- Cookie attributes `HttpOnly; SameSite=Strict; Path=/; Max-Age=<ttl>` + `Secure` when secure ([`server/auth.ts`](../server/auth.ts:113)).
- Single gate at the top of the request handler, **before** the `/api` vs static split, covering API *and* static ([`server/main.ts`](../server/main.ts:249)).
- `isPublicPath` exempts only `/api/health` ([`server/auth.ts`](../server/auth.ts:95)); health stays public ([`server/main.ts`](../server/main.ts:176)).
- Routes `POST /api/auth/session`, `POST /api/auth/logout`, `GET /api/auth/session` ([`server/main.ts`](../server/main.ts:178)).
- Server-rendered, self-contained login page with a `<form>` ([`server/auth.ts`](../server/auth.ts:143)).
- Client `request()` is status-aware, dispatches `plinth:unauthorized` on 401, sets `credentials: 'same-origin'` ([`src/lib/api.ts`](../src/lib/api.ts:32)); `AuthError` carries `status` ([`src/lib/api.ts`](../src/lib/api.ts:25)).
- App overlay on the unauthorized event ([`src/App.tsx`](../src/App.tsx:73), [`src/App.tsx`](../src/App.tsx:469)).
- No token in `localStorage`; offline draft path untouched ([`src/lib/api.ts`](../src/lib/api.ts:70)).
- Docs: README env table + auth model ([`README.md`](../README.md:32)), Dockerfile healthcheck comment ([`Dockerfile`](../Dockerfile:25)), docker-compose commented env ([`docker-compose.yml`](../docker-compose.yml:10)).

**Deviations (all acceptable)**

1. The gate also exempts `isAuthPath` (`/api/auth/session`, `/api/auth/logout`) so login/logout are reachable pre-auth ([`server/auth.ts`](../server/auth.ts:100), [`server/main.ts`](../server/main.ts:249)). The spec's pseudocode omitted this but explicitly required those routes to be "reachable pre-auth" — a necessary, correct addition.
2. The login route additionally accepts a urlencoded form body and issues a `303` redirect for HTML clients ([`server/main.ts`](../server/main.ts:68), [`server/main.ts`](../server/main.ts:164)). This is an enhancement over the spec's JSON-only `{ token }` contract; the JSON path still returns `{ ok: true }` as specified.
3. Login failure applies a fixed 250 ms delay ([`server/main.ts`](../server/main.ts:158)) — matches the spec's "small constant delay".

**Test coverage vs spec §1(f)** — all 8 required cases are present in [`test/auth.test.ts`](../test/auth.test.ts:1): unset-open (1), token-set 401 + login page (2), bearer (3), wrong/correct token + `Set-Cookie` (4), replay + tampered cookie (5), expired (6), health public (7), unset ⇒ app shell (8), plus pure-function tests for HMAC round-trip and `isPublicPath`.

**Gaps (minor)**

- No test asserts the `Secure` attribute or the `x-forwarded-proto` `auto` inference ([`server/auth.ts`](../server/auth.ts:105)). Behaviour is implemented but untested.

---

### Feature 2 — Combinatorics export — **PASS**

**Spec-required behaviours present**

- `rotateMask` cyclic 4-bit rotation, 4 applications identity ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:104)).
- `canonicalCombinations('iso-4')` yields the six named classes with the 1+4+2+4+4+1 partition ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:132)); `iso-8` yields 47 blob classes ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:157)).
- `buildCombinatorics` keyed by full template `type|width|depth|height|parameter` ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:187)), emits `format/version/generator/exportedAt/scheme/sides/projection/primitives`, `template` at rotation 0, and `directional` from `DIRECTIONAL_TYPES` ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:196)).
- Exporter `exportCombinatoricsJson` mirrors `exportSceneJson` ([`src/lib/exporters.ts`](../src/lib/exporters.ts:206)).
- Export panel button + `iso-4/iso-8` toggle + tooltip clarifying `edge ≡ straight` ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:360)).

**Deviations (acceptable, but note the naming)**

- The emitted class id for the two-opposite-connections class is **`straight`**, not `edge` ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:27), [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:36)). The spec's own example JSON uses `straight` and §2(g) fixes `edge ≡ straight`, so this is spec-consistent — but the user's requirement #2 literally says "center/edge/corner". The panel tooltip documents the alias ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:370)). If the user wants the literal token `edge` in the file, that is a one-line change.
- `template.parameter` is omitted when `undefined` rather than always present ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:205)). Harmless.

**Test coverage vs spec §2(f)** — all 6 cases present in [`test/combinatorics.test.ts`](../test/combinatorics.test.ts:1): rotateMask (1), partition (2), center/edge/corner + corner 4 rotations (3), distinct types (4), JSON round-trip header (5), iso-8 (6).

---

### Feature 3 — Combinatorics import (as primitive surfaces) — **PARTIAL**

**Spec-required behaviours present**

- `parseCombinatorics` / `validateCombinatorics` reject wrong `format`, unknown `version`, unknown `scheme`, malformed combinations; unknown primitive *types* are dropped, not thrown ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:272), [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:299)).
- `SceneDocument.combinatorics?: CombinatoricsSet` ([`src/core/types.ts`](../src/core/types.ts:75), [`src/core/types.ts`](../src/core/types.ts:115)).
- `analyseAdjacency` derives per-object neighbour masks + connected pairs via a spatial hash (O(n)-ish) ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:402)); `abuttingDirection` enforces same type, z/height, `parameter`, coincident plane, and matching edge length ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:371)).
- Render consults `joinPairs` in the edge pass to suppress seams between connected owners ([`src/core/render.ts`](../src/core/render.ts:201), [`src/core/render.ts`](../src/core/render.ts:262)).
- Import + clear controls, active-set readout ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:373)); threaded through `history.commit` ([`src/App.tsx`](../src/App.tsx:450)).
- Server boundary check `validCombinatorics` ([`server/main.ts`](../server/main.ts:93)).
- Fallback: no set ⇒ `joinPairs` stays `null` and behaviour is legacy geometry + `mergeCoplanarFaces` ([`src/core/render.ts`](../src/core/render.ts:202)).

**Deviation (the substantive one)**

The spec §3(b) requires the imported set's **class table** to drive which surfaces are open: derive the object's mask, canonicalise it, look it up in the imported `primitives[].combinations[]`, and surface the resulting open/closed flags. The implementation instead uses the imported set only as a **boolean switch**: when a set is present, `analyseAdjacency(objects).pairs` is computed and *every* adjacent compatible pair suppresses its seam ([`src/core/render.ts`](../src/core/render.ts:201), [`src/core/render.ts`](../src/core/render.ts:262)). The imported `primitives`/`combinations` content is never read at render time.

Consequences:

- `resolveCombination`, `openFacesFromMask`, `FaceOpenFlags`, `ResolvedCombination` ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:311), [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:320), [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:346)) are **dead code** — referenced only within `combinatorics.ts` itself, never by `render.ts`/`compose.ts`. (Confirmed by search: no external references.)
- A set that omits a class (e.g. a hand-edited file with only `center`) still suppresses all adjacency seams, because the class table is ignored.
- The spec's "editor and export always match" invariant is only partially honoured: the export enumerates classes, but the renderer does not consume them.

This is a genuine spec deviation. It is *functionally* close for the common case (adjacency already implies the faces abut), and the tests pass, but it does not implement the specified lookup. Per repo rule `06-working-from-spec`, this should either be implemented or the spec updated to record the presence-only design.

**Test coverage vs spec §3(f)** — all 6 cases present in [`test/combinatorics-import.test.ts`](../test/combinatorics-import.test.ts:1): parse accept/reject (1), neighbourMask L-shape (2), fewer outline pixels (3), JSON round-trip (4), no-neighbour parity (5), `validDocument` (6). Note the tests validate the *presence-only* behaviour, so they pass despite the deviation.

---

### Feature 4 — Wall edge merging at corners — **PASS**

**Spec-required behaviours present**

- Adjacency-aware edge suppression: `analyseWallCorners` produces connected pairs consumed by the edge pass ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:574), [`src/core/render.ts`](../src/core/render.ts:198)).
- Mitered corner geometry: `CornerPost` unioned into the wall's intersection test ([`src/core/geometry.ts`](../src/core/geometry.ts:156), [`src/core/geometry.ts`](../src/core/geometry.ts:234)); posts derived per object ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:538)) and passed through `prepare` ([`src/core/render.ts`](../src/core/render.ts:209)).
- Render-time toggle `RenderOptions.mergeWallCorners`, default `true`, not persisted ([`src/core/types.ts`](../src/core/types.ts:140), [`src/core/types.ts`](../src/core/types.ts:164)).
- No document change; joins derived at render time — exactly as the spec's §4(d) "Implemented" note records.

**Deviations** — none. The spec was updated to describe the render-time derivation, matching the code.

**Test coverage vs spec §4(f)** — all 5 cases present in [`test/wall-join.test.ts`](../test/wall-join.test.ts:1): perpendicular corner fewer outlines (1), collinear run unchanged (2), mismatched thickness merges + solid top (3), lone wall identical (4), geometry unit corner post (5), plus `wallSlabBounds` per-rotation.

**Gap (performance)**

`analyseWallCorners` is a plain **O(n²)** double loop over walls ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:578)), unlike `analyseAdjacency` which uses a spatial hash. The spec's §3(g) explicitly warned about O(n²) for a 20 000-object scene; the corner pass reintroduces it. For wall-heavy scenes this is a real cost. Follow-up: reuse the spatial hash.

---

### Feature 5 — Tall variants (0.5×/1×/1.5×/2×) — **PASS**

**Spec-required behaviours present**

- `LEVEL_CHANGING_TYPES = {ramp, stairs, pyramid, cone}` ([`src/core/primitives.ts`](../src/core/primitives.ts:46)); `TALL_VARIANTS = [0.5, 1, 1.5, 2]` ([`src/core/primitives.ts`](../src/core/primitives.ts:49)).
- `tallness` on `PrimitivePreset` ([`src/core/primitives.ts`](../src/core/primitives.ts:18)); variant presets generated in code with keys `ramp_tall05`/`ramp`/`ramp_tall15`/`ramp_tall2` ([`src/core/primitives.ts`](../src/core/primitives.ts:63), [`src/core/primitives.ts`](../src/core/primitives.ts:72)).
- `baseHeight(type)` helper ([`src/core/primitives.ts`](../src/core/primitives.ts:85)).
- Object-panel `Height variant` `Segmented`, shown only for level-changing types, commits a `height` change ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:80)).
- No geometry change required (all affected geometry already scales with `h`).

**Deviations** — none material. The `1×` variant is the base preset itself (not duplicated), matching the spec.

**Test coverage vs spec §5(f)** — all 5 cases present in [`test/variants.test.ts`](../test/variants.test.ts:1): monotonic coverage (1), ramp top row (2), stairs risers (3), four variants + `1×` equals base (4), kit uniqueness (5).

**Gap (minor, spec §5(g))**

The spec recommended grouping/filtering the rail so ~28 entries stay usable; the rail renders `PRIMITIVE_PRESETS` flat ([`src/App.tsx`](../src/App.tsx:344)). Cosmetic, not a correctness issue.

---

### Feature 6 — Wall slopes — **PASS**

**Spec-required behaviours present**

- `SceneObject.slope?: number` and `slopeDirection?: 1 | -1` ([`src/core/types.ts`](../src/core/types.ts:47)).
- `prepareShape` wall case appends the slope plane and routes through half-spaces ([`src/core/geometry.ts`](../src/core/geometry.ts:195)); `intersectCanonical` uses `intersectHalfSpaces` when `slope > 0` ([`src/core/geometry.ts`](../src/core/geometry.ts:239)).
- Slope runs along the wall's **run** axis (canonical y), not thickness — plane `(0, h/(slope·b), 1, h/slope)` ([`src/core/geometry.ts`](../src/core/geometry.ts:213)).
- Presets `wall_ramp_a` (full) and `wall_ramp_b` (½) ([`src/core/primitives.ts`](../src/core/primitives.ts:30)).
- Object-panel `Slope` field + `Slope rises` direction control, walls only ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:106)).
- Kit filename encodes slope to keep sprites unique ([`src/lib/exporters.ts`](../src/lib/exporters.ts:96)).

**Deviations (acceptable / improvement)**

- The spec §6(b) suggested a partial slope might need "two extra half-spaces" and allowed starting with full-slope only. The implementation uses a **single** plane plus the box's own top plane to clamp the shoulder ([`src/core/geometry.ts`](../src/core/geometry.ts:195)). This correctly produces a flat shoulder of length `(1−slope)·b` then a descent over `slope·b` — verified by the monotonic-top test. This is a cleaner solution than the spec's sketch and satisfies the partial-slope requirement.

**Test coverage vs spec §6(f)** — all 6 cases present in [`test/wall-slope.test.ts`](../test/wall-slope.test.ts:1): flat regression (1), monotonic top (2), tall/short ends (3), rotations 0–3 (4), placement defers to sloped top (5), clean staircase / no curved flag (6).

**Gap (minor, cross-feature)**

Spec §6(b)/§8.3 said Feature 6 extends Feature 5's preset generation with **sloped tall walls**. Because `wall` is not in `LEVEL_CHANGING_TYPES`, `wall_ramp_a`/`wall_ramp_b` are emitted at `tallness: 1` only — there are no 0.5×/1.5×/2× sloped-wall presets. The slope *field* works at any height, so this is a preset-completeness gap, not a functional one.

---

### Feature 7 — Rampart colour import (base colour layer) — **PARTIAL**

**Spec-required behaviours present**

- `parseRampartPalette` accepts a `LibraryExport`, a bare `SavedPalette[]`, or a single `SavedPalette`; skips palettes without `hexColors` (warn); throws on invalid hex; warns on non-`rampart` application ([`src/core/color.ts`](../src/core/color.ts:46)).
- `Palette`, `ColorSettings`, and `SceneDocument.palette/colorMap/colorSettings` ([`src/core/types.ts`](../src/core/types.ts:89), [`src/core/types.ts`](../src/core/types.ts:117)).
- `composeColorImage` writes real RGB per pixel ([`src/core/compose.ts`](../src/core/compose.ts:118)); `composeLayers` adds a **`Base color`** layer under the greyscale trace layers ([`src/core/compose.ts`](../src/core/compose.ts:203)).
- Outline/floor colours parameterised, defaulting to the palette's shared shadow ([`src/core/compose.ts`](../src/core/compose.ts:128)).
- Gating: `colorActive` returns false when a combinatorics set is present ([`src/core/color.ts`](../src/core/color.ts:169)); PSD path honours it ([`src/lib/exporters.ts`](../src/lib/exporters.ts:84)).
- Import + toggle + assign mode + ramp size + swatch preview ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:403)); threaded through `history.commit` ([`src/App.tsx`](../src/App.tsx:451)).
- Server boundary check `validPalette` ([`server/main.ts`](../server/main.ts:107)).

**Deviations / gaps (the substantive one)**

1. **PNG colour mode is not wired to the UI.** `exportScenePng` accepts a `color` flag and calls `composeColorImage` when set ([`src/lib/exporters.ts`](../src/lib/exporters.ts:73)), but the Export panel calls it **without** the flag ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:311)), so it defaults to `false`. The spec §7(b) required "PNG export gains a colour mode (segmented `Values: grey | colour`), or emits both." As shipped, colour is only reachable via the **PSD** path. This is a real, user-visible gap: the "Base color" layer appears in PSD but the PNG stays greyscale.
2. **Outline/floor colour overrides are unexposed.** `colorSettings.outlineColor`/`floorColor` are honoured by `colorAt` ([`src/core/compose.ts`](../src/core/compose.ts:128)) but no UI control sets them; they always fall back to the shared shadow.
3. **`colorMap` is unused.** Declared in the type ([`src/core/types.ts`](../src/core/types.ts:119)) but never read or written anywhere (confirmed by search). Dead field.
4. The spec's `assign: 'byType' | 'byLevel'` modes are implemented ([`src/core/color.ts`](../src/core/color.ts:128)) and exposed in the UI ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:438)).

**Test coverage vs spec §7(f)** — all 7 cases present across [`test/color.test.ts`](../test/color.test.ts:1) and [`test/rampart-import.test.ts`](../test/rampart-import.test.ts:1): parse 3 shapes (1), reject/skip (2), ordering (3), non-grey RGB (4), `Base color` layer (5), disabled unchanged (6), suppressed with combinatorics (7). The PSD-opens-with-layer assertion is the skipped `psd-tools` test.

---

## 3. Cross-feature interactions

| Interaction | Status | Evidence |
|---|---|---|
| Combinatorics import vs rampart colour gating | **Correct** | `colorActive` returns false when `combinatorics` is present ([`src/core/color.ts`](../src/core/color.ts:169)); PSD path passes `palette: undefined` in that case ([`src/lib/exporters.ts`](../src/lib/exporters.ts:84)); UI shows the suppression note ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:449)); tested ([`test/color.test.ts`](../test/color.test.ts:53)). |
| Wall slope vs wall corner merge | **Risk (untested)** | `analyseWallCorners` derives posts from `wallSlabBounds`, which ignores `slope` ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:492)). The post is always full height `0..h` ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:559)), so a **sloped** wall meeting another wall can get a full-height corner column that pokes above the descended slope. Spec §6(g) flagged this ("the corner joiner must respect the slope"). No test covers sloped-wall + corner. |
| Tall variants vs wall presets | **Gap (minor)** | `wall` is not level-changing, so no tall sloped-wall presets exist (see Feature 6 gap). |
| Combinatorics export vs slope | **Minor** | `buildCombinatorics` template key omits `slope` ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:193)), so a flat and a sloped wall of identical footprint collapse to one entry. Not spec-required, but worth noting. |
| Auth vs everything else | **Orthogonal, correct** | Gate is at the top of the handler; rendering features are client-side and unaffected. |

---

## 4. Prioritized gaps / follow-ups

**High**

1. **Feature 3 — consume the imported class table (or update the spec).** Either wire `resolveCombination`/`openFacesFromMask` into the render pass so the imported `combinations[]` actually drives open faces, or amend spec §3(b) to record the presence-only design. Currently `resolveCombination` et al. are dead code and the spec is not honoured. ([`src/core/render.ts`](../src/core/render.ts:201), [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:346))
2. **Feature 7 — wire the PNG colour mode to the UI.** Pass the colour flag from the Export panel (or add the `Values: grey | colour` segmented control the spec asked for). ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:311), [`src/lib/exporters.ts`](../src/lib/exporters.ts:73))

**Medium**

3. **Feature 4 — make `analyseWallCorners` O(n)-ish.** Replace the O(n²) wall double loop with the existing spatial hash to protect the 20 000-object ceiling. ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:578))
4. **Feature 6/4 — sloped-wall corner join.** Make the mitre post respect the slope (clamp the post top to the sloped surface) and add a test. ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:559))
5. **Feature 7 — expose outline/floor colour overrides** and either use or remove `colorMap`. ([`src/core/types.ts`](../src/core/types.ts:119))

**Low**

6. **Feature 2 — naming.** If the user wants the literal `edge` token in the export, rename the emitted id (spec-consistent either way). ([`src/core/combinatorics.ts`](../src/core/combinatorics.ts:27))
7. **Feature 5 — group the palette rail** so ~28 entries stay usable. ([`src/App.tsx`](../src/App.tsx:344))
8. **Feature 6 — add sloped tall-wall presets** if the "sloped tall walls" intent from §8.3 is wanted. ([`src/core/primitives.ts`](../src/core/primitives.ts:30))
9. **Feature 1 — add tests** for the `Secure` attribute and `x-forwarded-proto` auto inference. ([`server/auth.ts`](../server/auth.ts:105))

---

## 5. User's original 7 requirements — satisfaction

| # | Requirement | Verdict | Note |
|---|---|---|---|
| 1 | env-var server token gating the entire app + APIs (in-app, not reverse proxy) | **Satisfied** | Server-owned HMAC cookie gate over API *and* static; login page server-rendered. |
| 2 | export combinatorics for composable isometric tiling (center/edge/corner) | **Satisfied** | `center`/`corner` emitted; the "edge" class is emitted as `straight` (documented alias). |
| 3 | import those combinatorics and use as primitive surfaces | **Partial** | Import + adjacency-driven seam suppression works, but the imported class table is not consulted (presence-only). |
| 4 | walls combine to an edge / merge smoothly at back corner | **Satisfied** | Miter post + adjacency seam suppression; tested. |
| 5 | half, 1.5×, 2× tall versions of level-changing primitives | **Satisfied** | 0.5×/1×/1.5×/2× for ramp/stairs/pyramid/cone. |
| 6 | walls have slope options with ramp-like slants | **Satisfied** | Run-axis slope plane, full + partial, direction control, presets. |
| 7 | import rampart export for ramped colors as a base color layer (when not using combinatorics) | **Partial** | PSD `Base color` layer works and is correctly gated; PNG colour mode is not reachable from the UI. |

---

## 6. Conclusion

The seven features are implemented, typecheck clean, build clean, and pass 73/73 runnable tests. The two PARTIALs (Feature 3 class-table consumption, Feature 7 PNG colour wiring) are the only substantive spec deviations; both are non-blocking for the build but should be resolved or recorded in the spec per repo rule `06-working-from-spec`. The remaining items are performance, preset-completeness, and test-coverage follow-ups.

---

## 7. Re-audit — previously-flagged gaps

**Scope:** re-verify only the two HIGH and three MEDIUM gaps from §4 against commits `c7045b0`, `26986fe`, `7cf0b2c`, `49f8a8f`. Read-only; no source changes.

### 7.1 Verification commands

| Command | Result | Notes |
|---|---|---|
| `npm run typecheck` | **PASS** (exit 0) | `tsc --noEmit`, no output. |
| `npm test` | **PASS** (exit 0) | 77 tests · 76 pass · 0 fail · 1 skipped. The skip is `layered PSD opens in psd-tools` — `psd_tools` is not installed, so it self-skips as designed. |
| `npm run build` | **PASS** (exit 0) | Client: 36 modules → `dist/public` (303.14 kB JS / 13.30 kB CSS). Server: `dist/server.mjs` 16.3 kB. |

### 7.2 Verdicts

| # | Gap (from §4) | Verdict |
|---|---|---|
| 1 | Feature 3 — consume the imported class table | **RESOLVED** |
| 2 | Feature 7 — wire the PNG colour mode to the UI | **RESOLVED** |
| 3 | Feature 4 — `analyseWallCorners` O(n)-ish | **RESOLVED** |
| 4 | Feature 6/4 — slope-clamped mitre post + test | **RESOLVED** |
| 5 | Feature 7 — outline/floor colours exposed; `colorMap` removed | **RESOLVED** |

### 7.3 Evidence

**1. Feature 3 — imported class table is now authoritative — RESOLVED**

- [`src/core/render.ts`](../src/core/render.ts:7) imports `resolveCombination`; it is no longer dead code.
- [`src/core/render.ts`](../src/core/render.ts:212) branches on scheme: `iso-8` keeps the presence-based behaviour (its 8-bit masks cannot be derived from the 4-neighbour pass), while `iso-4` resolves per object.
- [`src/core/render.ts`](../src/core/render.ts:215) maps each object to `resolveCombination(combinatorics, object.type, adjacency.masks[index])`.
- [`src/core/render.ts`](../src/core/render.ts:220) adds a pair key **only** when `resolved[a].combination && resolved[b].combination` — so a set that omits a class suppresses nothing for that class.
- [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:346) `resolveCombination` canonicalises the mask and looks it up in `primitive.combinations`; [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:320) `openFacesFromMask` expands the world-space mask. Both are live.
- **Test:** [`test/combinatorics-import.test.ts`](../test/combinatorics-import.test.ts:126) — "a set that omits a class suppresses nothing for that class (spec §3(b))" asserts the imported outline count equals the legacy count.

**2. Feature 7 — PNG colour mode reachable and gated — RESOLVED**

- [`src/ui/Panels.tsx`](../src/ui/Panels.tsx:260) holds the `pngColor` state.
- [`src/ui/Panels.tsx`](../src/ui/Panels.tsx:319) renders the `Segmented` "PNG values" control (`grey | colour`), shown when `document.palette` is present.
- [`src/ui/Panels.tsx`](../src/ui/Panels.tsx:330) passes `pngColor` into `exportScenePng`.
- [`src/lib/exporters.ts`](../src/lib/exporters.ts:73) accepts the `color` flag; [`src/lib/exporters.ts`](../src/lib/exporters.ts:75) applies `composeColorImage` only when `color && colorActive(document)` — i.e. gated by `colorActive`, so colour is suppressed when a combinatorics set is imported.
- Minor, non-blocking: the segmented control renders whenever a palette exists rather than strictly when `colorActive`; the exporter still gates, and the suppression note at [`src/ui/Panels.tsx`](../src/ui/Panels.tsx:478) explains the state.

**3. Feature 4 — `analyseWallCorners` is O(n)-ish — RESOLVED**

- [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:601) documents the spatial-hash approach; the unit-cell grid is built at [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:605) and queried over an expanded box at [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:624), replacing the former O(n²) double loop.
- **Test:** [`test/wall-join.test.ts`](../test/wall-join.test.ts:115) — "analyseWallCorners finds corners via the spatial hash regardless of array order".

**4. Feature 6/4 — mitre post respects wall slope — RESOLVED**

- [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:492) `slopeTopAt` mirrors the slope plane built in `prepareShape`; [`src/core/combinatorics.ts`](../src/core/combinatorics.ts:586) clamps `post.top` to `min(slopeTopAt(a, post.y0), slopeTopAt(a, post.y1))`, so a sloped wall's corner column never rises above the slope.
- **Test:** [`test/wall-join.test.ts`](../test/wall-join.test.ts:131) — "a sloped wall clamps its mitre post to the sloped surface (Feature 6)".

**5. Feature 7 — outline/floor colours exposed; `colorMap` removed — RESOLVED**

- [`src/ui/Panels.tsx`](../src/ui/Panels.tsx:468) exposes `Outline` and `Floor` colour inputs bound to `colorSettings.outlineColor` / `floorColor`.
- `colorMap` is gone: [`src/core/types.ts`](../src/core/types.ts:109) `SceneDocument` no longer declares it, and a repo-wide search finds no `colorMap` reference.

### 7.4 Remaining issues

- None. All five previously-flagged gaps are resolved; `npm run typecheck`, `npm test`, and `npm run build` all pass; the stray `scratch-inspect.ts` has been deleted.

---

## 8. Tileset rework audit (Feature 10 — image-based combinatorics)

**Scope:** audit the rework against spec §10 and the requester's stated intent, per commits `59fb799` (export) and `b673164` (import). Read-only; no source changes. The stray `scratch-inspect.ts` was **not** present at the repo root (nothing to delete).

### 8.1 Verification commands

| Command | Result | Notes |
|---|---|---|
| `npm run typecheck` | **NOT RUN** | Architect mode exposes no shell/command tool, so the command could not be executed. Last recorded run (§7.1) passed. |
| `npm test` | **NOT RUN** | Same limitation. Last recorded: 77 tests · 76 pass · 0 fail · 1 skipped. |
| `npm run build` | **NOT RUN** | Same limitation. Last recorded: client + server built clean. |

> The three commands must be run in a mode with shell access (e.g. Code) to confirm the rework. The code-level audit below is complete and independent of that.

### 8.2 Per-item verdicts

| # | Item | Verdict |
|---|---|---|
| 1 | Enumeration — open-corner rule, count 47, distribution, mask 0 | **PASS** |
| 2 | Export — discrete PNGs + zip + manifest per §10 | **PASS** |
| 3 | Import — load/validate/decode/persist + per-tile compositing | **PASS** |
| 4 | Precedence — tileset > rampart colour > grey | **PASS** |
| 5 | Build + tests | **UNVERIFIED** (no shell tool in this mode) |
| 6 | Cross-feature interactions / regressions | **PASS** |
| 7 | Satisfies the requester's stated intent | **PASS** |

### 8.3 Evidence

**1. Enumeration — PASS**

- The open-corner rule is implemented directly, **not** `blobNormalize`: `openCornerNormalize` clears a diagonal bit when *either* flanking orthogonal is present ([`src/core/tileset.ts`](../src/core/tileset.ts:50)); `CORNER_FLANKS` maps NE↔(N,E), SE↔(E,S), SW↔(S,W), NW↔(W,N) ([`src/core/tileset.ts`](../src/core/tileset.ts:28)). The module imports only `analyseAdjacency`, `pairStride`, `rotateMask8` from `combinatorics` — `blobNormalize` is never referenced ([`src/core/tileset.ts`](../src/core/tileset.ts:13)).
- `enumerateConfigs` normalizes all 256 masks and de-duplicates ([`src/core/tileset.ts`](../src/core/tileset.ts:80)); `TILESET_CONFIG_COUNT` is the array length ([`src/core/tileset.ts`](../src/core/tileset.ts:105)).
- Count is exactly 47 and the orthogonal-popcount distribution is `{0:16, 1:16, 2:10, 3:4, 4:1}` — asserted in [`test/tileset.test.ts`](../test/tileset.test.ts:28) (lines 29–39) and re-asserted in [`test/tileset-import.test.ts`](../test/tileset-import.test.ts:52). This matches the requester's `1·16 + 4·4 + 4·2 + 2·1 + 4·1 + 1·1` and the §10(b)(1) table.
- Mask 0 is included and named `c00` ([`test/tileset.test.ts`](../test/tileset.test.ts:42)); the doc comment records the "47 + 1 = 48 is bookkeeping" decision ([`src/core/tileset.ts`](../src/core/tileset.ts:96)).
- Rotation equivariance under quarter turns is tested ([`test/tileset.test.ts`](../test/tileset.test.ts:57)).

**2. Export — PASS**

- `buildTileset` collects the distinct faces of the active scene by `faceKey` (type|width|depth|height|parameter|slope|slopeDirection) ([`src/core/tileset.ts`](../src/core/tileset.ts:504), [`src/core/tileset.ts`](../src/core/tileset.ts:614)), renders each face once, then emits one PNG per config (47) with the config's open edges un-outlined ([`src/core/tileset.ts`](../src/core/tileset.ts:637)).
- Zip layout matches §10(b)(2): `manifest.json` first, then `tiles/<face-slug>/<config>.png` ([`src/core/tileset.ts`](../src/core/tileset.ts:645), [`src/core/tileset.ts`](../src/core/tileset.ts:682)). `exportTileset` packages via `createZip` and returns `{ blob, filename, manifest }` ([`src/lib/tileset.ts`](../src/lib/tileset.ts:26)).
- Manifest schema matches §10: `format: 'plinth.tileset'`, `version: 1`, `generator`, `exportedAt`, `scheme: 'open-corner-8'`, `sides`, `projection`, `scale`, `configs` (the 47), `faces[]` with `slug/type/template/directional/sprites` ([`src/core/tileset.ts`](../src/core/tileset.ts:247), [`src/core/tileset.ts`](../src/core/tileset.ts:664)).
- Drawable templates: `composeTilesetImage` composes with `background: 'transparent'` and `showFloor: false`, so the sprite is a grey isometric block ([`src/core/tileset.ts`](../src/core/tileset.ts:692)); `suppressOpenEdges` removes the outline along open orthogonal sides and at open corners ([`src/core/tileset.ts`](../src/core/tileset.ts:548)). Tested: isolated tile has fewer outline pixels than a fully-joined one ([`test/tileset.test.ts`](../test/tileset.test.ts:130)).
- Zip contents verified: `1 + 2·47` entries, `manifest.json` present, every sprite file present, PNG magic bytes correct ([`test/tileset.test.ts`](../test/tileset.test.ts:103)).

**3. Import — PASS**

- `importTilesetBytes` reads the zip, requires `manifest.json`, validates via `parseTilesetManifest`, decodes every sprite PNG, and skips missing/undecodable files with a warning ([`src/lib/tileset.ts`](../src/lib/tileset.ts:77)); `importTileset` adapts a `File`/`Blob` ([`src/lib/tileset.ts`](../src/lib/tileset.ts:109)).
- Validation rejects wrong `format`/`version`/`scheme` and malformed entries; unknown config ids and primitive types are dropped with a warning (forward-compatible) ([`src/core/tileset.ts`](../src/core/tileset.ts:347), [`src/core/tileset.ts`](../src/core/tileset.ts:274)). Tested ([`test/tileset-import.test.ts`](../test/tileset-import.test.ts:93)).
- Persistence: decoded sprites are stored in **IndexedDB** keyed by `TilesetRef.id`, with an in-memory fallback when IDB is unavailable ([`src/lib/tileset.ts`](../src/lib/tileset.ts:179), [`src/lib/tileset.ts`](../src/lib/tileset.ts:190)); only the small `TilesetRef { id, manifest }` is persisted with the document ([`src/core/types.ts`](../src/core/types.ts:116), [`src/core/types.ts`](../src/core/types.ts:135)). The UI saves then commits the ref ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:459), [`src/App.tsx`](../src/App.tsx:453)).
- Per-tile sprite selection: `buildTilesetPlacements` derives each object's 8-neighbour mask via `analyseAdjacency8`, normalizes with `openCornerNormalize`, and looks up the config's sprite ([`src/core/tileset.ts`](../src/core/tileset.ts:459), [`src/core/tileset.ts`](../src/core/tileset.ts:477)). The viewport loads sprites and passes placements into `composeImage` ([`src/ui/Viewport.tsx`](../src/ui/Viewport.tsx:111), [`src/ui/Viewport.tsx`](../src/ui/Viewport.tsx:133)).
- Compositing: `sampleSprite` anchors the sprite at the object's footprint back corner, scales from the tileset tile size to the scene's, and returns the sprite RGBA only when the pixel is opaque ([`src/core/compose.ts`](../src/core/compose.ts:121)); an opaque pixel replaces grey, a transparent pixel falls back to grey ([`src/core/compose.ts`](../src/core/compose.ts:221)). Tested both ways ([`test/tileset-import.test.ts`](../test/tileset-import.test.ts:99)).
- Rotation: the exporter emits rotation 0; the importer rotates the sprite and its anchor for directional faces ([`src/core/tileset.ts`](../src/core/tileset.ts:409), [`src/core/tileset.ts`](../src/core/tileset.ts:481)). Tested with a non-square sprite ([`test/tileset-import.test.ts`](../test/tileset-import.test.ts:146)).
- Missing-sprite fallback: a face with no sprites, or an absent face, resolves to `null` → grey, byte-identical to no tileset ([`src/core/tileset.ts`](../src/core/tileset.ts:480), [`test/tileset-import.test.ts`](../test/tileset-import.test.ts:133)).

**4. Precedence — PASS**

- Grey path: `composeImage` samples the sprite first and only falls back to `toneAt` grey when the sprite pixel is transparent/absent ([`src/core/compose.ts`](../src/core/compose.ts:221)).
- Colour path: `composeColorImage` prefers the sprite over the palette colour ([`src/core/compose.ts`](../src/core/compose.ts:188)).
- PSD base layer: `composeLayers` prefers the sprite over the palette colour in the `Base color` layer ([`src/core/compose.ts`](../src/core/compose.ts:284)).
- So **tileset > rampart colour > grey** holds in all three compose paths, and the UI states it ([`src/ui/Panels.tsx`](../src/ui/Panels.tsx:449)).

**5. Build + tests — UNVERIFIED**

- Not runnable from architect mode (no shell tool). See §8.1. The prior audit's last recorded run (§7.1) passed; the rework adds `test/tileset.test.ts` and `test/tileset-import.test.ts`, which are consistent with the implementation.

**6. Cross-feature interactions — PASS**

- **JSON combinatorics edge-suppression:** unchanged and independent. `renderScene` still builds `joinPairs` from the imported set (iso-4 via `resolveCombination`, iso-8 presence-based) plus derived wall corners ([`src/core/render.ts`](../src/core/render.ts:213), [`src/core/render.ts`](../src/core/render.ts:224)). The tileset is applied later, at compose time, so the two do not interfere. The tileset's 8-neighbour `analyseAdjacency8` is a separate pass from the JSON set's 4-neighbour `analyseAdjacency`.
- **Rampart colour:** `colorActive` still gates colour on the absence of a combinatorics set; the tileset is orthogonal and, where opaque, overrides the palette colour (item 4). No regression.
- **No-tileset regression guard:** with `extras.tileset` undefined the compose path is byte-identical to before ([`test/tileset-import.test.ts`](../test/tileset-import.test.ts:133)).
- **Slope-aware faces:** both `faceKey` (export) and `templateKey` (import) include `slope`/`slopeDirection`, so sloped and flat walls are distinct faces and match correctly ([`src/core/tileset.ts`](../src/core/tileset.ts:401), [`src/core/tileset.ts`](../src/core/tileset.ts:504)).

**7. Requester's intent — PASS**

- "for all the faces used in the active scene, a set of discrete block images representing all permutations of how they match up" → `buildTileset` emits 47 discrete PNGs per distinct scene face ([`src/core/tileset.ts`](../src/core/tileset.ts:614), [`src/core/tileset.ts`](../src/core/tileset.ts:637)).
- "import a finished set drawn in Procreate and display them on the appropriate tile instead of the gray textures" → `importTileset` + `buildTilesetPlacements` + `composeImage` replace the grey texture per tile by its neighbour config ([`src/lib/tileset.ts`](../src/lib/tileset.ts:77), [`src/core/tileset.ts`](../src/core/tileset.ts:459), [`src/core/compose.ts`](../src/core/compose.ts:221)).

### 8.4 Prioritized gaps / follow-ups

**Low**

1. **Importer does not validate PNG dimensions against the manifest.** §10(b)(3) required "PNG dimensions match the manifest (or are a known multiple)". `importTilesetBytes` decodes and uses the decoded dimensions, ignoring the manifest's `width`/`height`, so a wrong-size PNG is accepted silently ([`src/lib/tileset.ts`](../src/lib/tileset.ts:96)). Add a dimension check (warn or reject).
2. **`templateKey` / `faceKey` duplication.** The import-side `templateKey` ([`src/core/tileset.ts`](../src/core/tileset.ts:401)) and export-side `faceKey` ([`src/core/tileset.ts`](../src/core/tileset.ts:504)) are the same key built twice; a single shared helper would prevent drift.
3. **No end-to-end export→import→compose test with real PNGs.** The zip round-trip uses a fake encoder/decoder ([`test/tileset-import.test.ts`](../test/tileset-import.test.ts:69)); the canvas PNG path ([`src/lib/tileset.ts`](../src/lib/tileset.ts:13), [`src/lib/tileset.ts`](../src/lib/tileset.ts:54)) is untested (DOM-only, so acceptable, but worth a note).

**Informational (not defects)**

4. §10(b)(2) suggested reusing the `joinPairs` mechanism for open-face flags; the implementation instead uses a dedicated per-config pixel pass, `suppressOpenEdges` ([`src/core/tileset.ts`](../src/core/tileset.ts:548)). This is a reasonable, arguably cleaner alternative and is tested; the spec text could be updated to record it.
5. The three verification commands remain to be run in a shell-capable mode (§8.1).

### 8.5 Overall verdict

**PASS.** The rework implements the requester's open-corner enumeration (47 configs, distribution `{0:16,1:16,2:10,3:4,4:1}`, mask 0 included), exports discrete drawable PNG templates per scene face as a zip + manifest matching §10, imports and persists them (IndexedDB) with per-tile neighbour-config compositing, rotation handling, and grey fallback, and enforces **tileset > rampart colour > grey** in every compose path. It coexists cleanly with the retained JSON combinatorics edge-suppression and the rampart colour layer. The only open items are three low-severity follow-ups and the unrun build/test commands.
