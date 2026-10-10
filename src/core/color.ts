// Feature 7 — rampart palette import and colour mapping.
//
// plinth does not import rampart code. It accepts rampart's *export* shapes
// defensively and uses the resolved `hexColors` list as an ordered ramp:
// shared shadow → each ramp dark→light → shared highlight.
//
// Pure TypeScript, no DOM: the same code runs in the browser and in node tests.

import type { ColorSettings, Palette, PrimitiveType, SceneDocument, SceneObject } from './types';

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

// ── Mapping ──────────────────────────────────────────────────────────────────

/** Stable type order for `assign: 'byType'`. */
const TYPE_ORDER: PrimitiveType[] = ['block', 'wall', 'stairs', 'ramp', 'cylinder', 'sphere', 'cone', 'pyramid', 'arch'];

/** The ramp slots between the shared shadow and highlight. */
export function rampColors(palette: Palette): string[] {
  return palette.colors.length > 2 ? palette.colors.slice(1, -1) : palette.colors.slice();
}

export function sharedShadow(palette: Palette): string {
  return palette.colors[0] ?? '#000000';
}

export function sharedHighlight(palette: Palette): string {
  return palette.colors[palette.colors.length - 1] ?? '#ffffff';
}

/** Slots per ramp. Defaults to treating the whole middle list as one ramp. */
export function rampSize(palette: Palette, settings: ColorSettings): number {
  const middle = rampColors(palette).length;
  if (settings.rampSize && settings.rampSize > 0) return Math.min(settings.rampSize, Math.max(1, middle));
  return Math.max(1, middle);
}

/** Number of ramps available in the palette. */
export function rampCount(palette: Palette, settings: ColorSettings): number {
  return Math.max(1, Math.floor(rampColors(palette).length / rampSize(palette, settings)));
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

/** The `#rrggbb` colour for an object at a given Lambert band fraction. */
export function colorForBand(
  palette: Palette,
  settings: ColorSettings,
  object: SceneObject,
  objectIndex: number,
  fraction: number,
): string {
  const ramps = rampColors(palette);
  const size = rampSize(palette, settings);
  const ramp = rampIndexForObject(object, objectIndex, palette, settings);
  const slot = bandToRampSlot(fraction, size);
  return ramps[ramp * size + slot] ?? ramps[ramps.length - 1] ?? sharedHighlight(palette);
}

/**
 * Whether colour should be applied to a document. Feature 7 is gated on the
 * absence of an imported combinatorics set: when one is present, the
 * combinatorics surface map takes precedence and colour is suppressed.
 */
export function colorActive(document: Pick<SceneDocument, 'palette' | 'combinatorics' | 'colorSettings'>): boolean {
  return Boolean(document.colorSettings?.enabled && document.palette && !document.combinatorics);
}
