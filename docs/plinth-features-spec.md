# plinth — Feature Implementation Spec

**Status:** Draft for review
**Author:** Architect mode
**Source of truth for:** the seven follow-up implementation tasks listed below.
**Repository:** `therebelrobot/plinth` at `/Users/aster/git/therebelrobot/plinth`

This document is the authoritative design for the requested features. Each feature
section records (a) current behavior with exact file + line references, (b) the
proposed design, (c) files to change, (d) data-model/type changes, (e) server/API
changes, (f) test coverage, and (g) risks/edge cases.

> **Normative language:** "MUST", "SHOULD", "MAY" are used in the RFC 2119 sense.
> "Line N" references are to the files as they exist at the time of writing and may
> drift; the quoted code is the anchor of record.

---

## 0. Architecture baseline (what exists today)

### 0.1 Runtime shape

- Single-page React app (`src/`) built by Vite to `dist/public` ([`package.json`](package.json:14), [`vite.config.ts`](vite.config.ts:6)).
- One Node server, zero runtime dependencies, built by esbuild to `dist/server.mjs` ([`package.json`](package.json:16)).
- Dev runs two processes: `npm run dev:server` (tsx watch, `:3000`) and `npm run dev` (Vite, `:5173`, proxying `/api` → `:3000`) ([`package.json`](package.json:12), [`vite.config.ts`](vite.config.ts:9)).
- Storage is one SQLite table of whole JSON scene documents ([`server/store.ts`](server/store.ts:8)).

### 0.2 The core data model

Defined in [`src/core/types.ts`](src/core/types.ts:1):

- `PrimitiveType` union — `block | wall | stairs | ramp | cylinder | sphere | cone | pyramid | arch` ([`src/core/types.ts`](src/core/types.ts:8)).
- `Rotation` = `0 | 1 | 2 | 3` quarter-turns ([`src/core/types.ts`](src/core/types.ts:20)).
- `SceneObject` — `id, type, x, y, z, width, depth, height, rotation, parameter?` ([`src/core/types.ts`](src/core/types.ts:22)). Units: `x/y` in tiles, `z/height` in levels; a `1×1×1` object is a geometric cube ([`src/core/types.ts`](src/core/types.ts:4)).
- `SceneSettings` — tile/level pixel sizes, floor size, headroom, base thickness, padding, snap ([`src/core/types.ts`](src/core/types.ts:40)).
- `SceneDocument` — `{ version: 1, name, settings, objects }` ([`src/core/types.ts`](src/core/types.ts:58)).
- `RenderOptions` — shading/bands/outlines/mergeCoplanarFaces/floor/grid/background/hideAboveLevel ([`src/core/types.ts`](src/core/types.ts:69)).

### 0.3 The renderer (this is where most features land)

Per-pixel analytic raycaster with a z-buffer. There is **no painter's sort**; nearest
hit wins ([`src/core/render.ts`](src/core/render.ts:1)).

- `prepareShape(type, a, b, h, parameter)` builds a `CanonicalShape`; ramp and pyramid get
  half-space plane arrays ([`src/core/geometry.ts`](src/core/geometry.ts:161)).
- `intersectCanonical(...)` handles each primitive in its canonical un-rotated frame
  ([`src/core/geometry.ts`](src/core/geometry.ts:184)). Directions:
  - wall = slab hugging the low-x edge, `lx ∈ [0, thickness]` ([`src/core/geometry.ts`](src/core/geometry.ts:194)).
  - ramp = box ∩ `{ lz ≤ h·(1 − lx/a) }`, i.e. plane `(h/a)·lx + lz ≤ h` ([`src/core/geometry.ts`](src/core/geometry.ts:163)).
  - stairs = union of `n` boxes climbing toward low-x ([`src/core/geometry.ts`](src/core/geometry.ts:199)).
  - pyramid = base + four faces to a centre apex ([`src/core/geometry.ts`](src/core/geometry.ts:167)).
  - arch = slab minus a round-top opening ([`src/core/geometry.ts`](src/core/geometry.ts:281)).
- `rasterise(...)` maps each screen pixel into an object's local frame per rotation and
  writes depth/owner/normal/planeOffset ([`src/core/render.ts`](src/core/render.ts:93)).
- The edge pass: two adjacent pixels form an edge when they differ; merge across different
  owners only when `mergeCoplanarFaces` and `sameFlatSurface` (same normal, planeOffset
  within `1e-3`) ([`src/core/render.ts`](src/core/render.ts:215), [`src/core/render.ts`](src/core/render.ts:224)).
- `OWNER_NONE = -1`, `OWNER_FLOOR = -2` ([`src/core/render.ts`](src/core/render.ts:12)).

### 0.4 Composition / output (greyscale only today)

- `toneAt(...)` returns a **grey 0–255** per covered pixel ([`src/core/compose.ts`](src/core/compose.ts:33)).
- `write(rgba, index, grey)` writes the same grey into R, G, B and alpha 255 ([`src/core/compose.ts`](src/core/compose.ts:73)). **There is no per-object colour anywhere.**
- `composeLayers(...)` produces PSD layers `Floor`, `Floor grid`, `Level 0…n`, `Outlines` ([`src/core/compose.ts`](src/core/compose.ts:120)).
- Ramp light constants: `OBJECT_RAMP = [64, 232]`, `FLOOR_RAMP = [118, 204]` ([`src/core/compose.ts`](src/core/compose.ts:16)).
- PSD writer is 8-bit RGB+A PackBits ([`src/core/psd.ts`](src/core/psd.ts:1)); zip is store-only ([`src/core/zip.ts`](src/core/zip.ts:1)).

### 0.5 Primitive presets and palette

Defined in [`src/core/primitives.ts`](src/core/primitives.ts:19). Each preset is
`{ key, label, type, width, depth, height, parameter?, shortcut }`. Level-changing
presets today: `stairs` (parameter = steps), `ramp`, `pyramid`. `PARAMETER_SPECS`
maps `stairs→Steps`, `wall/arch→Thickness` ([`src/core/primitives.ts`](src/core/primitives.ts:56)).
`DIRECTIONAL_TYPES = { wall, stairs, ramp, arch }` ([`src/core/primitives.ts`](src/core/primitives.ts:46)).

### 0.6 Server surface

[`server/main.ts`](server/main.ts:79) routes:

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/scenes` | list |
| POST | `/api/scenes` | create (random id) |
| GET | `/api/scenes/:id` | fetch |
| PUT | `/api/scenes/:id` | upsert |
| DELETE | `/api/scenes/:id` | delete |
| any | non-`/api` | static files + SPA fallback ([`server/main.ts`](server/main.ts:116)) |

`validDocument(...)` is a shape check only ([`server/main.ts`](server/main.ts:64)).
There is **no authentication of any kind** in the server.

### 0.7 Client API layer

[`src/lib/api.ts`](src/lib/api.ts:24): `request()` throws on `!response.ok`, no status
inspection, no auth header/cookie handling. `sceneApi` wraps list/get/create/save/remove.
Drafts live in `localStorage` ([`src/lib/api.ts`](src/lib/api.ts:46)).

### 0.8 Build / test / commit conventions

- **Node:** `>=22.13` ([`package.json`](package.json:8)); TS 7, React 19, Vite 8, esbuild.
- **Scripts** ([`package.json`](package.json:11)):
  - `dev` (vite) · `dev:server` (`tsx watch server/main.ts`)
  - `build` = `build:client` (`vite build`) + `build:server` (`esbuild server/main.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/server.mjs`)
  - `start` (`node dist/server.mjs`) · `typecheck` (`tsc --noEmit`) · `test` (`node --import tsx --test test/*.test.ts`)
  - `docker:build` / `docker:run` / `docker:push`
  - `release:patch|minor|major` → `npm version … && git push --follow-tags` ([`package.json`](package.json:23)).
- **Test runner:** Node's built-in `node:test` via `tsx`. Pure-core tests import from `src/core`. The PSD/zip export test shells out to `python3` + `psd-tools`/`zipfile` and **skips** if unavailable ([`test/export.test.ts`](test/export.test.ts:37)).
- **Test fixtures:** [`test/sample-scene.ts`](test/sample-scene.ts:4) `makeObject(...)` / `sampleObjects()`; [`test/png-node.ts`](test/png-node.ts:29) `encodePng`; [`test/preview.ts`](test/preview.ts:1) dev PNG dump.
- **CI/release:** [`.github/workflows/release.yml`](.github/workflows/release.yml:13) — on `v*` tags: `npm ci` → `typecheck` → `test`, then multi-arch (amd64+arm64) GHCR build with signed provenance. Actions are pinned by SHA in practice.
- **No linter / formatter** config is present. Code style is enforced by `tsc` strict + repo norms only.
- **Commit convention:** formal releases are tag-driven via `npm version` (`release: %s`). There is no enforced conventional-commit hook; implementation tasks SHOULD use `feat:`/`fix:`/`docs:` prefixed messages for clarity.
- **Repo rules that bind implementation** (from `.roo/rules`): edit files with Roo tools (never `sed`/`awk`); add/remove npm deps only via `npm`; use `-w <project>` from root for workspace scripts (single-package here, so direct `npm` at root is correct); build/test must stay dependency-light (the server is deliberately zero-dependency).

### 0.9 Verification recipe for every task

```sh
npm run typecheck      # must pass
npm test               # must pass (PSD/zip tests self-skip without python)
npm run build          # client + server must build
# manual: npm run dev:server & npm run dev → open :5173
```

---

## Feature 1 — ENV-VAR SERVER TOKEN AUTH GATE

### 1(a) Current behavior

- The server authenticates **nothing**. [`server/main.ts`](server/main.ts:139) handles every
  request (API and static) unconditionally.
- Env vars read today: `PORT`, `HOST`, `DATA_DIR`, `STATIC_DIR` ([`server/main.ts`](server/main.ts:13)), plus the Dockerfile's `NODE_ENV`, `NODE_NO_WARNINGS` ([`Dockerfile`](Dockerfile:14)).
- README documents "currently handled by an external reverse proxy / basic auth" (task
  brief); the repo itself contains no auth code.
- The client never sends credentials: [`src/lib/api.ts`](src/lib/api.ts:24) `request()`
  only sets `content-type`.
- Static assets are served with a SPA fallback for unknown paths ([`server/main.ts`](server/main.ts:120)), so gating "the app" means gating **all** paths, not just `/api`.
- Docker `HEALTHCHECK` calls `GET /api/health` ([`Dockerfile`](Dockerfile:25)).

### 1(b) Proposed design

**Goal:** a single secret in the environment gates the entire application and every API.

**Token source**

- New env var `PLINTH_TOKEN`. Read once at startup in `server/main.ts`:
  `const authToken = (process.env.PLINTH_TOKEN ?? '').trim();`
- If empty/unset → auth is **disabled** (backwards compatible). Log a loud warning:
  `plinth: PLINTH_TOKEN is not set — the app is UNPROTECTED`.
- Optional companion vars:
  - `PLINTH_COOKIE_SECURE` (`auto` | `true` | `false`, default `auto`) — controls the
    `Secure` cookie attribute when TLS terminates upstream.
  - `PLINTH_SESSION_TTL` (seconds, default `2592000` = 30 days).

**Session model (cookie-based, because static must be gated)**

The initial document load and `<img>`/`<script>` subresources cannot carry an
`Authorization` header, so a header-only gate cannot protect the app itself. Use a
signed, `HttpOnly` session cookie, with an optional `Authorization: Bearer` path for
non-browser clients.

- On successful login, the server issues a session cookie derived with HMAC so no
  server-side session store is needed:
  `session = base64url( hmacSHA256(key = authToken, msg = issuedAtMs) ) + '.' + issuedAtMs`
- Validation recomputes the HMAC and checks `now − issuedAt ≤ TTL`. Constant-time compare
  via `crypto.timingSafeEqual`.
- Cookie: `plinth_session=<session>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<ttl>`
  plus `; Secure` when secure mode is on. `SameSite=Strict` also mitigates CSRF for the
  state-changing scene routes.

**Request gate (covers API *and* static)**

Insert a single `authorize(request, url)` check at the top of the request handler in
[`server/main.ts`](server/main.ts:139), **before** the `/api` vs static split:

```
if (authToken) {
  const ok = hasValidSession(request) || hasBearerToken(request) || isPublicPath(url.pathname);
  if (!ok) {
    if (url.pathname.startsWith('/api/')) return sendJson(response, 401, { error: 'unauthorized' });
    return serveLoginPage(response);   // server-rendered login HTML for the app
  }
}
```

- `isPublicPath` exempts only `/api/health` (so the container `HEALTHCHECK` still works).
  All other paths, including `/`, `/index.html`, `/assets/*`, `/manifest.webmanifest`,
  are gated.
- `/api/health` MAY be gated instead if the operator prefers; then the healthcheck needs
  the token. Default: exempt (it returns no sensitive data).

**Login flow (no pre-built client needed)**

Because the SPA bundle is itself gated, the login UI MUST be served by the server:

- New route `POST /api/auth/session` — body `{ token }`. On match, set the cookie and
  return `{ ok: true }`; on mismatch return 401 (with a small constant delay to slow
  guessing). This route is reachable pre-auth.
- New route `POST /api/auth/logout` — clears the cookie (also pre-auth-safe).
- `GET /api/auth/session` — returns `{ authenticated: boolean }`, used by the client to
  detect expiry.
- `serveLoginPage(response)` returns a self-contained HTML document (inline CSS, a single
  `<form>`) that POSTs the token to `/api/auth/session` and reloads on success. No build
  step, no dependency — consistent with the zero-dependency server.
- The same HTML is used whether the request was for `/` or for a hashed asset, so a
  lapsed session never leaks a partial app shell.

**Frontend behavior**

- [`src/lib/api.ts`](src/lib/api.ts:24): extend `request()` to read `response.status`.
  On `401`, dispatch `window.dispatchEvent(new Event('plinth:unauthorized'))` and throw a
  typed error. `credentials: 'same-origin'` is the browser default for same-origin
  `fetch`, so cookies ride along automatically; state it explicitly for clarity.
- [`src/App.tsx`](src/App.tsx:43): add a listener for `plinth:unauthorized` that shows a
  "Session expired — reload to sign in" overlay; the reload re-triggers the server login
  page. (The in-app path is a safety net; the primary login is server-rendered.)
- No token is ever stored in `localStorage`; the `HttpOnly` cookie is the persistence
  mechanism. This also means the offline draft path ([`src/lib/api.ts`](src/lib/api.ts:46))
  continues to work while the server is unreachable.

**Dev parity**

Vite proxies `/api` to `:3000` ([`vite.config.ts`](vite.config.ts:9)), so the cookie is
same-origin in dev too. In dev, Vite serves the static app and the Node server only sees
`/api`; the server-side login page is bypassed, which is acceptable because dev is not the
threat model. Document that `PLINTH_TOKEN` on the Node process still gates the dev API.

### 1(c) Files to change

| File | Change |
|---|---|
| `server/auth.ts` (new) | Token read, HMAC session sign/verify, `hasValidSession`, `isPublicPath`, constant-time compare, login-page HTML. |
| [`server/main.ts`](server/main.ts:1) | Import auth; add `authorize` gate at the top of the request handler; add `POST /api/auth/session`, `POST /api/auth/logout`, `GET /api/auth/session`; keep `/api/health` public. |
| [`server/store.ts`](server/store.ts:1) | **No change** (auth is orthogonal to storage). |
| [`src/lib/api.ts`](src/lib/api.ts:24) | Status-aware `request()`; `credentials`, 401 event; `authApi` helpers. |
| [`src/App.tsx`](src/App.tsx:43) | Unauthorized-event overlay. |
| [`README.md`](README.md:26) | Document `PLINTH_TOKEN` and the auth model in the env table. |
| [`docker-compose.yml`](docker-compose.yml:1) | Document `PLINTH_TOKEN` in a comment / optional `environment`. |
| `Dockerfile` | Comment noting `/api/health` stays public for the healthcheck. |

### 1(d) Data model / type changes

- No scene-document change.
- New server-internal types in `server/auth.ts`: `SessionPayload { issuedAt: number }`.
- Client: a small `AuthError` class in [`src/lib/api.ts`](src/lib/api.ts:1) carrying `status`.

### 1(e) API endpoints / server changes

- `POST /api/auth/session` `{ token } → 200 { ok:true } | 401` — sets cookie.
- `POST /api/auth/logout → 200 { ok:true }` — clears cookie.
- `GET /api/auth/session → 200 { authenticated:boolean }`.
- All existing `/api/*` and all static routes require a valid session/bearer when
  `PLINTH_TOKEN` is set. `/api/health` remains public by default.

### 1(f) Test coverage

New `test/auth.test.ts` (Node `node:test`, spin up `createServer` on port `0`):

1. `PLINTH_TOKEN` unset → `/api/scenes` returns 200 (open).
2. Token set, no credential → `/api/scenes` 401 and `/` serves the login page (contains a `<form>`).
3. Correct `Authorization: Bearer <token>` → 200.
4. `POST /api/auth/session` with the wrong token → 401; correct token → `Set-Cookie`.
5. Replaying the cookie → subsequent `/api/scenes` 200; tampered cookie → 401.
6. Expired session (issue with a mocked clock / short TTL) → 401.
7. `/api/health` → 200 without credentials even when the token is set.
8. (Regression) token unset → `/` serves `index.html`/SPA, unchanged.

Unit-test the HMAC round-trip and `isPublicPath` directly as pure functions.

### 1(g) Risks / edge cases

- **Token in process args/logs:** read only from env; never log the value (log only "set"/"unset").
- **`Secure` behind a TLS-terminating proxy:** default `auto` should infer from
  `x-forwarded-proto` when present; otherwise the operator sets `PLINTH_COOKIE_SECURE=true`.
  Wrong value either breaks iPad login (Secure over HTTP) or weakens transport.
- **CSRF:** `SameSite=Strict` mitigates; document that cross-site embedding of the app is
  intentionally unsupported.
- **iPad/Safari cookie behavior:** `HttpOnly`+`SameSite=Strict` is well supported; the
  standalone PWA shares the cookie.
- **Offline drafts:** must keep working; the localStorage path does not depend on auth.
- **Healthcheck:** if an operator gates `/api/health`, the container will flip to
  unhealthy — the README/Dockerfile must say so.
- **Reload loops:** the client must not spin on repeated 401s; the login page is
  server-rendered so a reload lands on it directly.
- **Dev vs prod divergence:** Vite bypasses the static gate in dev — documented, acceptable.
- **Timing attacks:** constant-time compare + a fixed delay on login failure.

---

## Feature 2 — COMBINATORICS EXPORT

> **SUPERSEDED for the requester's intent — see §10.** The requester has clarified that
> "export/import combinatorics" means an **image tileset** (discrete PNG block images, one
> per neighbour-match permutation), **not** this JSON metadata document. This section and
> §3 are retained only because the JSON set still drives the renderer's edge-suppression
> pass (`joinPairs`, [`src/core/render.ts`](src/core/render.ts:201)) and Feature 4's
> wall-corner joins. They are **not** the deliverable the requester asked for. The
> image-tileset design is §10.

### 2(a) Current behavior

- The primitive model is a flat `SceneObject` ([`src/core/types.ts`](src/core/types.ts:22) and §0.2). There is no notion of how tiles connect to neighbours.
- Adjacency is only handled implicitly and globally by `mergeCoplanarFaces` in the edge pass ([`src/core/render.ts`](src/core/render.ts:224), §0.3).
- Primitive sizes are palette presets ([`src/core/primitives.ts`](src/core/primitives.ts:19)); a scene's *used* primitives are the distinct `type` values (and sizes) in `document.objects`.
- The existing JSON exporter serializes the whole document ([`src/lib/exporters.ts`](src/lib/exporters.ts:184)); the primitive-kit `.zip` export enumerates presets × rotations with anchor offsets ([`src/lib/exporters.ts`](src/lib/exporters.ts:110)).

### 2(b) Proposed design

"Combinatorics" = the connectivity classes of a primitive tile, enumerated as
center / edge / corner (plus end and single, which are the degenerate classes). The
export produces a JSON document that, for each primitive type present in the scene,
enumerates those classes with a canonical representative and a template for the surface.

**Connectivity scheme**

- Primary scheme `iso-4`: the four in-plane neighbours `N, E, S, W` → a 4-bit mask `0..15`.
  Canonicalize by the 4 rotations: masks form rotation classes. The canonical classes:
  - `single` (mask 0000) — no connections
  - `end` (0001) — one connection (also a "cap")
  - `straight` (0101) — two opposite connections (incl. `edge` running through)
  - `corner` (0011) — two perpendicular connections (the basic named **corner**)
  - `tee` (0111) — three connections
  - `center` (1111) — four connections (the basic named **center**)
- Optional scheme `iso-8` (adds diagonals, 8-bit, 47 canonical classes) — off by default
  to keep the file small; exposed as an `--iso8` toggle in the UI.

**Rotation canonicalization**

For each of the 16 masks, compute the four rotations (`rotateMask(mask, r)`), group by
equality, keep the numerically smallest mask as the representative, and record
`{ id, mask, rotations: [{ rotation, mask }] }`. `corner` therefore has four
orientations, `end` four, `straight` two, `center`/`single` one.

**Primitive scoping**

The export includes a `primitives[]` entry for every distinct `type` (optionally
`type×footprint`) found in `document.objects`. Each entry carries a `template`: the
`SceneObject` shape minus `id` (`{ type, width, depth, height, rotation: 0, parameter }`),
so an importer can reconstruct a representative tile.

**Proposed `CombinatoricsExport` document**

```jsonc
{
  "format": "plinth.combinatorics",
  "version": 1,
  "generator": "plinth",
  "exportedAt": "2026-10-09T22:00:00.000Z",
  "scheme": "iso-4",
  "sides": ["N", "E", "S", "W"],
  "projection": { "tileWidthPixels": 32, "levelHeightPixels": 16 },
  "primitives": [
    {
      "type": "wall",
      "template": { "type": "wall", "width": 1, "depth": 1, "height": 2, "rotation": 0, "parameter": 0.25 },
      "combinations": [
        { "id": "single",   "mask": 0,  "rotations": [{ "rotation": 0, "mask": 0 }] },
        { "id": "end",      "mask": 1,  "rotations": [
            { "rotation": 0, "mask": 1 }, { "rotation": 1, "mask": 2 },
            { "rotation": 2, "mask": 4 }, { "rotation": 3, "mask": 8 }] },
        { "id": "straight", "mask": 5,  "rotations": [{ "rotation": 0, "mask": 5 }, { "rotation": 1, "mask": 10 }] },
        { "id": "corner",   "mask": 3,  "rotations": [
            { "rotation": 0, "mask": 3 }, { "rotation": 1, "mask": 6 },
            { "rotation": 2, "mask": 12 }, { "rotation": 3, "mask": 9 }] },
        { "id": "tee",      "mask": 7,  "rotations": [
            { "rotation": 0, "mask": 7 }, { "rotation": 1, "mask": 14 },
            { "rotation": 2, "mask": 13 }, { "rotation": 3, "mask": 11 }] },
        { "id": "center",   "mask": 15, "rotations": [{ "rotation": 0, "mask": 15 }] }
      ]
    }
  ]
}
```

- `sides` order is the bit order (bit 0 = N, bit 1 = E, bit 2 = S, bit 3 = W).
- Named classes `center`, `edge` (alias of `straight`), and `corner` are always emitted;
  `single`, `end`, `tee` are emitted for completeness.
- `template` + `rotations` lets an importer map a mask to a concrete placed object.

**Algorithm**

1. Collect distinct `(type, width, depth, height, parameter)` from `document.objects`.
2. For each, emit `template` and the canonicalized 16-mask table (filtered to the chosen scheme).
3. Write JSON with a stable key order for diffability.

### 2(c) Files to change

| File | Change |
|---|---|
| `src/core/combinatorics.ts` (new) | Pure functions: `rotateMask`, `canonicalCombinations`, `buildCombinatorics(document, options)`, `SIDES`, class naming. |
| [`src/lib/exporters.ts`](src/lib/exporters.ts:184) | Add `exportCombinatoricsJson(document, options) → { blob, filename }` (mirrors `exportSceneJson`). |
| [`src/ui/Panels.tsx`](src/ui/Panels.tsx:220) | Add an Export-panel button "Combinatorics (JSON)" and an `iso-4/iso-8` toggle. |
| [`src/App.tsx`](src/App.tsx:436) | No structural change; the panel already receives `document`. |

### 2(d) Data model / type changes

- New exported types in `src/core/combinatorics.ts`: `CombinationClass`,
  `Combination`, `PrimitiveCombinatorics`, `CombinatoricsExport`, `CombinatoricsScheme`.
- No change to `SceneDocument` for export (read-only derivation).

### 2(e) API endpoints / server changes

- None. Export is client-side, delivered via [`deliverFile`](src/lib/exporters.ts:40). No stored document field is required for *export*.

### 2(f) Test coverage

New `test/combinatorics.test.ts`:

1. `rotateMask` is a correct cyclic bit rotation; 4 applications are identity.
2. Canonicalization of all 16 masks yields exactly the expected class partition sizes
   (1 + 4 + 2 + 4 + 4 + 1 = 16).
3. `center`/`edge`/`corner` are always present; `corner` has four rotations.
4. `buildCombinatorics` on `sampleObjects()` emits entries for `wall`, `stairs`, `ramp`,
   `pyramid`, `arch`, etc. — exactly the distinct types in the scene.
5. The output round-trips through `JSON.parse` and matches `format`/`version`.
6. `iso-8` toggle expands the class count without breaking `iso-4`.

### 2(g) Risks / edge cases

- **Ambiguity of "edge":** in tile-autotiling "edge" can mean a straight run or a border
  tile. This spec fixes the meaning: `edge` ≡ `straight` (two opposite connections).
  Document it in the file and the panel tooltip.
- **Footprint-scoped vs type-scoped:** walls of different thicknesses are different
  combinatorics; the exporter keys by template, so both are represented. Confirm with the
  requester whether to key by `type` alone or by full template (this spec keys by template
  and notes it).
- **8-neighbour scheme explosion:** 47 classes is a large file — keep it opt-in.
- **Rotation canonicalization off-by-one:** test rigorously (order `N,E,S,W`).
- **Non-directional primitives:** `center`/`end` are meaningless for a sphere; emit the
  full table anyway but flag `directional: boolean` (from `DIRECTIONAL_TYPES`) so importers
  can ignore irrelevant classes.

---

## Feature 3 — COMBINATORICS IMPORT (as primitive surfaces)

> **SUPERSEDED for the requester's intent — see §10.** As with §2, the requester's
> "import combinatorics" means loading a finished **image tileset** and displaying the
> correct tile image per neighbour configuration, **not** importing this JSON surface map.
> Retained for the renderer's edge pass; the image-tileset import is §10.

### 3(a) Current behavior

- No import path for combinatorics exists ([`src/ui/Panels.tsx`](src/ui/Panels.tsx:331)
  imports a `SceneDocument` only).
- Surfaces are defined purely by geometry + the global `mergeCoplanarFaces` toggle
  ([`src/core/render.ts`](src/core/render.ts:224)). A face does not know whether a
  neighbour is a matching primitive.
- `placement.ts` already knows adjacency at *place* time (it examines the z-buffer for a
  target surface, [`src/core/placement.ts`](src/core/placement.ts:69)) but never records
  connectivity.

### 3(b) Proposed design

Import the Feature-2 JSON and use its connectivity classes to drive **which surfaces of a
primitive are "open" (joined to a neighbour) versus "closed" (exposed)**. The imported set
becomes an authoritative surface map layered over the geometry.

**Where the set lives**

- Add an optional field to the document so it persists and syncs with the scene:
  `SceneDocument.combinatorics?: CombinatoricsSet` ([`src/core/types.ts`](src/core/types.ts:58)).
  Persisted via the existing whole-document save ([`server/store.ts`](server/store.ts:22));
  the server's `validDocument` shape check ignores unknown fields, so no server change is
  strictly required (optional: extend it to validate `combinatorics` when present —
  see §3(e)).

**Import path**

1. User picks a `plinth.combinatorics` JSON in the Export panel.
2. `parseCombinatorics(text)` validates `format === 'plinth.combinatorics'`,
   `version === 1`, `scheme`, and each `primitives[].combinations[]`. Invalid input is
   rejected with a clear toast (mirrors the existing import error handling at
   [`src/ui/Panels.tsx`](src/ui/Panels.tsx:342)).
3. The validated set is attached to the document via a `history.commit` so it is undoable.

**Mapping onto primitive surfaces**

Define a canonical set of surfaces per primitive: `TOP, BOTTOM, PX, NX, PY, NY`
(+X/−X/+Y/−Y). Import maps each connectivity class to face flags:

- `center` (mask 1111) → all four side faces `open`, no side edges.
- `edge`/`straight` (two opposite) → the two abutted side faces `open`; the two remaining
  sides `closed`.
- `corner` (two adjacent) → the two abutted sides `open`; the other two `closed`.
- `end` (one) → one side `open`.
- `single` → none `open`.

At render time (or import time) each placed object's mask is derived from the actual
scene by checking the four in-plane neighbours for a compatible primitive:

```
neighbourMask(object) =
  (hasNeighbour(object, N) ? 1 : 0) | (E ? 2) | (S ? 4) | (W ? 8)
```

- "Compatible" = same `type` and the abutting faces touch (share a plane within the scene
  snap tolerance). This reuses the same `1e-3` tolerance used by `sameFlatSurface`
  ([`src/core/render.ts`](src/core/render.ts:221)).
- The derived mask is canonicalized with the same `rotateMask` logic and looked up in the
  imported table; the resulting `open/closed` flags are surfaced.

**How the flags affect output**

- **Edge/outline pass:** an `open` side face does not contribute a silhouette edge where
  it meets its neighbour (generalizing `mergeCoplanarFaces` to adjacency-aware joins).
- **Optionally, geometry:** the imported class MAY supply a per-face geometry/join hint
  (e.g., mitre at a corner). This is where Feature 4's corner fix connects: the `corner`
  class can carry the join geometry so perpendicular walls meet cleanly.
- Flags are computed in a new pass and stored in the render buffers (e.g. a per-pixel
  `open` bitmask) so both editor and export agree (the codebase's "editor and export
  always match" invariant, [`README.md`](README.md:81)).

**Fallback**

- When no combinatorics are imported, behavior is exactly today's geometry +
  `mergeCoplanarFaces`. This is also the hook Feature 7 keys off ("when NOT using imported
  combinatorics").

### 3(c) Files to change

| File | Change |
|---|---|
| `src/core/combinatorics.ts` | Add `parseCombinatorics`, `CombinatoricsSet`, `neighbourMask`, `resolveClass`, face-flag helpers. |
| [`src/core/types.ts`](src/core/types.ts:58) | Add `SceneDocument.combinatorics?: CombinatoricsSet`. |
| [`src/core/render.ts`](src/core/render.ts:93) | Compute neighbour masks (pass over `objects`) and store per-object/per-pixel open flags; consult them in the edge pass. |
| [`src/core/compose.ts`](src/core/compose.ts:120) | Honour open flags when writing outlines / layer boundaries. |
| [`src/ui/Panels.tsx`](src/ui/Panels.tsx:220) | "Import combinatorics (JSON)" control; show active set name; clear/replace action. |
| [`src/App.tsx`](src/App.tsx:436) | Thread the import through `history.commit`. |
| [`server/main.ts`](server/main.ts:64) | *Optional:* extend `validDocument` to validate `combinatorics` when present (recommended). |

### 3(d) Data model / type changes

```ts
// src/core/types.ts
export interface CombinatoricsSet {
  format: 'plinth.combinatorics';
  version: 1;
  scheme: 'iso-4' | 'iso-8';
  source?: { name?: string; exportedAt?: string };
  primitives: PrimitiveCombinatorics[]; // shape from Feature 2
}

export interface SceneDocument {
  // …existing…
  combinatorics?: CombinatoricsSet;
}
```

- Versioning: a `version` bump is a one-way door; importers MUST reject unknown versions
  rather than guess.

### 3(e) API endpoints / server changes

- No new endpoints. The document already round-trips whole ([`server/main.ts`](server/main.ts:83)).
- Recommended: `validDocument` gains an optional `combinatorics` shape check so garbage is
  rejected at the boundary (consistent with the "refuse obvious garbage" philosophy at
  [`server/main.ts`](server/main.ts:63)).

### 3(f) Test coverage

New `test/combinatorics-import.test.ts`:

1. `parseCombinatorics` accepts the Feature-2 export and rejects wrong `format`/`version`.
2. `neighbourMask` over a hand-built L-shaped wall run yields the expected masks
   (`end`, `corner`, `straight`, `center`).
3. Rendering a run of walls with the imported set produces **fewer outline pixels** on the
   interior joins than the same scene without it (mirrors the merge test at
   [`test/render.test.ts`](test/render.test.ts:81)).
4. Imported set survives a document JSON round-trip (`exportSceneJson` → parse).
5. A scene with no neighbours maps every object to `single` and renders identically to the
   legacy path.
6. Persistence: a document with `combinatorics` passes the (extended) `validDocument`.

### 3(g) Risks / edge cases

- **Mask derivation cost:** O(objects) neighbour lookups; keep it a hash-grid lookup, not
  O(n²). Large scenes allow up to 20 000 objects ([`server/main.ts`](server/main.ts:69)).
- **Compatibility definition:** thickness/height mismatches must not count as connections
  (else a thick and a thin wall would falsely merge). Define compatibility by abutting
  plane + matching footprint edge length.
- **Rotation vs mask double-counting:** the object `rotation` and the mask both encode
  orientation; derive the mask in world space to avoid combining them twice.
- **Imported-but-unknown primitive types:** ignore and warn rather than throw.
- **Undo:** attaching the set must be a single history entry.
- **Backwards compatibility:** documents without the field must load and render unchanged.

---

## Feature 4 — WALL EDGE MERGING BUG (walls cannot combine to an edge)

### 4(a) Current behavior (evidence)

- A wall is a **thin slab anchored to the low-x edge** of its footprint:
  `intersectBox(0, thickness, 0, b, 0, h, …)` ([`src/core/geometry.ts`](src/core/geometry.ts:194)). It spans the full `b` (depth) axis and only `thickness` along `a` (width).
- Each object is intersected independently ([`src/core/render.ts`](src/core/render.ts:179)),
  so any "joining" is a **post-hoc** decision in the edge pass.
- Merging across two different objects happens only when `mergeCoplanarFaces` is on **and**
  `sameFlatSurface` holds: same normal and `planeOffset` within `1e-3`
  ([`src/core/render.ts`](src/core/render.ts:215), [`src/core/render.ts`](src/core/render.ts:229)).
- `planeOffset = normalX·worldX + normalY·worldY + nz·worldZ` ([`src/core/render.ts`](src/core/render.ts:148)).
- The wall's outer/inner vertical faces are perpendicular to each other across a corner
  (one is an `x`-normal face, the other a `y`-normal face), so they never satisfy
  `sameFlatSurface` — a seam is drawn at the vertical corner line even when the two walls
  are the same type/thickness.

**Root cause (as provable from the code):**

Two perpendicular wall slabs that meet at the back (low-x/low-y) corner do not share a
coplanar face there, because (i) a wall's canonical cross-section is `[0,thickness]` along
one axis and full-extent along the other, so a corner-turning pair only overlaps in the
small `thickness × thickness` square, and (ii) the merge test is purely geometric
(`same normal` + `same planeOffset`) with no awareness that the two objects are adjacent,
matching walls. Consequently:

- The top faces *do* merge (coplanar, same normal).
- The vertical faces at the corner never merge (perpendicular normals), so a corner seam
  persists; and when the two walls differ in thickness or footprint alignment, even the
  top faces fail to align flush and a step appears that cannot be merged.

> **Uncertainty note:** the exact visible artifact ("cannot merge smoothly") depends on how
> the reporter placed the walls. The mechanism above is what the code enforces; the fix
> below is designed to be correct regardless of which of the two sub-cases is observed.

### 4(b) Proposed design

Make wall joins **adjacency-aware and mitered** rather than relying solely on coincident
planes. Two complementary approaches, to be implemented together:

1. **Adjacency-aware edge suppression (small, safe):**
   Extend the edge pass so that two adjacent, matching wall objects suppress the seam
   **at their shared vertical corner** when they are known to connect. Connectivity comes
   from the Feature-3 `neighbourMask`: if two faces are marked `open` against each other,
   no outline is drawn between them even when their normals differ. This directly fixes the
   "cannot combine to an edge" symptom for matching walls.

2. **Mitered corner geometry (correctness):**
   For the `corner` connectivity class, extend each wall slab at the shared corner so the
   two walls meet as a solid `thickness × thickness` post spanning full height. Concretely,
   add a corner-fill to `prepareShape`/`intersectCanonical` for walls: when a wall's mask
   indicates a perpendicular join on a given end, extend its slab in the run direction to
   `thickness` beyond the footprint edge (a mitre), so the two walls' solids overlap and
   the union is flush. Because intersection is a max-over-parts union already
   ([`src/core/geometry.ts`](src/core/geometry.ts:199) shows the union pattern for stairs),
   a corner post can be added to the wall's own intersection test without a global pass.

These are complementary: (1) removes the spurious seam; (2) guarantees the underlying solid
is contiguous so the top surface is genuinely coplanar and merges.

### 4(c) Files to change

| File | Change |
|---|---|
| [`src/core/geometry.ts`](src/core/geometry.ts:194) | Wall case: add optional corner/end mitre boxes (union) driven by a per-object join descriptor. |
| [`src/core/render.ts`](src/core/render.ts:53) | `prepare()` carries join descriptors; `isEdge`/`sameFlatSurface` consult open-face flags from Feature 3. |
| `src/core/combinatorics.ts` | Reuse `neighbourMask` to produce join descriptors (or a standalone helper if Feature 3 is not yet merged). |
| [`src/core/placement.ts`](src/core/placement.ts:118) | `isOccupiedBySame` MAY be extended if auto-corner pieces are placed, but the preferred fix is render-time (no new objects). |

### 4(d) Data model / type changes

- Preferred: **no document change** — joins are derived at render time from adjacency.
- If a persistent per-object override is desired, add `SceneObject.connects?: number` (a
  cached mask) but keep it optional and derived. Recommend deriving instead.
- **Implemented:** joins are derived at render time (no document change). A render-time
  toggle `RenderOptions.mergeWallCorners` (default `true`) enables/disables the corner
  merge; it is UI state, not persisted in the document. `analyseWallCorners` in
  [`src/core/combinatorics.ts`](src/core/combinatorics.ts) produces the connected pairs
  (for the edge pass) and the per-object mitre posts (for the wall union).

### 4(e) API endpoints / server changes

- None (client-side rendering fix).

### 4(f) Test coverage

Extend `test/render.test.ts` and/or new `test/wall-join.test.ts`:

1. **Perpendicular corner:** two matching walls forming an L produce a corner with **zero**
   outline pixels on the interior join line, and the top face is contiguous (compare
   outline counts with/without the fix, as in [`test/render.test.ts`](test/render.test.ts:81)).
2. **Collinear run:** a straight run of walls has no interior seams (regression guard).
3. **Mismatched thickness:** a thick wall meeting a thin wall produces a defined corner and
   does not create a floating/split top surface.
4. **No neighbours:** a lone wall renders exactly as today.
5. **Geometry unit:** the wall's corner-post union contains the corner `thickness × thickness`
   column for every level.

### 4(g) Risks / edge cases

- **Over-merging:** suppression must never remove a genuine outside-corner silhouette. Only
  faces that are `open` **against each other** are suppressed.
- **Thickness/height mismatch:** connections require matching abutting edges; unequal
  heights must still show a step on the taller wall's exposed part.
- **Rotation interaction:** mitre direction must follow world orientation (reuse the
  rotation mapping in [`src/core/render.ts`](src/core/render.ts:122)).
- **Performance:** the union adds at most one extra box test per boundary pixel — bounded
  and cheap.
- **Interaction with Feature 3:** implement Feature 3's `neighbourMask` first, or ship a
  minimal standalone adjacency check so Feature 4 is not blocked.

---

## Feature 5 — TALL VARIANTS (0.5×, 1.5×, 2× for level-changing primitives)

### 5(a) Current behavior

- Height is `SceneObject.height` in levels ([`src/core/types.ts`](src/core/types.ts:33)) and
  is already a free float; the inspector allows `0.125 … levelCount − z`
  ([`src/ui/Panels.tsx`](src/ui/Panels.tsx:75)).
- Palette presets fix `height` per entry ([`src/core/primitives.ts`](src/core/primitives.ts:19)):
  block 1, slab 0.5, plate 0.25, wall 2, stairs 1, ramp 1, cylinder 1, sphere 1, cone 1,
  pyramid 1, arch 2.
- **Level-changing** primitives are those whose top surface transitions between levels:
  `ramp` and `stairs` (traversal), plus `pyramid` and `cone` (taper to an apex). `block`,
  `cylinder`, `sphere`, `wall`, `arch` do not "change level" in that sense.
- Crucially, all the affected geometry already scales with `h`:
  - ramp plane uses `h/a` ([`src/core/geometry.ts`](src/core/geometry.ts:165));
  - stairs tops use `h·(i+1)/n` ([`src/core/geometry.ts`](src/core/geometry.ts:207));
  - pyramid planes use `h` ([`src/core/geometry.ts`](src/core/geometry.ts:167)).
  So **no geometry change is required** — only presets and UI.

### 5(b) Proposed design

- Define `LEVEL_CHANGING_TYPES = new Set<PrimitiveType>(['ramp','stairs','pyramid','cone'])`
  in [`src/core/primitives.ts`](src/core/primitives.ts:1).
- Define `TALL_VARIANTS = [0.5, 1, 1.5, 2]` with labels `½×`, `1×`, `1½×`, `2×`.
- Add a `variant` field to `PrimitivePreset` (`tallness: number`) and generate the tall
  presets for the level-changing types:
  - `ramp`/`stairs`/`pyramid`/`cone` get keys like `ramp_tall05`, `ramp`, `ramp_tall15`,
    `ramp_tall2` with `height = base * tallness`.
  - Keep `parameter` (steps/thickness) unchanged; for stairs, taller with the same step
    count means proportionally taller risers (a legit look).
- Add a `Height variant` `Segmented` control to the Object panel, shown only for
  `LEVEL_CHANGING_TYPES`, that sets `height = baseHeight(type) * tallness`. Editing it
  commits a `height` change (undoable, like every other inspector edit,
  [`src/ui/Panels.tsx`](src/ui/Panels.tsx:91)).
- Presets generated in code (not hand-written) keep [`src/lib/exporters.ts`](src/lib/exporters.ts:116)
  (`exportPrimitiveKit` iterates `PRIMITIVE_PRESETS`) and [`src/lib/icons.ts`](src/lib/icons.ts:10)
  automatically in sync — the kit and palette thumbnails gain the variants for free.

**Interaction with rotation/stretch:** `stretchObject` uses `preset.height`
([`src/ui/Viewport.tsx`](src/ui/Viewport.tsx:69)); variant presets therefore stretch to the
variant height. No change needed.

**Slabs/plates precedent:** slabs and plates already demonstrate "same type, different
height" via separate presets ([`src/core/primitives.ts`](src/core/primitives.ts:20)).
Tall variants follow that exact established pattern.

### 5(c) Files to change

| File | Change |
|---|---|
| [`src/core/primitives.ts`](src/core/primitives.ts:19) | Add `LEVEL_CHANGING_TYPES`, `TALL_VARIANTS`, `tallness` on `PrimitivePreset`, generate variant presets, add `baseHeight(type)` helper. |
| [`src/ui/Panels.tsx`](src/ui/Panels.tsx:91) | Add the variant `Segmented` control for level-changing types. |
| [`src/App.tsx`](src/App.tsx:336) | Palette renders the (now longer) `PRIMITIVE_PRESETS`; consider grouping/filtering so the rail stays usable. |
| [`src/lib/exporters.ts`](src/lib/exporters.ts:116) | No change (auto-includes variants); verify kit size stays reasonable. |
| [`src/lib/icons.ts`](src/lib/icons.ts:8) | No change (cache key is `key:rotation`; new keys cache fine). |

### 5(d) Data model / type changes

- `PrimitivePreset` gains `tallness: number` (default `1`).
- Optional: `SceneObject.variant?: number` if a persistent label is wanted, but `height`
  already fully expresses the variant — **recommend not adding a field** and deriving the
  label from `height / baseHeight(type)`.

### 5(e) API endpoints / server changes

- None. `validDocument` already accepts any `height` ([`server/main.ts`](server/main.ts:64)).

### 5(f) Test coverage

New `test/variants.test.ts`:

1. For each level-changing type, render `0.5×/1×/1.5×/2×` at a fixed tile size; assert
   covered pixel count (or sprite height) increases monotonically with `tallness`.
2. Ramp height check: the topmost covered row for the `1×` ramp sits ~`levelHeightPixels`
   above the base; `2×` sits ~`2×levelHeightPixels` above (analogous to the stacking test at
   [`test/render.test.ts`](test/render.test.ts:48)).
3. Stairs: taller variant with the same step count has proportionally taller risers
   (top of the final step scales with height).
4. Presets: every level-changing base preset has exactly four tall variants and the
   `1×` variant equals the base preset's height.
5. Kit export still enumerates every preset × rotation without duplicates (guard the
   `seen` set at [`src/lib/exporters.ts`](src/lib/exporters.ts:115)).

### 5(g) Risks / edge cases

- **Above headroom:** a `2×` variant may exceed `levelCount − z`; the inspector's max
  ([`src/ui/Panels.tsx`](src/ui/Panels.tsx:75)) and `clampTarget` ([`src/core/placement.ts`](src/core/placement.ts:33)) already clamp — verify placement respects it.
- **Stairs step count vs height:** very tall stairs with few steps look stretched; document
  the intended pairing (height variant is independent of step count).
- **Rail growth:** ~28 new palette entries; the rail must not overwhelm. Recommend a small
  variant chooser in the rail rather than one swatch per variant, OR grouping.
- **Shortcut keys:** variants intentionally get no new keybindings (keys are already full,
  [`src/core/primitives.ts`](src/core/primitives.ts:19)).
- **`isOccupiedBySame`** uses exact height ([`src/core/placement.ts`](src/core/placement.ts:118)),
  so different variants are correctly treated as different pieces.

---

## Feature 6 — WALL SLOPES (ramp-like slants for walls)

### 6(a) Current behavior

- Ramp slant is a single cutting plane: `prepareShape('ramp', …)` appends
  `planes.push(h / a, 0, 1, h)` ([`src/core/geometry.ts`](src/core/geometry.ts:165)),
  i.e. the solid is `box ∩ { (h/a)·lx + lz ≤ h }`: full height at `lx = 0`, zero at
  `lx = a`, sloping along the canonical **x** axis.
- Walls have no slant: `intersectBox(0, thickness, 0, b, 0, h, …)`
  ([`src/core/geometry.ts`](src/core/geometry.ts:194)) — a flat-topped slab.
- `intersectHalfSpaces` already implements arbitrary convex half-space intersection
  ([`src/core/geometry.ts`](src/core/geometry.ts:93)), so a sloped wall is expressible with
  a plane array exactly like the ramp.
- Placement already handles non-horizontal tops: a non-flat or curved top defers to the
  object's top height ([`src/core/placement.ts`](src/core/placement.ts:102)).
- `PARAMETER_SPECS.wall` uses `parameter` for **thickness** ([`src/core/primitives.ts`](src/core/primitives.ts:58)),
  so slope needs its own field (can't reuse `parameter`).

### 6(b) Proposed design

Add a `slope` option to walls that cuts the wall's top with a plane analogous to the
ramp's, but oriented along the wall's **run** (the axis a wall spans). Because a wall is
thin along one axis, a slope along the thin axis is imperceptible; the useful slope runs
along the wall's length (canonical **y**, `b`), so a wall rises from one end to the other.

- New optional `SceneObject.slope?: number` ∈ `[0, 1]`:
  - `0` (default) = today's flat-topped wall (no behavior change).
  - `1` = full slope: height goes from `h` at the low-`y` end to `0` at the high-`y` end.
  - intermediate = partial slope (top runs at `h` until `y = (1−slope)·b`, then descends).
- Geometry (canonical frame, wall occupies `x∈[0,t], y∈[0,b], z∈[0,h]`):
  - For a full slope: `box ∩ { (h/b)·ly + lz ≤ h }` → plane `(h/b, 0, 1, h)`.
  - For a partial slope with flat shoulder at the low end and slope over the last
    `slope·b`: two extra half-spaces are needed, which is still convex:
    - keep the box and top plane, and clamp the shoulder with a plane at the shoulder
      start. (Concretely: allow either a simple full-slope, or a shoulder + slope built
      from two planes; the implementation task may start with the full-slope case.)
- Implement in `prepareShape` for `type === 'wall'` when a slope is present: append the
  slope plane(s) to the wall's half-space set and route the wall through
  `intersectHalfSpaces` instead of `intersectBox`.
- Direction: the wall is directional; `rotation` already orients the canonical frame
  ([`src/core/render.ts`](src/core/render.ts:122)), so a slope along +y at rotation 0 becomes
  the correct world direction at each rotation. Slope **direction** (rising toward low-y vs
  high-y) is a UI choice; expose as `slopeDirection: +y | -y` or a sign, defaulting to one.
- Presets: add slope-wall palette presets (`wall_ramp_a`, `wall_ramp_b`, plus the tall
  variants from Feature 5) so users can stamp a sloped wall directly.
- UI: a `Slope` `NumberField`/`Segmented` in the Object panel for walls (only when
  `type === 'wall'`), distinct from the existing `Thickness` field.

**Analogy to ramps:** the ramp plane is `(h/a, 0, 1, h)`; the wall-slope plane is
`(0, h/b, 1, h)` — same construction, rotated to the wall's run axis. "Similar slants as
ramps" is satisfied by using the identical rise/run formulation.

### 6(c) Files to change

| File | Change |
|---|---|
| [`src/core/types.ts`](src/core/types.ts:36) | Add `slope?: number` and `slopeDirection?: 1 | -1` to `SceneObject`. |
| [`src/core/geometry.ts`](src/core/geometry.ts:161) | `prepareShape` wall case: append slope planes; pass slope through `CanonicalShape`. |
| [`src/core/geometry.ts`](src/core/geometry.ts:194) | `intersectCanonical` wall case: use half-spaces when sloped. |
| [`src/core/primitives.ts`](src/core/primitives.ts:19) | Add slope-wall presets; a `PARAMETER_SPECS`-like entry is not suitable (slope is separate). |
| [`src/ui/Panels.tsx`](src/ui/Panels.tsx:91) | Slope control for walls. |
| [`src/lib/exporters.ts`](src/lib/exporters.ts:91) | `primitiveFilename` does not encode slope; add a slope suffix so kit names stay unique. |

### 6(d) Data model / type changes

```ts
export interface SceneObject {
  // …existing…
  /** Walls only. 0 = flat top (default); 1 = full run-axis slope (ramp-like). */
  slope?: number;
  /** Walls only. Which end the slope rises from. Defaults to +1. */
  slopeDirection?: 1 | -1;
}
```

- `CanonicalShape` gains `slope: number` (default 0) and its `planes` include the slope
  half-space(s).
- `parameterOf` is unchanged; slope is independent of thickness.

### 6(e) API endpoints / server changes

- None. `validDocument` accepts the new optional fields (unknown fields ignored). Optional:
  add range validation (`0 ≤ slope ≤ 1`) to `validDocument`.

### 6(f) Test coverage

New `test/wall-slope.test.ts`:

1. Flat wall renders identically with `slope` absent and `slope: 0` (regression).
2. `slope: 1` produces a monotonic top edge: for increasing world `y` along the run, the
   first covered pixel row descends.
3. A `slope: 1` wall of height `h` at its tall end reaches the same top row as a flat wall
   of height `h`; at the short end it reaches the base.
4. Rotation 0..3 orient the slope correctly (top row descends along the expected world axis).
5. Placing on a sloped top defers to the object top rather than snapping to a flat face
   (guards the branch at [`src/core/placement.ts`](src/core/placement.ts:102)).
6. Outline pass draws the slope's top edge as a clean 2:1 staircase (no curved flag).

### 6(g) Risks / edge cases

- **Convexity:** a partial slope with a shoulder is still convex (intersection of
  half-spaces) and can use `intersectHalfSpaces`; verify with tests. If a non-convex shape
  is ever wanted, it needs a union (as stairs do) — out of scope.
- **Thickness vs run:** slope must be along the run axis, not the thickness axis;
  document this so implementers don't slope the thin dimension.
- **Direction semantics:** `slopeDirection` sign must be interpreted in world space after
  rotation; test all four rotations.
- **Interaction with Feature 4:** a sloped wall meeting another wall has a more complex
  join; the corner joiner must respect the slope (exposed `open` faces only).
- **Kit uniqueness:** sloped and flat walls share `type`; the filename encoder
  ([`src/lib/exporters.ts`](src/lib/exporters.ts:91)) must include slope to avoid collisions.
- **Placement stacking:** confirm a block on a sloped wall top behaves (defer branch).

---

## Feature 7 — RAMPART COLOR IMPORT (base color layer)

### 7(a) Current behavior

- plinth's output is **greyscale only**. `write()` sets R=G=B=grey, A=255
  ([`src/core/compose.ts`](src/core/compose.ts:73)).
- Shading is banded Lambert from a fixed light ([`src/core/compose.ts`](src/core/compose.ts:10));
  the only colour hook is the editor highlight (`ComposeExtras.highlightColor`,
  [`src/core/compose.ts`](src/core/compose.ts:67)).
- Exports: PNG (`composeImage`) and layered PSD (`composeLayers`) with layers `Floor`,
  `Floor grid`, `Level 0…n`, `Outlines` ([`src/core/compose.ts`](src/core/compose.ts:120));
  PSD is 8-bit RGB+A but greyscale content ([`src/core/psd.ts`](src/core/psd.ts:1)).
- Scene JSON export exists ([`src/lib/exporters.ts`](src/lib/exporters.ts:184)); there is no
  palette concept anywhere.
- The current template is a "trace base" the artist paints over in Procreate
  ([`README.md`](README.md:39)).

**rampart's export format (verified against the repo `therebelrobot/rampart`):**

`src/storage/library.ts` defines:

```ts
export interface SavedPalette {
  id: string; name: string;
  createdAt: string; updatedAt: string;
  recipe: PaletteRecipe;      // seed + settings + overrides (regeneration metadata)
  hexColors: string[];        // "export-ordered hex colors at the time of saving"
}
export interface LibraryExport {
  application: "rampart"; formatVersion: 1; exportedAt: string;
  palettes: SavedPalette[];
}
```

- Ordering is meaningful: **shared shadow → each ramp dark→light → shared highlight**
  (`README.md`, "Getting a palette into Procreate").
- `mergeImportedJson` accepts a full library export, a bare array, or a single palette
  (`src/storage/library.ts`), and validates hex via `isValidHex`/`normalizeHex`.

### 7(b) Proposed design

Import a rampart palette and apply its ordered ramp colours as a **real base colour layer**
in exports — used when **no** combinatorics set is imported (per the feature statement).
When a combinatorics set *is* imported, the combinatorics surface map takes precedence (and
MAY reference palette indices later; out of scope here).

**Import**

- Accept the rampart shapes defensively: `LibraryExport` (`{application:'rampart',
  formatVersion:1, palettes:[…]}`), a bare `SavedPalette[]`, or a single `SavedPalette`.
- Require `hexColors` (resolved) — if absent, ignore the palette with a warning rather than
  attempting to reproduce rampart's generator (which would be a large cross-repo port and is
  explicitly out of scope). This keeps plinth dependency-free and future-proof.
- Validate every colour with a strict `#rrggbb` regex (replacing rampart's `convert` helpers;
  plinth does not import rampart code).

**Palette model**

```ts
// src/core/color.ts / types.ts
export interface Palette {
  source: 'rampart';
  name: string;
  /** Ordered: shared shadow, then each ramp dark→light, then shared highlight. */
  colors: string[]; // '#rrggbb'
}
export interface SceneDocument {
  // …
  palette?: Palette;
  colorSettings?: {
    enabled: boolean;
    /** How to choose a ramp per object. */
    assign: 'cycle' | 'byType' | 'byLevel';
    /** How many palette slots form one ramp (excluding shared ends). */
    rampSize?: number;
  };
}
```

**Mapping colours to surfaces**

Reuse the existing banded-Lambert machinery ([`src/core/compose.ts`](src/core/compose.ts:25))
to pick a slot **within a ramp**, so tops read light and shadowed sides read dark — matching
rampart's dark→light ordering:

- Choose a ramp per object: `assign: 'cycle'` (placement order, default), `'byType'`
  (each primitive type gets a ramp), or `'byLevel'` (each level gets a ramp).
- Within the ramp, map the Lambert band fraction to an index, mapping the same way
  `toneAt` maps to grey bands ([`src/core/compose.ts`](src/core/compose.ts:25)). The shared
  shadow/highlight ends are reserved anchors (outline / extreme highlight) and are not used
  as generic band colours unless configured.
- Floor uses a dedicated slot (e.g. the shared shadow or a configurable floor colour).

**Output**

- New `composeColorImage(buffers, options, settings, palette, colorSettings)` — like
  `composeImage` but writes real RGB per pixel.
- `composeLayers` gains a **`Base color`** layer (bottom, under the greyscale `Level n`
  layers) containing the coloured render, so the PSD has an actual colour base to paint
  over, *in addition to* the existing greyscale trace layers. This satisfies "an actual base
  color layer in exported scenes rather than just a trace base."
- PNG export gains a colour mode (segmented `Values: grey | colour`), or emits both.
- Outlines remain `#rrggbb`-configurable (default the palette's shared shadow) instead of
  the fixed `OUTLINE_GREY = 34` ([`src/core/compose.ts`](src/core/compose.ts:18)).

**Defensiveness / configurability (required by the brief)**

- Parser tolerates: library export / array / single palette; extra fields; missing
  `recipe`; missing `hexColors` (skip + warn); non-`rampart` `application` (warn, still try
  `hexColors` if present).
- All mapping choices live in `colorSettings`, overridable in the UI, so if the assumed
  rampart ordering changes, users can adjust without a code change.
- If the rampart repo is unreachable at implementation time, the assumed format above (from
  the pinned commit `aeffaee`) is the contract; the parser's tolerance makes format drift a
  soft failure, not a crash.

### 7(c) Files to change

| File | Change |
|---|---|
| `src/core/color.ts` (new) | `parseRampartPalette(text): Palette[]`, hex validation/normalisation, band→index helpers. |
| [`src/core/types.ts`](src/core/types.ts:58) | Add `Palette`, `ColorSettings`, and `SceneDocument.palette/colorMap/colorSettings`. |
| [`src/core/compose.ts`](src/core/compose.ts:79) | Add `composeColorImage`; extend `composeLayers` with a `Base color` layer; parameterise outline colour. |
| [`src/lib/exporters.ts`](src/lib/exporters.ts:71) | PNG colour mode; PSD includes the base-colour layer; JSON export includes the palette. |
| [`src/ui/Panels.tsx`](src/ui/Panels.tsx:158) | View/Export controls: import palette, colour toggle, assignment mode, palette preview swatches. |
| [`src/App.tsx`](src/App.tsx:436) | Thread palette import through `history.commit`; pass `colorSettings` to panels. |
| [`src/core/psd.ts`](src/core/psd.ts:125) | No change (already RGB+A); verify the colour layer encodes correctly. |

### 7(d) Data model / type changes

- `SceneDocument.palette?`, `colorSettings?` (above). (`colorMap` was declared but
  never read or written; it was removed rather than wired, since per-object
  overrides are out of scope for this feature.)
- `ComposeExtras` extended or a new `ComposeColorOptions` type.
- `RenderOptions.shading` unchanged; add a top-level `color?: boolean` in the *export*
  options (not in `RenderOptions`, to avoid persisting UI-only state — though the repo does
  persist `viewOptions` in localStorage, so this is a judgement call; recommended: keep
  colour enablement in `colorSettings`, persisted with the document).

### 7(e) API endpoints / server changes

- None required (client-side import + export). Optional: extend `validDocument` to validate
  `palette.colors` when present (recommended for boundary hygiene, consistent with
  [`server/main.ts`](server/main.ts:63)).

### 7(f) Test coverage

New `test/color.test.ts` + `test/rampart-import.test.ts`:

1. `parseRampartPalette` accepts a `LibraryExport`, a bare array, and a single `SavedPalette`
   (mirror rampart's `mergeImportedJson` acceptance).
2. Rejects invalid hex; skips palettes without `hexColors`.
3. Ordering preserved: parsed `colors` equals `hexColors` order.
4. `composeColorImage` on a single block writes non-grey RGB; top is lighter than sides
   (extends the test at [`test/render.test.ts`](test/render.test.ts:25)).
5. `composeLayers` includes a `Base color` layer when colour is enabled; the PSD opens with
   that layer (extend [`test/export.test.ts`](test/export.test.ts:47)).
6. With colour disabled, output is byte-identical to the current greyscale render
   (regression guard).
7. Colour is suppressed/overridden when a combinatorics set is imported (per the feature
   rule) — assert precedence.

### 7(g) Risks / edge cases

- **Cross-repo format drift:** mitigated by the tolerant parser + `colorSettings` overrides;
  pin the assumed format (`therebelrobot/rampart` commit `aeffaee`, `formatVersion: 1`).
- **Ramp parsing ambiguity:** `hexColors` is a flat, ordered list — the *number of ramps* and
  the shared ends are not explicitly encoded. Derive `rampSize` heuristically or require the
  user to set it; default to treating the whole list as one ramp. **Open question for the
  requester (see §8).**
- **Accessibility/contrast:** colour must remain distinguishable in greyscale for the trace
  workflow; keep the greyscale layers as-is and add colour as an *additional* base layer,
  never replacing the trace.
- **Determinism:** the same palette + scene must render identically across reloads (no RNG).
- **Procreate palette cap:** rampart caps `.swatches` at 30 colours
  (`procreateSwatchLimit`); plinth should warn if a palette exceeds a usable count for ramps.
- **Document growth:** palettes are small (≤ tens of hex strings); safe for the SQLite
  whole-document model ([`server/store.ts`](server/store.ts:22)).
- **`localStorage` draft size:** unaffected materially.

---

## 8. Cross-feature interactions and sequencing

1. **Feature 3 (import) enables Feature 4 (wall fix).** The adjacency `neighbourMask` is
   shared. Ship `src/core/combinatorics.ts` first; Feature 4 consumes it. If Feature 4 must
   land alone, add a minimal adjacency helper and migrate later.
2. **Feature 5 (tall variants) is independent** and low-risk — can ship first.
3. **Feature 6 (wall slopes) extends Feature 5's preset generation** (sloped tall walls) and
   interacts with Feature 4's corner joins.
4. **Feature 7 (colour) is gated on "no combinatorics imported"** (feature statement). It is
   otherwise independent; the `Base color` PSD layer must not disturb the trace layers.
5. **Feature 1 (auth) is orthogonal** to all rendering features. Ship independently and
   early, since it changes the deployment story.
6. **Document-type additions** (`combinatorics`, `palette`, `colorSettings`, object `slope`)
   are all optional and backwards compatible; the server's `validDocument` ignores unknown
   fields today, so older/newer clients interoperate. Recommended that each implementation
   task extend `validDocument` for its own field.

### Suggested implementation order

1. Feature 1 (auth) — isolated, unblocks self-hosting.
2. Feature 5 (tall variants) — smallest, self-contained.
3. Feature 2 (combinatorics export) — pure functions, no rendering change.
4. Feature 3 (combinatorics import) — introduces adjacency.
5. Feature 4 (wall join fix) — depends on 3.
6. Feature 6 (wall slopes) — depends on 3/4/5.
7. Feature 7 (rampart colour) — independent, gated on 3.

### Open questions / assumptions for the requester

- **F1:** Should `/api/health` stay public (recommended, keeps the Docker healthcheck) or be
  gated? Should an unset `PLINTH_TOKEN` fail closed (refuse to start) instead of running open?
- **F2/F3:** Is `iso-4` (4-neighbour) sufficient, or is `iso-8` (diagonals) required for
  corners? Should combinatorics be keyed by `type` or by full template (size/thickness)?
- **F3:** Should imported combinatorics change **geometry** (mitered joins) as well as edge
  suppression, or edge suppression only?
- **F4:** A concrete repro (object coordinates/rotations) would confirm which of the two
  root-cause sub-cases the reporter sees; the fix covers both, but confirm the desired
  corner appearance (silhouette vs seam-free).
- **F5:** Confirm the exact set of "level-changing" types — this spec includes
  `ramp, stairs, pyramid, cone` and excludes `block, wall, cylinder, sphere, arch`.
- **F6:** Should the slope run along the wall's length (canonical y, this spec's choice) or
  across its thickness? Confirm partial-slope (shoulder) support is required or full-slope
  suffices for v1.
- **F7:** rampart's `hexColors` is a flat ordered list with no explicit ramp boundaries.
  Confirm how many slots form one ramp and how shared shadow/highlight are delimited, so the
  default mapping is correct (this spec defaults to treating the list as one ramp and makes
  it user-configurable).

---

## 9. Verification & commit conventions (recap for implementers)

- **Verify:** `npm run typecheck` → `npm test` → `npm run build`; then manual `npm run dev:server` + `npm run dev`.
- **Dependencies:** add/remove only via `npm` (repo rule), never by editing `package.json`
  by hand. Prefer leaving the server zero-dependency.
- **Edits:** Roo editing tools only (repo rule); no `sed`/`awk`/inline scripts.
- **Tests:** Node's built-in `node:test` run through `tsx`; keep core tests pure (no DOM).
  PSD/zip tests shell to `python3` and must self-skip when `psd-tools` is absent
  ([`test/export.test.ts`](test/export.test.ts:37)).
- **Commits:** `feat:`/`fix:`/`docs:` prefixes for clarity; releases are tag-driven via
  `npm run release:patch|minor|major`, which the release workflow typechecks, tests, and
  publishes multi-arch to GHCR.
- **Spec fidelity (repo rule `06-working-from-spec`):** if an implementation task cannot
  follow this spec for a technical reason, it MUST surface the conflict, propose an
  alternative, and update this document **before** continuing on the alternative.

---

## Feature 10 — IMAGE-BASED COMBINATORICS (TILESET EXPORT / IMPORT)

> **This is the requester's actual deliverable.** §2/§3 (JSON metadata) are superseded for
> the requester's intent; this section defines the **image tileset**: for every face used in
> the active scene, a set of discrete PNG block images, one per neighbour-match permutation
> (the 47-config set), that the user draws over in Procreate and re-imports to replace the
> grey textures in the viewport.

### 10(a) Current behavior (evidence)

- **What a "face"/"tile" is.** The scene is a list of `SceneObject`s
  ([`src/core/types.ts`](src/core/types.ts:27)); each is a 3D primitive (block, wall, …) with
  a footprint in tiles and a height in levels. There is no dedicated "terrain tile" type; the
  closest is a `block` (a 1×1×1 cube, [`src/core/primitives.ts`](src/core/primitives.ts:26)).
  A **face** in this design = a **distinct primitive template** — the same keying the JSON
  exporter already uses: `type|width|depth|height|parameter`
  ([`src/core/combinatorics.ts`](src/core/combinatorics.ts:193)).
- **How the grey textures are produced.** `renderScene` raycasts every object into a z-buffer
  ([`src/core/render.ts`](src/core/render.ts:189)); `composeImage` then writes a **grey 0–255**
  per covered pixel via `toneAt` ([`src/core/compose.ts`](src/core/compose.ts:34),
  [`src/core/compose.ts`](src/core/compose.ts:142)). The grey ramps are
  `OBJECT_RAMP = [64, 232]`, `FLOOR_RAMP = [118, 204]`, `OUTLINE_GREY = 34`
  ([`src/core/compose.ts`](src/core/compose.ts:17)). There is **no per-object texture anywhere**.
- **Isometric tile geometry.** `makeProjection` ([`src/core/projection.ts`](src/core/projection.ts:36)):
  `halfTile = tileWidth/2`, `quarterTile = tileWidth/4`, `levelHeight = levelHeightPixels`.
  A 1×1×1 block's screen bounding box is `tileWidth` wide and `tileWidth/2 + levelHeight`
  tall (top diamond + one level of side). At the defaults (`tileWidthPixels = 32`,
  `levelHeightPixels = 16`, [`src/core/types.ts`](src/core/types.ts:146)) that is **32×32 px**.
  The top face is a diamond `tileWidth × tileWidth/2`; the two visible side faces are
  parallelograms `tileWidth/2 × levelHeight`.
- **Adjacency today is 4-neighbour only.** `analyseAdjacency`
  ([`src/core/combinatorics.ts`](src/core/combinatorics.ts:402)) derives a 4-bit mask (N/E/S/W)
  via `abuttingDirection` ([`src/core/combinatorics.ts`](src/core/combinatorics.ts:371)); there
  is **no diagonal adjacency**.
- **The existing `iso-8` rule is the classic blob rule, not the requester's.**
  `blobNormalize` ([`src/core/combinatorics.ts`](src/core/combinatorics.ts:124)) keeps a
  diagonal only when **both** adjacent orthogonals are **present** (`DIAGONAL_REQUIRES`,
  [`src/core/combinatorics.ts`](src/core/combinatorics.ts:116)). The requester's rule is the
  opposite: a diagonal matters only when both flanking orthogonals are **absent**. Both rules
  yield 47 classes, but they are **different tile sets** (the classic rule's corner tiles are
  inner corners; the requester's are outer/concave corners). The tileset enumeration MUST use
  the requester's rule.

### 10(b) Proposed design

#### 10(b)(1) The 47-configuration enumeration (requester's open-corner rule)

For an 8-bit neighbour mask `m` (bit order `N,NE,E,SE,S,SW,W,NW`, matching `SIDES_8`,
[`src/core/combinatorics.ts`](src/core/combinatorics.ts:33)):

- Orthogonal bits: N=0, E=2, S=4, W=6.
- Diagonal bits: NE=1, SE=3, SW=5, NW=7.
- A corner is **open** iff both flanking orthogonals are **absent**:
  - NE open ⇔ N absent ∧ E absent
  - SE open ⇔ E absent ∧ S absent
  - SW open ⇔ S absent ∧ W absent
  - NW open ⇔ W absent ∧ N absent

`openCornerNormalize(m)` clears every diagonal bit whose corner is **not** open (i.e. keeps a
diagonal only at an open corner). This is the requester's rule.

Count (per the requester, verified):

| orthogonals present | configs | open corners | variants each | subtotal |
|---|---|---|---|---|
| 0 | 1 | 4 | 16 | 16 |
| 1 | 4 | 2 | 4 | 16 |
| 2 adjacent | 4 | 1 | 2 | 8 |
| 2 opposite | 2 | 0 | 1 | 2 |
| 3 | 4 | 0 | 1 | 4 |
| 4 | 1 | 0 | 1 | 1 |
| **total** | | | | **47** |

The enumeration is `{ openCornerNormalize(m) : m ∈ [0,256) }`, which has exactly **47**
distinct values. The fully-empty tile (mask 0) is **one of the 47** (the "0 orthogonals,
0 diagonals" config). The "47 + 1 = 48" variant counts the empty tile separately as a
background/no-tile entry; this is bookkeeping, not mathematics — this design includes it in
the 47 and documents the choice.

**Rotation canonicalization.** Unlike the code comment at
[`src/core/combinatorics.ts`](src/core/combinatorics.ts:154) (which claims the blob rule is
not rotation-equivariant), the open-corner rule **is** rotation-equivariant: rotating the mask
rotates the orthogonals and diagonals together, and the open-corner predicate is preserved.
So the 47 normalized masks form rotation orbits. For naming/lookup we canonicalize by the
numerically smallest of the four quarter-turn rotations (`rotateMask8`,
[`src/core/combinatorics.ts`](src/core/combinatorics.ts:110)); for export we emit all 47 (each
as its own image), and for import we look up the exact normalized mask (with an optional
rotation fallback for partial tilesets).

**Naming.** Each config id = the normalized 8-bit mask as two lowercase hex digits, e.g.
`c00` (empty), `c01` (lone NE at an open corner), `c0f` (N+E+S+W). The manifest also records
the orthogonal mask and the diagonal mask separately for readability.

#### 10(b)(2) EXPORT design

**Faces used in the active scene.** Reuse the template keying from `buildCombinatorics`
([`src/core/combinatorics.ts`](src/core/combinatorics.ts:193)): distinct
`type|width|depth|height|parameter` (extend the key with `slope`/`slopeDirection` so sloped
walls are distinct, since slope changes the sprite). Each distinct template is one **face**.

**Rendering each configuration to a discrete PNG.** For each face and each of the 47 configs,
render a **template sprite**:

- Render the face's primitive in isolation with `renderPrimitive`
  ([`src/core/render.ts`](src/core/render.ts:238)), which crops exactly to the object's
  bounding box at the scene's tile size.
- Apply the config's open-face flags to the edge pass so open orthogonal sides draw no outline
  (reuse the `joinPairs` mechanism, [`src/core/render.ts`](src/core/render.ts:201)); for open
  corners with a diagonal present, suppress the corner outline; for open corners without a
  diagonal, keep it. (Implementation MAY start with orthogonal-only suppression and add corner
  suppression in a follow-up; the manifest still records the full config.)
- Compose to RGBA with `composeImage` ([`src/core/compose.ts`](src/core/compose.ts:142)) and
  encode PNG via the existing `rgbaToPng`/`canvasToPng` path
  ([`src/lib/exporters.ts`](src/lib/exporters.ts:27)).
- The sprite is the **tile silhouette template** the user draws over in Procreate: a grey
  isometric block, cropped to its bounds, with the config's open edges left un-outlined so the
  artist can see which sides join.

**Resolution.** Default 1× (pixel-exact, e.g. 32×32 for a 1×1×1 block at default settings);
the existing `scale` control ([`src/ui/Panels.tsx`](src/ui/Panels.tsx:310)) offers
1×/2×/4×/8× nearest-neighbour upscale ([`src/core/compose.ts`](src/core/compose.ts:247)). The
manifest records the scale and the 1× dimensions.

**Zip layout + manifest schema.**

```
plinth-tileset_<tileWidth>px[_@Nx].zip
├── manifest.json
└── tiles/
    ├── <face-slug>/
    │   ├── c00.png
    │   ├── c01.png
    │   └── … (47 per face)
    └── …
```

`manifest.json`:

```jsonc
{
  "format": "plinth.tileset",
  "version": 1,
  "generator": "plinth",
  "exportedAt": "2026-10-10T00:00:00.000Z",
  "scheme": "open-corner-8",          // the requester's rule
  "sides": ["N","NE","E","SE","S","SW","W","NW"],
  "projection": { "tileWidthPixels": 32, "levelHeightPixels": 16 },
  "scale": 1,
  "configs": [                         // the 47, shared across faces
    { "id": "c00", "mask": 0,  "ortho": 0,  "diag": 0,  "openCorners": ["NE","SE","SW","NW"] },
    { "id": "c01", "mask": 1,  "ortho": 0,  "diag": 1,  "openCorners": ["NE","SE","SW","NW"] }
    // … 47 entries
  ],
  "faces": [
    {
      "slug": "block_1x1x1",
      "type": "block",
      "template": { "type": "block", "width": 1, "depth": 1, "height": 1, "rotation": 0 },
      "directional": false,
      "sprites": {                     // config id → file + geometry
        "c00": { "file": "tiles/block_1x1x1/c00.png", "width": 32, "height": 32, "anchorX": 16, "anchorY": 16 }
        // … 47
      }
    }
  ]
}
```

- `anchorX/anchorY` = the screen position, within the sprite, of the tile's footprint origin
  (back corner) at ground level — the same anchor convention as `kit.json`
  ([`src/lib/exporters.ts`](src/lib/exporters.ts:144)). This lets the importer place the sprite
  on the grid.
- `directional` (from `DIRECTIONAL_TYPES`, [`src/core/primitives.ts`](src/core/primitives.ts:103))
  flags faces whose look changes with rotation; the exporter emits the template at rotation 0
  and the importer rotates the sprite (or the exporter MAY emit per-rotation variants — see
  risks).

**Procreate workflow.** The user opens the zip, imports each `c*.png` as a layer/canvas in
Procreate, draws the tile art over the grey template (keeping the silhouette and the open-edge
hints), and exports the finished PNGs back with the same filenames. The manifest is the
contract: filenames + config ids must be preserved.

#### 10(b)(3) IMPORT design

**File format.** The same zip + `manifest.json`. Import accepts the zip (or a folder of PNGs +
manifest). Validation:

- `format === 'plinth.tileset'`, `version === 1`, `scheme === 'open-corner-8'`.
- Every `faces[].sprites[].file` exists in the zip; every config id is one of the 47.
- PNG dimensions match the manifest (or are a known multiple of the 1× size).
- Unknown faces/configs are ignored with a warning (forward-compatible), mirroring
  `validateCombinatorics` ([`src/core/combinatorics.ts`](src/core/combinatorics.ts:272)).

**Computing each tile's configuration at render time.** Extend adjacency to 8 neighbours:

- New `analyseAdjacency8(objects)` (in `src/core/tileset.ts`) reuses the spatial hash of
  `analyseAdjacency` ([`src/core/combinatorics.ts`](src/core/combinatorics.ts:402)) and adds
  **corner-touching** detection: two compatible objects are diagonal neighbours when their
  footprints touch at a corner (share a point within `ADJACENCY_TOLERANCE`,
  [`src/core/combinatorics.ts`](src/core/combinatorics.ts:355)) and their vertical spans match.
  Produces an 8-bit mask per object.
- Normalize with `openCornerNormalize`, look up the face's sprite for the resulting config id.

**Compositing the imported image onto the tile.** The viewport renders the whole scene into one
buffer ([`src/ui/Viewport.tsx`](src/ui/Viewport.tsx:98),
[`src/ui/Viewport.tsx`](src/ui/Viewport.tsx:112)). Two viable approaches:

- **Preferred — per-pixel sprite sampling in `composeImage`.** Extend `composeImage` to accept
  an optional tileset + per-object config. For a pixel owned by object `O`, compute the
  sprite-local coordinate `(pixelX − bboxLeft(O), pixelY − bboxTop(O))` (the same bbox math as
  `rasterise`, [`src/core/render.ts`](src/core/render.ts:110)), sample `O`'s sprite; if the
  sprite pixel is opaque, write its RGB(A); if transparent, fall back to the grey tone. This
  keeps the existing z-buffer occlusion exactly (the sprite is only sampled where the object
  already won the pixel) and needs no new draw order.
- **Alternative — sprite overlay pass.** After `composeImage`, draw each object's sprite at its
  projected bbox with a depth test. More code, and it must re-derive occlusion; not recommended.

**Scaling / anchoring.** The sprite is drawn at the object's screen bbox. If the scene's
`tileWidthPixels` differs from the tileset's, scale the sprite by
`sceneTileWidth / tilesetTileWidth` (nearest-neighbour,
[`src/core/compose.ts`](src/core/compose.ts:247)) and re-anchor at `anchorX/anchorY × scale`.
If the sprite's bbox does not match the object's bbox (e.g. the user drew a taller tile), anchor
at the footprint origin and let the sprite extend upward; document that the exporter's
dimensions are the contract.

**Transparency.** Sprites are RGBA; alpha 0 = "no art here" → fall back to the grey tone (or
transparent, per the background mode). This lets the user draw only the parts they care about.

**Fallback when an image is missing.** If a face has no tileset, or a config has no sprite,
render that tile with the existing grey texture (today's behaviour). A missing tileset never
breaks rendering.

#### 10(b)(4) Interaction with the JSON combinatorics and rampart colour

- **JSON combinatorics (§2/§3):** retained for the renderer's edge-suppression pass
  (`joinPairs`, [`src/core/render.ts`](src/core/render.ts:201)) and Feature 4's wall-corner
  joins. It is **not** the requester's deliverable. The image tileset is additive and
  independent; a scene MAY have both. The tileset's enumeration uses the requester's open-corner
  rule; the JSON set's `iso-8` uses the classic blob rule — they are different and MUST NOT be
  conflated.
- **Rampart colour (§7):** the tileset is the user's finished art and takes visual precedence.
  When a tileset is active, the grey/colour fill for tiled objects is replaced by the sprite;
  the rampart `Base color` layer is suppressed for those objects (or the tileset is composited
  over it). The greyscale trace layers remain for non-tiled objects. Document the precedence:
  **tileset > rampart colour > grey**.

#### 10(b)(5) Types, modules, UI, server, tests

**New module `src/core/tileset.ts`** (pure, no DOM):

- `openCornerNormalize(mask)`, `openCorners(mask)`, `TILESET_CONFIGS` (the 47),
  `canonicalTilesetMask(mask)`.
- `analyseAdjacency8(objects)` → 8-bit masks.
- Manifest types: `TilesetManifest`, `TilesetFace`, `TilesetConfig`, `TilesetSprite`.
- `parseTilesetManifest(value)` / `validateTilesetManifest` (mirrors `validateCombinatorics`).

**New module `src/lib/tileset.ts`** (DOM-side):

- `exportTileset(document, options, scale)` → `{ blob, filename }` (zip via `createZip`,
  [`src/core/zip.ts`](src/core/zip.ts:31)).
- `importTileset(file)` → `{ manifest, sprites: Map<faceSlug, Map<configId, ImageData>> }`
  (unzip + decode PNGs; needs a small store-only zip **reader** — the current `zip.ts` is
  write-only, so add `readZip(bytes)`).

**Type changes** ([`src/core/types.ts`](src/core/types.ts:109)):

```ts
export interface TilesetRef {
  id: string;                 // key into IndexedDB where the decoded sprites live
  manifest: TilesetManifest;  // small; persisted with the document
}
export interface SceneDocument {
  // …existing…
  tileset?: TilesetRef;
}
```

- **Image storage:** decoded sprites are large; store them in **IndexedDB** keyed by
  `TilesetRef.id` (like the existing localStorage drafts, [`src/lib/api.ts`](src/lib/api.ts:46))
  and persist only the manifest in the document. This keeps the SQLite whole-document model
  small and avoids base64 bloat. Trade-off: the tileset does not sync across devices — the user
  re-imports. (Alternative: base64 in the document; rejected for size.)

**UI** ([`src/ui/Panels.tsx`](src/ui/Panels.tsx:248)):

- Export panel: a "Tileset (.zip)" button (next to "Combinatorics (JSON)") and a face/config
  count readout.
- Import panel: an "Import tileset" file control (accept `.zip`), a status line (faces, configs,
  active), and a Clear action.
- Viewport: no new controls; the compositing is automatic when a tileset is active.

**Server:** no change. The manifest is optional in the document; `validDocument`
([`server/main.ts`](server/main.ts:64)) MAY be extended to shape-check `tileset.manifest` when
present (recommended, consistent with §3(e)/§7(e)). Images are never sent to the server.

**Tests** — new `test/tileset.test.ts`:

1. `TILESET_CONFIGS.length === 47`; the per-orthogonal-config variant counts match the table
   (1·16 + 4·4 + 4·2 + 2·1 + 4·1 + 1·1).
2. `openCornerNormalize` keeps a diagonal only at an open corner; the empty mask is in the 47.
3. Rotation equivariance:
   `openCornerNormalize(rotateMask8(m, r)) === rotateMask8(openCornerNormalize(m), r)`.
4. `analyseAdjacency8` on a hand-built 3×3 block grid yields the expected 8-bit masks.
5. Manifest round-trips through JSON; `parseTilesetManifest` rejects wrong
   `format`/`version`/`scheme`.
6. `exportTileset` produces a zip with `manifest.json` + 47 PNGs per face; the zip reads back
   with `readZip`.
7. Compositing: a scene with a tileset renders the sprite's RGB where the sprite is opaque and
   the grey tone where it is transparent; a missing sprite falls back to grey (regression guard).
8. A scene with no tileset renders byte-identically to today (regression guard).

### 10(c) Files to change

| File | Change |
|---|---|
| `src/core/tileset.ts` (new) | Enumeration, normalization, 8-neighbour adjacency, manifest types + validation. |
| [`src/core/zip.ts`](src/core/zip.ts:31) | Add `readZip(bytes)` (store-only reader) alongside `createZip`. |
| `src/lib/tileset.ts` (new) | `exportTileset`, `importTileset`, IndexedDB sprite store. |
| [`src/core/compose.ts`](src/core/compose.ts:142) | `composeImage` gains an optional tileset + per-object config; per-pixel sprite sampling with grey fallback. |
| [`src/core/render.ts`](src/core/render.ts:189) | Expose per-object screen bboxes (or a helper) for sprite sampling; optionally accept open-face flags for template rendering. |
| [`src/core/types.ts`](src/core/types.ts:109) | `TilesetRef`, `SceneDocument.tileset?`. |
| [`src/ui/Panels.tsx`](src/ui/Panels.tsx:248) | Tileset export button, import control, status. |
| [`src/ui/Viewport.tsx`](src/ui/Viewport.tsx:98) | Thread the active tileset into `composeImage`. |
| [`src/App.tsx`](src/App.tsx:444) | Thread tileset import/clear through `history.commit`. |
| [`server/main.ts`](server/main.ts:64) | *Optional:* shape-check `tileset.manifest`. |

### 10(d) Data model / type changes

- `TilesetRef { id, manifest }`; `SceneDocument.tileset?`.
- `TilesetManifest`, `TilesetFace`, `TilesetConfig`, `TilesetSprite` in `src/core/tileset.ts`.
- No change to `SceneObject`/`SceneSettings`.

### 10(e) API endpoints / server changes

- None required. Images live client-side (IndexedDB). Optional `validDocument` extension.

### 10(f) Test coverage

See 10(b)(5).

### 10(g) Risks / edge cases

- **Multi-tile objects.** The 8-neighbour model assumes unit tiles. Walls and stretched blocks
  span multiple tiles; define the configuration from the object's footprint edges (per-object,
  not per-tile) or scope the tileset to unit-footprint faces. **Assumption:** the tileset applies
  to unit-footprint faces (blocks/tiles); multi-tile faces get a single configuration from their
  overall footprint. Confirm with the requester.
- **Diagonal adjacency for non-unit footprints.** Corner-touching must be defined precisely
  (shared corner point within tolerance + matching vertical span). Test with L-shaped and offset
  footprints.
- **Rule mismatch.** The requester's open-corner rule differs from the code's classic blob rule
  ([`src/core/combinatorics.ts`](src/core/combinatorics.ts:124)); both give 47 but different
  tiles. The tileset MUST use the open-corner rule; do not reuse `blobNormalize`.
- **Rotation-equivariance comment is wrong.** [`src/core/combinatorics.ts`](src/core/combinatorics.ts:154)
  claims the blob rule is not rotation-equivariant; it is. The open-corner rule is too, so
  rotation-orbit canonicalization is valid.
- **Sprite size drift.** If the user draws at a different size or the scene tile size changes,
  scaling/anchoring must be explicit; the manifest's `anchorX/anchorY` + `projection` are the
  contract.
- **Directional faces.** A wall's sprite differs by rotation; the exporter emits rotation 0 and
  the importer rotates, OR the exporter emits per-rotation variants (47 × 4 = 188 images per
  directional face). **Assumption:** emit rotation 0 and rotate at import; confirm.
- **Zip reader.** `zip.ts` is write-only today; a store-only reader is needed. Keep it
  dependency-free (parse the central directory; no deflate).
- **Performance.** 47 sprites per face; per-pixel sampling adds a lookup per covered pixel.
  Cache decoded sprites; sample with integer math. Large scenes (20 000 objects,
  [`server/main.ts`](server/main.ts:69)) must stay O(pixels).
- **IndexedDB availability.** Private-mode Safari may restrict it; fall back to in-memory
  (tileset lost on reload) with a warning.
- **47 vs 48 bookkeeping.** The empty tile is one of the 47; document that a consumer wanting
  "47 + 1" adds a separate background entry.
- **Procreate round-trip.** Filenames/config ids must survive Procreate's export; the manifest is
  the contract. Provide a "verify tileset" action that reports missing/extra files.

### 10(h) Open questions / assumptions

- Confirm "face" = distinct primitive template (type + footprint + height + parameter + slope),
  not just `type`.
- Confirm the tileset applies to unit-footprint tiles; how should multi-tile objects (walls) be
  handled?
- Confirm directional faces: rotate at import (47 images) vs per-rotation export (188 images)?
- Confirm image persistence: IndexedDB (recommended) vs base64 in the document?
- Confirm whether the JSON combinatorics (§2/§3) should be removed from the UI or kept alongside
  the tileset.
