stdout:
;
// Feature 7 — rampart palette import and colour mapping.
//
// plinth does not import rampart code. It accepts rampart's *export* shapes
// defensively and uses the resolved `hexColors` list as an ordered ramp:
// shared shadow → each ramp dark→light → shared highlight.
//
// Pure TypeScript, no DOM: the same code runs in the browser and in node tests.

import type { ColorSettings, Palette, PrimitiveType, SceneDocument, SceneObject } from './types';
import { readZip } from './zip';

/** Strict `#rrggbb` (either case). */
const HEX = /^#[0-9a-fA-F]{6}$/;

export function isValidHex(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** Lowercase `#rrggbb`, or null when invalid. */
export function normalizeHex(value: unknown): string | null {
  return isValidHex(value) ? value.toLowerCase() : null;
}

/** `#rrggbb` → `[r, g, b]` (0–255). Throws on invalid input. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = normalizeHex(hex);
  if (!value) throw new Error(`invalid hex colour: ${String(hex)}`);
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

// ── Import ───────────────────────────────────────────────────────────────────

/**
 * Parse a rampart export into palettes. Accepts a full `LibraryExport`
 * (`{application:'rampart', formatVersion:1, palettes:[…]}`), a bare
 * `SavedPalette[]`, or a single `SavedPalette`.
 *
 * - Palettes without a resolved `hexColors` array are skipped (with a warning)
 *   rather than regenerated — porting rampart's generator is out of scope.
 * - Any invalid hex colour throws, so a corrupt file fails loudly.
 * - A non-`rampart` `application` warns but still tries `hexColors`.
 */
export function parseRampartPalette(text: string, warn: (message: string) => void = () => { }): Palette[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }

  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).palettes)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.application !== 'rampart') {
      warn(`unexpected application "${String(candidate.application)}" — trying hexColors anyway`);
    }
    entries = candidate.palettes as unknown[];
  } else if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).hexColors)) {
    entries = [value];
  } else {
    throw new Error('not a rampart palette file');
  }

  const palettes: Palette[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      warn(`skipped palette ${index}: not an object`);
      return;
    }
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' && candidate.name ? candidate.name : `Palette ${index + 1}`;
    if (!Array.isArray(candidate.hexColors)) {
      warn(`skipped palette "${name}": no resolved hexColors`);
      return;
    }
    const colors = candidate.hexColors.map((color) => {
      const normalized = normalizeHex(color);
      if (!normalized) throw new Error(`invalid hex colour in palette "${name}": ${String(color)}`);
      return normalized;
    });
    if (colors.length === 0) {
      warn(`skipped palette "${name}": empty hexColors`);
      return;
    }
    palettes.push({ source: 'rampart', name, colors });
  });

  if (palettes.length === 0) throw new Error('no usable palettes (missing hexColors)');
  return palettes;
}

// ── Procreate / rampart `.swatches` ─────────────────────────────────────────

/**
 * Feature 7 — rampart's `.swatches` export is a **ZIP** containing
 * `Swatches.json`, and the palette inside is a list of HSB swatches rather than
 * the `hexColors` the library export carries:
 *
 *   [{ name, swatches: [{ hue, saturation, brightness, alpha, colorSpace }] }]
 *
 * `hue` is degrees/360 and `saturation`/`brightness` are 0–1 — rampart's
 * `buildProcreateSwatchesJson` (src/export/formats.ts). Procreate caps the list
 * at 30 colours, so a large palette is already lossy by the time it lands here.
 */

/** HSB (hue in degrees, saturation/brightness 0–1) → `#rrggbb`. */
export function hsbToHex(hue: number, saturation: number, brightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.min(1, Math.max(0, saturation));
  const v = Math.min(1, Math.max(0, brightness));
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  const [red, green, blue] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const channel = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** rampart writes hue as degrees/360; a hand-authored Procreate file writes degrees. */
function hueToDegrees(hue: number): number {
  return hue > 1 ? hue : hue * 360;
}

function swatchToHex(swatch: unknown, paletteName: string, warn: (message: string) => void): string | null {
  if (!swatch || typeof swatch !== 'object') return null;
  const candidate = swatch as Record<string, unknown>;
  const hue = candidate.hue, saturation = candidate.saturation, brightness = candidate.brightness;
  if (typeof hue !== 'number' || typeof saturation !== 'number' || typeof brightness !== 'number') return null;
  // colorSpace 0 is HSB, which is what rampart writes. A non-zero space may mean
  // RGB in the same three fields, which we cannot tell apart — warn, do not guess.
  if (typeof candidate.colorSpace === 'number' && candidate.colorSpace !== 0) {
    warn(`palette "${paletteName}": colorSpace ${candidate.colorSpace} is not HSB — colours may be wrong`);
  }
  if (typeof candidate.alpha === 'number' && candidate.alpha < 1) {
    warn(`palette "${paletteName}": alpha ${candidate.alpha} ignored (palette slots are opaque)`);
  }
  return hsbToHex(hueToDegrees(hue), saturation, brightness);
}

/** Parse a `Swatches.json` payload (rampart's `.swatches` body, or a bare dump of one). */
export function parseSwatchesJson(text: string, warn: (message: string) => void = () => { }): Palette[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const entries = Array.isArray(value) ? value : [value];
  const palettes: Palette[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      warn(`skipped palette ${index}: not an object`);
      return;
    }
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' && candidate.name ? candidate.name : `Palette ${index + 1}`;
    if (!Array.isArray(candidate.swatches)) {
      warn(`skipped palette "${name}": no swatches`);
      return;
    }
    if (candidate.swatches.length >= 30) {
      warn(`palette "${name}": Procreate's 30-colour cap — the tail of this palette was dropped at export`);
    }
    const colors = candidate.swatches
      .map((swatch) => swatchToHex(swatch, name, warn))
      .filter((color): color is string => color !== null);
    if (colors.length === 0) {
      warn(`skipped palette "${name}": no usable swatches`);
      return;
    }
    palettes.push({ source: 'rampart', name, colors });
  });
  if (palettes.length === 0) throw new Error('no usable palettes (no swatches)');
  return palettes;
}

/** GIMP palette (`.gpl`) — Aseprite, Krita, GIMP, Lospec. */
export function parseGimpPalette(text: string, fallbackName: string, warn: (message: string) => void = () => { }): Palette {
  const colors: string[] = [];
  let name = fallbackName;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^GIMP Palette/i.test(line)) continue;
    const named = /^Name:\s*(.+)$/i.exec(line);
    if (named) { name = named[1].trim() || fallbackName; continue; }
    if (/^Columns:/i.test(line)) continue;
    if (line.startsWith('#')) continue;
    const match = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
    if (!match) continue;
    const channels = [match[1], match[2], match[3]].map((value) => Math.min(255, Number(value)));
    colors.push(`#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`);
  }
  if (colors.length === 0) {
    warn(`palette "${name}" has no colour lines`);
    throw new Error(`${fallbackName}: no colours in GIMP palette`);
  }
  return { source: 'rampart', name, colors };
}

/** One hex per line (`.hex`) — Lospec, Aseprite, Pixelorama. */
export function parseHexList(text: string, name: string): Palette {
  const colors = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeHex(line.startsWith('#') ? line : `#${line}`))
    .filter((color): color is string => Boolean(color));
  if (colors.length === 0) throw new Error(`${name}: no hex colours found`);
  return { source: 'rampart', name, colors };
}

/**
 * Read any rampart palette export from **bytes**. Dispatches on content rather
 * than filename, so a mislabelled file still works. `.swatches` is the ZIP case;
 * the JSON library export, `.gpl` and `.hex` are text.
 */
export function parseRampartFile(bytes: Uint8Array, filename: string, warn: (message: string) => void = () => { }): Palette[] {
  if (bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = readZip(bytes);
    const found = entries.find((entry) => /swatches\.json$/i.test(entry.name))
      ?? entries.find((entry) => /\.json$/i.test(entry.name));
    if (!found) throw new Error(`${filename}: archive has no Swatches.json`);
    return parseSwatchesJson(new TextDecoder().decode(found.data), warn);
  }
  if (bytes.length > 3 && bytes[0] === 0x41 && bytes[1] === 0x53 && bytes[2] === 0x45 && bytes[3] === 0x46) {
    throw new Error(`${filename}: Adobe Swatch Exchange (.ase) is not supported yet — export the palette as .swatches`);
  }
  const text = new TextDecoder().decode(bytes);
  const head = text.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    // The library export carries resolved hexColors; a swatches payload does not.
    try {
      return parseRampartPalette(text, warn);
    } catch {
      return parseSwatchesJson(text, warn);
    }
  }
  if (/^GIMP Palette/i.test(head)) return [parseGimpPalette(text, filename, warn)];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((line) => /^#?[0-9a-fA-F]{6}$/.test(line))) return [parseHexList(text, filename)];
  throw new Error(`${filename}: unrecognised palette file (expected .swatches, .json, .gpl or .hex)`);
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/** Stable type order for `assign: 'byType'`. */
const TYPE_ORDER: PrimitiveType[] = ['block', 'wall', 'stairs', 'ramp', 'cylinder', 'sphere', 'cone', 'pyramid', 'arch'];

/** The ramp slots between the shared shadow and highlight. */
export function rampColors(palette: Palette): string[] {
  return palette.colors.length > 2 ? palette.colors.slice(1, -1) : palette.colors.slice();
}

export function sharedShadow(palette: Palette, settings?: ColorSettings): string {
  const index = settings?.swatchUse?.shadowIndex ?? 0;
  return palette.colors[index] ?? palette.colors[0] ?? '#000000';
}

export function sharedHighlight(palette: Palette, settings?: ColorSettings): string {
  const index = settings?.swatchUse?.highlightIndex ?? palette.colors.length - 1;
  return palette.colors[index] ?? palette.colors[palette.colors.length - 1] ?? '#ffffff';
}

/** The slots that participate, in order. Default: every slot. */
export function usedColors(palette: Palette, settings?: ColorSettings): string[] {
  const used = settings?.swatchUse?.used;
  if (!used || used.length === 0) return palette.colors;
  const picked = used
    .map((index) => palette.colors[index])
    .filter((color): color is string => Boolean(color));
  return picked.length > 0 ? picked : palette.colors;
}

/** The middle of a colour list — everything between the shared shadow and highlight. */
function middleColors(colors: string[]): string[] {
  return colors.length > 2 ? colors.slice(1, -1) : colors.slice();
}

/**
 * The ramps built from the participating slots, dark→light, each holding
 * `rampSize` entries. With no `swatchUse` this is byte-identical to the old
 * slice of the whole middle list.
 */
export function resolveRamps(palette: Palette, settings: ColorSettings): string[][] {
  const middle = middleColors(usedColors(palette, settings));
  const size = rampSize(palette, settings);
  const ramps: string[][] = [];
  for (let start = 0; start + size <= middle.length; start += size) ramps.push(middle.slice(start, start + size));
  return ramps.length > 0 ? ramps : [middle];
}

/** Slots per ramp. Defaults to treating the whole middle list as one ramp. */
export function rampSize(palette: Palette, settings: ColorSettings): number {
  const middle = middleColors(usedColors(palette, settings)).length;
  if (settings.rampSize && settings.rampSize > 0) return Math.min(settings.rampSize, Math.max(1, middle));
  return Math.max(1, middle);
}

/** Number of ramps available in the palette. */
export function rampCount(palette: Palette, settings: ColorSettings): number {
  return resolveRamps(palette, settings).length;
}

/** Which ramp an object uses, per `assign`. */
export function rampIndexForObject(object: SceneObject, index: number, palette: Palette, settings: ColorSettings): number {
  const count = rampCount(palette, settings);
  switch (settings.assign) {
    case 'byType': {
      const position = TYPE_ORDER.indexOf(object.type);
      return ((position < 0 ? 0 : position) % count + count) % count;
    }
    case 'byLevel':
      return ((Math.max(0, Math.floor(object.z)) % count) + count) % count;
    case 'cycle':
    default:
      return ((index % count) + count) % count;
  }
}

/** Map a Lambert band fraction (0 = darkest, 1 = lightest) to a slot in a ramp. */
export function bandToRampSlot(fraction: number, size: number): number {
  if (size <= 1) return 0;
  return Math.min(size - 1, Math.max(0, Math.round(fraction * (size - 1))));
}

/**
 * Feature 7 follow-up — the object value ramp bounds, mirroring `OBJECT_RAMP` in
 * [`src/core/compose.ts`](src/core/compose.ts:19). Kept here (rather than imported)
 * so `color.ts` does not depend on `compose.ts`, which imports this module.
 */
const OBJECT_VALUE_RAMP = [64, 232] as const;

/**
 * Feature 7 follow-up — the `bands` object value greys, darkest → lightest, as
 * `#rrggbb`. Reproduces the `OBJECT_RAMP` quantisation in `toneAt()` exactly
 * (same rounding) so the UI chip is the literal pixel value the colour path uses.
 */
export function valueBands(bands: number): string[] {
  const count = Math.max(1, Math.floor(bands));
  const greys: string[] = [];
  for (let band = 0; band < count; band++) {
    const fraction = count > 1 ? band / (count - 1) : 1;
    const grey = Math.round(OBJECT_VALUE_RAMP[0] + (OBJECT_VALUE_RAMP[1] - OBJECT_VALUE_RAMP[0]) * fraction);
    const channel = grey.toString(16).padStart(2, '0');
    greys.push(`#${channel}${channel}${channel}`);
  }
  return greys;
}

/**
 * The `#rrggbb` colour for an object at a given Lambert band fraction.
 *
 * Feature 7 follow-up — when `settings.colorMode === 'bands'` and an explicit
 * `bandColors` map is present, the band's mapped hex wins. A missing or empty
 * entry falls through to the positional ramp path for that band only. `bands`
 * is `RenderOptions.bands`, used to recover the band index from the fraction.
 */
export function colorForBand(
  palette: Palette,
  settings: ColorSettings,
  object: SceneObject,
  objectIndex: number,
  fraction: number,
  bands: number,
): string {
  if (settings.colorMode === 'bands' && settings.bandColors?.length) {
    const band = bandToRampSlot(fraction, bands);
    const mapped = settings.bandColors[band];
    if (mapped) return mapped;
  }
  const ramps = resolveRamps(palette, settings);
  const size = rampSize(palette, settings);
  const ramp = Math.min(ramps.length - 1, Math.max(0, rampIndexForObject(object, objectIndex, palette, settings)));
  const slots = ramps[ramp] ?? ramps[ramps.length - 1] ?? [];
  const slot = bandToRampSlot(fraction, size);
  return slots[slot] ?? slots[slots.length - 1] ?? sharedHighlight(palette, settings);
}

/**
 * Whether colour should be applied to a document. Feature 7 is gated on the
 * absence of an imported combinatorics set: when one is present, the
 * combinatorics surface map takes precedence and colour is suppressed.
 */
export function colorActive(document: Pick<SceneDocument, 'palette' | 'combinatorics' | 'colorSettings'>): boolean {
  return Boolean(document.colorSettings?.enabled && document.palette && !document.combinatorics);
}