# Plinth — Swatch ↔ Grayscale Value Mapping (design)

Status: **IMPLEMENTED** (Option B, all recommended defaults). One user-directed
deviation: the per-band picker is a custom swatch dropdown, not a native `<select>`
(see §3.3/§3.5) — a native select cannot render colour, so the user could not see the
swatches they were choosing. This document remains the contract the implementation and
its audit are judged against (repo rule `06-working-from-spec`).

Scope: replace the ambiguous swatch include/exclude grid under **Import palette**
with a two-column mapping UI — LEFT: the grayscale values already present in the
scene; RIGHT: a dropdown of swatch colours; an arrow between them — where each
grayscale value can be individually mapped to a swatch colour.

---

## 1. Investigation: the current model

### 1.1 What "the existing grayscale values" concretely are

The colour panel's greys are **not** a fixed hand-authored list. They are produced
by the banded-Lambert shading in [`toneAt()`](src/core/compose.ts:36) from two
ramps and quantised by the `Value bands` control:

- Object fill ramp: `OBJECT_RAMP = [64, 232]` ([`src/core/compose.ts`](src/core/compose.ts:19)).
- Floor fill ramp: `FLOOR_RAMP = [118, 204]` ([`src/core/compose.ts`](src/core/compose.ts:20)).
- Outline: `OUTLINE_GREY = 34` ([`src/core/compose.ts`](src/core/compose.ts:21)); grid = floor grey − `GRID_DARKEN = 26`.

For every covered object pixel, [`bandFraction()`](src/core/compose.ts:28) maps the
surface normal's Lambert term to a band, then to a fraction:

```
band      = min(bands-1, max(0, floor(lambert * bands)))
fraction  = bands > 1 ? band / (bands - 1) : 1
grey      = round(64 + (232 - 64) * fraction)          // OBJECT_RAMP
```

`bands` is `RenderOptions.bands` — the **Value bands** field, `min 3, max 6`,
default `4` ([`src/core/types.ts`](src/core/types.ts:190),
[`src/ui/Panels.tsx`](src/ui/Panels.tsx:246)).

**The concrete object grayscale values are therefore `bands` distinct greys,
index 0 = darkest → `bands-1` = lightest:**

| `bands` | object value bands (`#rrggbb`) |
|---|---|
| 3 | `#404040`, `#949494`, `#e8e8e8` (64, 148, 232) |
| 4 (default) | 64, 120, 176, 232 |
| 5 | 64, 106, 148, 190, 232 |
| 6 | 64, 98, 131, 165, 198, 232 |

Floor bands (same quantisation over `FLOOR_RAMP`) at `bands = 4` are
118, 161, 204. Outline is a flat 34; the grid is floor−26.

**Critical detail for the mapping contract:** [`colorAt()`](src/core/compose.ts:148)
computes its band fraction with `bandFraction(buffers, index, options.bands)` in
**every** shading mode — not only `shaded`. So the value→colour mapping is always
driven by the `bands` greys above, even when the on-screen `Values` control is set
to Height/Flat/Blank. The left column of the new UI is exactly these `bands`
object values. It is not "whatever grey happens to be on screen" in Height/Flat
mode; it is the fixed band set the colour path uses.

Source of the values: defined in code, not enumerated as a constant list today —
they are derived on the fly from `OBJECT_RAMP` + `bands`. Option 3.2 below asks
whether to extract an explicit enumerator.

### 1.2 How the current swatch include/exclude grid works

The grid at [`src/ui/Panels.tsx`](src/ui/Panels.tsx:572) renders every entry of
`Palette.colors` as a button. Clicking toggles that palette index in
`colorSettings.swatchUse.used` ([`src/core/types.ts`](src/core/types.ts:115)):

```
used = colorSettings.swatchUse.used            // palette indices, sorted
base = used ?? colors.map((_, i) => i)
next = base.includes(index) ? base.filter(i => i !== index)
                            : [...base, index].sort((a,b) => a-b)
```

That array flows into [`usedColors()`](src/core/color.ts:274), which filters
`Palette.colors` down to the picked indices (in order). [`resolveRamps()`](src/core/color.ts:293)
then slices the **middle** of that filtered list into chunks of `rampSize`
([`rampSize()`](src/core/color.ts:302), default = whole middle as one ramp).
[`rampIndexForObject()`](src/core/color.ts:314) picks a ramp per object via
`assign` (`cycle` / `byType` / `byLevel`); [`bandToRampSlot()`](src/core/color.ts:330)
picks a slot within the chosen ramp from the band fraction;
[`colorForBand()`](src/core/color.ts:336) returns the hex. `swatchUse.shadowIndex`
/ `highlightIndex` (default first / last) anchor the shared ends used by
[`sharedShadow()`](src/core/color.ts:263) / [`sharedHighlight()`](src/core/color.ts:268),
which also seed the Outline and Floor defaults.

**What the grid controls:** which palette slots participate in ramp construction
and in what order. It does **not** map a scene grey to a colour directly — this
indirection (positional slicing + per-object ramp choice) is exactly what makes
the current UI hard to reason about, per the user's report.

### 1.3 How a per-value mapping would integrate

The colour pipeline is gated by [`colorActive()`](src/core/color.ts:356) and is the
single fill decision point: the viewport ([`src/ui/Viewport.tsx`](src/ui/Viewport.tsx:140)),
PNG export ([`src/lib/exporters.ts`](src/lib/exporters.ts:78)) and PSD export
([`src/lib/exporters.ts`](src/lib/exporters.ts:98)) all call
[`composeColorImage()`](src/core/compose.ts:180) under that gate, and the PSD
`Base color` layer goes through the same [`colorAt()`](src/core/compose.ts:148).
A value→colour map therefore integrates in **one** place — the object branch of
`colorAt` — and every consumer stays consistent with no new call sites and no
change to the gate.

---

## 2. The mapping is the same through-line

```
                     bands (3–6, from RenderOptions.bands)
                            │
   bandFraction()  ─────────┤ fraction = band/(bands-1)
                            ▼
   ┌─────────────────────── colorAt() object branch ────────────────────────┐
   │  today:  rampIndexForObject → ramp → bandToRampSlot → colorForBand      │
   │  new:    bandColors[band]  (explicit map)  OR  fall back to today       │
   └────────────────────────────────────────────────────────────────────────┘
```

The only producer that changes is the object branch; outline/floor/grid/background
are untouched.

---

## 3. Design

### 3.1 Data model change

Additive, optional fields on [`ColorSettings`](src/core/types.ts:100):

```ts
export interface ColorSettings {
  enabled: boolean;
  assign: 'cycle' | 'byType' | 'byLevel';   // retained (ramp mode)
  rampSize?: number;                        // retained (ramp mode)
  outlineColor?: string;
  floorColor?: string;
  swatchUse?: { used?: number[]; shadowIndex?: number; highlightIndex?: number };

  /**
   * NEW — which mechanism paints object fills.
   * 'ramps' (default when absent) = today's positional ramp behaviour.
   * 'bands' = the explicit per-value map below is authoritative.
   */
  colorMode?: 'ramps' | 'bands';

  /**
   * NEW — explicit map from value band index (0 = darkest) to a swatch colour.
   * Length is `bands` under `colorMode: 'bands'`. Stored as `#rrggbb` (hex, not a
   * palette index) to match `outlineColor`/`floorColor` and to survive a palette
   * re-import. A missing/short entry falls back to positional derivation for that
   * band only. Absent = no explicit mapping.
   */
  bandColors?: string[];
}
```

Rationale for **hex over palette index**: `outlineColor`/`floorColor` already
store hex ([`src/core/types.ts`](src/core/types.ts:107)); storing indices would
couple the mapping to a palette that can be cleared/re-imported, and would break
when the palette changes. Hex keeps the map self-contained.

**Outline/Floor/Shadow/Highlight:** unchanged. `swatchUse.shadowIndex` /
`highlightIndex` still seed `sharedShadow()`/`sharedHighlight()` used by the
Outline and Floor pickers and the omitted default. Under `colorMode: 'bands'`
they no longer influence object fills (the map replaces ramp construction for
fills) but they still serve their anchor role. This keeps the existing
[`SwatchPicker`](src/ui/Panels.tsx:19) outline/floor behaviour intact.

#### One-way door analysis

- **Additive optional fields, `SceneDocument.version` stays `1` → two-way door.**
  An old client reading a new document ignores unknown fields; a new client
  reading an old document sees `colorMode` absent → `'ramps'` → byte-identical
  to today. No migration required for reads.
- **Repurposing or removing `assign`/`rampSize`/`swatchUse` → one-way door.**
  Those are persisted and exercised by [`test/color.test.ts`](test/color.test.ts:64).
  This design deliberately **retains** them and layers the new mode on top.
- **Changing `OBJECT_RAMP` or `bands` bounds is out of scope** (would change grey
  output and invalidate saved band values).
- **[`validDocument()`](server/main.ts:117) does not validate `colorSettings` at
  all today**, so no server change is strictly required. Optional hardening:
  extend it to shape-check `colorMode`/`bandColors` (see §3.5).

#### Migration when `bands` changes

`bandColors` is indexed by band and its length tracks `RenderOptions.bands`
(3–6). When the user changes `bands` with a map present:

- **Grow** (`bands` increases): new trailing bands get no entry → fall back to
  positional derivation for those slots.
- **Shrink**: excess trailing entries are ignored at read time but retained in the
  document so a later grow restores them. (No destructive prune — cheap to keep,
  avoids surprising data loss.)
- A "Clear mapping" action resets `bandColors` to `undefined`.

This behaviour must be stated in the UI copy ("Bands beyond the current value
count are kept but unused").

### 3.2 Deriving the grayscale list (extraction)

Introduce a single pure helper in [`src/core/color.ts`](src/core/color.ts) so the
UI and the core agree on the exact greys:

```ts
/** The `bands` object value greys, darkest → lightest, as `#rrggbb`. */
export function valueBands(bands: number): string[]
```

It must reproduce the `OBJECT_RAMP` quantisation in
[`toneAt()`](src/core/compose.ts:36) exactly (same rounding) so the swatch chip in
the UI is the literal pixel value. Optional: also export `FLOOR_RAMP` as
`floorBands(bands)` for a possible floor row (see open question 4).

`colorForBand()` gains an explicit band path so the core does not have to
reverse-engineer a band index from a fraction:

```ts
export function colorForBand(
  palette, settings, object, objectIndex, fraction,
): string {
  if (settings.colorMode === 'bands' && settings.bandColors?.length) {
    const bands = /* number of bands in play */;
    const band = bandToRampSlot(fraction, bands);      // reuse 0..bands-1 mapping
    const mapped = settings.bandColors[band];
    if (mapped) return mapped;                          // explicit win
  }
  // …existing ramp path…
}
```

Because `colorForBand` currently receives only `fraction` (not `bands`), the
signature must also receive `bands` (thread `options.bands` from
[`colorAt()`](src/core/compose.ts:148)). Preferred minimal change: add a `bands`
parameter to `colorForBand` and compute `band = bandToRampSlot(fraction, bands)`.
This is the one interface change required and must be updated at its single
caller and in [`test/color.test.ts`](test/color.test.ts:69).

### 3.3 UI structure

Replace the include/exclude grid region
([`src/ui/Panels.tsx`](src/ui/Panels.tsx:572)) with a `ValueMapping` component.

```
┌ Value → colour ───────────────────────────────────────────────┐
│  Scene value            →            Swatch colour             │
│  ▢ 1 · darkest  #404040  →  [ 3: #b03a3a            ▾ ]       │
│  ▢ 2           #787878  →  [ 4: #e05a5a            ▾ ]       │
│  ▢ 3           #b0b0b0  →  [ 2: #7a2a2a            ▾ ]       │
│  ▢ 4 · lightest #e8e8e8  →  [ Auto (ramp)          ▾ ]       │
│                                                               │
│  [ Auto-map dark→light ]  [ Clear mapping ]                   │
└───────────────────────────────────────────────────────────────┘
```

- **Left column:** one row per value band, `0..bands-1`, ordered darkest →
  lightest. Each row shows: a small filled chip of the actual grey
  (`valueBands(bands)[i]`), the band number, a darkest/lightest text tag on the
  ends, and the grey's hex as text. Values come from `valueBands()`; the count is
  read-only here and points at the existing **Value bands** control in the View
  panel ([`src/ui/Panels.tsx`](src/ui/Panels.tsx:246)) so there is one source of
  truth.
- **Arrow:** a decorative `→` glyph between the columns, `aria-hidden="true"`.
- **Right column:** a `SwatchSelect` per row — a trigger button showing the current
  choice that opens a popover grid of real swatch buttons listing:
  - `Auto (ramp)` — the default; clears any explicit entry for this band (falls
    through to positional derivation).
  - then every palette swatch as `index: #rrggbb`, each with a colour chip.
  The trigger shows the selected swatch's chip and hex. **Deviation (user-directed):**
  the design originally specified a native `<select>` here, but a native select cannot
  render colour, so the user could not see the swatches. The custom disclosure replaces
  it; accessibility is preserved per §3.5.
- **Header row** labels the two columns ("Scene value", "Swatch colour") so the
  arrow reads as a mapping, not decoration.
- **Bulk helpers:** `Auto-map dark→light` (fills every band with evenly spaced
  middle-ramp colours, ends from shadow/highlight) and `Clear mapping` (sets
  `bandColors` to `undefined`). These are conveniences; the per-row selects are
  the primary, always-available path — this is what satisfies "individual
  selections as desired".
- **Toggle `Enabled`** stays at the top of the block, with `Assign ramps` /
  `Ramp size` shown **only when `colorMode === 'ramps'`** (progressive
  disclosure) so the two mechanisms are not shown at war with each other.
- A small mode selector `Colour from: [ Ramps | Value map ]` writes `colorMode`.

"Individual selections as desired" = every band row is independently settable to
any palette swatch (or Auto); bulk actions are optional accelerators on top.

### 3.4 Viewport and exporter consumption

No call-site changes. The viewport ([`src/ui/Viewport.tsx`](src/ui/Viewport.tsx:140)),
PNG ([`src/lib/exporters.ts`](src/lib/exporters.ts:78)) and PSD
([`src/lib/exporters.ts`](src/lib/exporters.ts:98)) paths keep the
[`colorActive()`](src/core/color.ts:356) gate and call `composeColorImage()`; the
`Base color` PSD layer continues to use [`colorAt()`](src/core/compose.ts:148).
The behaviour change is entirely inside `colorForBand()`/`colorAt()`.

**AI-assisted note for the registration:** adding the new state to the undo/redo
history must use the existing `history.commit` threading (as palette import does
today, per the Feature 7 audit). No new persistence path.

### 3.5 Accessibility (R5.2 / R5.3 / R5.9)

- **Semantic controls before custom widgets (R5.3):** the design preferred a native
  `<select>` per band, but a native select cannot render colour (the user's blocking
  need). The implemented `SwatchSelect` is a minimal custom disclosure that keeps the
  native affordances: the trigger is a real `<button>` with `aria-expanded`/`aria-controls`
  and an `aria-label` naming the band (e.g. `Band 2 (grey #787878) colour`); the popover
  options are real `<button>`s with `aria-pressed`; Escape closes and returns focus to the
  trigger; the popover is fixed-positioned (the panel scroll container would clip an
  absolute one) and flips above the trigger when there is no room below.
- **Non-color selection indicator (R5.4 / SC 1.4.1):** the mapping is legible
  without colour — band number, grey hex, palette index and swatch hex are all
  text. The arrow is `aria-hidden`.
- **Target size (R5.2 / SC 2.5.8):** selects and helper buttons ≥ 24×24 CSS px;
  aim for 44×44 for the chips/buttons.
- **Focus (R5.9 / SC 2.4.13):** visible focus ring on every select and button; the
  panel has no sticky overlay that could obscure the focused control.
- **Grouping:** wrap the mapping in `<fieldset><legend>Value to colour mapping`
  (or `role="group"` + `aria-label`) so screen-reader users hear the relationship.
- **Keyboard operability (SC 2.1.1 / 2.1.2):** native selects + buttons give full
  keyboard access; there is no drag interaction, so SC 2.5.7 does not apply.
- **Redundant-entry / consistent-help (SC 3.3.7 / 3.2.6):** no new inputs beyond
  the selects; helper copy stays in one place.

### 3.6 Tests to add (audit against this doc)

Extend [`test/color.test.ts`](test/color.test.ts:1):

1. `valueBands(4)` returns exactly `['#404040', '#787878', '#b0b0b0', '#e8e8e8']`
   and matches `toneAt()` output for a flat top / each band.
2. `colorMode: 'bands'` + `bandColors` makes `colorForBand` return the mapped hex
   for each band regardless of object/`assign`/`rampSize`.
3. A short `bandColors` falls back to positional derivation for the missing bands
   only (mixed map).
4. `colorMode` absent / `'ramps'` is byte-identical to today (regression guard —
   mirrors [`test/color.test.ts`](test/color.test.ts:45)).
5. `Outline`/`Floor` hex overrides still win over the band map
   (existing assertions at [`test/color.test.ts`](test/color.test.ts:98) must
   still pass).
6. `colorActive` suppresses the map when a combinatorics set is present
   ([`test/color.test.ts`](test/color.test.ts:53)).

### 3.7 File impact summary

| File | Change |
|---|---|
| [`src/core/types.ts`](src/core/types.ts:100) | Add `colorMode?`, `bandColors?` to `ColorSettings`. |
| [`src/core/color.ts`](src/core/color.ts:336) | Add `valueBands()`; add `bands`/map path to `colorForBand()`. |
| [`src/core/compose.ts`](src/core/compose.ts:148) | Thread `options.bands` into `colorForBand()`. |
| [`src/ui/Panels.tsx`](src/ui/Panels.tsx:572) | Replace include/exclude grid with `ValueMapping` two-column UI + mode selector. |
| [`src/App.tsx`](src/App.tsx:436) | Thread `colorMode`/`bandColors` through `history.commit` (no new path). |
| [`src/styles.css`](src/styles.css:1) | Grid/row styles, arrow, chips, focus ring. |
| [`test/color.test.ts`](test/color.test.ts:1) | Cases 1–6 above. |
| [`server/main.ts`](server/main.ts:117) | Optional: shape-check `colorMode`/`bandColors` in `validDocument`. |

---

## 4. Options and trade-offs

### Option A — Explicit map fully replaces ramps
`colorMode` is removed; `bandColors` is the only fill mechanism. `assign`,
`rampSize`, `swatchUse.used` become dead for fills.

- Pros: simplest mental model; exactly the user's request; smallest UI.
- Cons: discards per-object variation (Cycle/By-type/By-level give a scene visual
  variety a single flat map cannot); breaks saved docs that rely on ramps unless
  we always migrate them; makes `assign`/`rampSize` dead code (audit-trail noise).
- Verdict: not recommended as the sole mechanism.

### Option B — Explicit map as a layer with an explicit mode (RECOMMENDED)
Add `colorMode: 'ramps' | 'bands'` + `bandColors`. Ramps retained; the map wins
when the mode is `'bands'`.

- Pros: two-way door; old documents unchanged; the two-column UI is exactly the
  user's ask; per-object ramps remain available for users who want them; additive
  optional fields only.
- Cons: two modes to document; a mode selector adds one control.
- Verdict: **recommended.** It delivers the requested UI while preserving
  back-compat and the existing ramp capability.

### Option C — Ramp × band matrix
A grid of ramp rows × band columns, each cell a swatch.

- Pros: maximal control.
- Cons: `rampCount × bands` controls (up to ~4×6 = 24 selects); far more complex
  than the user asked for; a two-column left/right layout no longer fits.
- Verdict: out of scope; revisit only if Option B proves insufficient.

---

## 5. Ambiguities and open questions (need a user decision)

1. **Replace ramps or layer on top?** Recommendation: Option B (layer + mode).
   Confirm the user is happy to keep the `Ramps`/`Value map` mode switch rather
   than deleting ramps outright.
2. **Left column: fixed `bands` values, or only values present in the scene?**
   Recommendation: fixed `0..bands-1` from the **Value bands** control — it is the
   literal set the colour path uses, is deterministic, and needs no scene scan.
   "Only present" would require analysing rendered pixels and would change the row
   count as the scene changes. Which does the user want?
3. **Should Floor bands get their own mapping rows**, or stay on the existing
   single Floor swatch picker? Recommendation: v1 keeps object bands only; Floor/
   Outline keep their dedicated pickers.
4. **Store hex or palette index** in `bandColors`? Recommendation: hex (consistent
   with `outlineColor`/`floorColor`; survives palette re-import).
5. **What should the initial map be when a palette is first imported** — all
   `Auto (ramp)` (fall through), or auto-mapped dark→light across the middle ramp?
   Recommendation: all `Auto`, with the `Auto-map dark→light` button available.
6. **When `bands` shrinks, prune `bandColors` or retain the tail?** Recommendation:
   retain (non-destructive) as in §3.1.
7. **Should the old include/exclude `swatchUse.used` grid be kept** as an advanced
   control in ramp mode, or fully replaced? Recommendation: keep it only inside
   ramp mode (progressive disclosure) so existing users are not stranded.
8. **Does the map affect only the colour `Base color` layer** (greyscale trace
   layers stay greyscale), or is any change wanted to the trace output? Per
   Feature 7 spec, trace layers stay greyscale. Confirm this remains the intent.

---

## 6. Recommended path

Implement **Option B**: additive `colorMode` + `bandColors` on `ColorSettings`,
an extracted `valueBands()` helper, a `bands` parameter on `colorForBand()`, and
the two-column `ValueMapping` UI with per-row native selects (accessibility per
§3.5). Keep the `colorActive()` gate and all consumer call sites unchanged.
