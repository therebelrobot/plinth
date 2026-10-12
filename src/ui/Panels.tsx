stdout:
;
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseRampartFile, sharedShadow, valueBands } from '../core/color';
import { parseCombinatorics, type CombinatoricsScheme } from '../core/combinatorics';
import { composeImage, type TilesetPlacement } from '../core/compose';
import { DIRECTIONAL_TYPES, LEVEL_CHANGING_TYPES, PARAMETER_SPECS, PRIMITIVE_PRESETS, TALL_VARIANTS, TYPE_LABELS, baseHeight, parameterOf, rotatedFootprint, tallVariantLabel } from '../core/primitives';
import { sceneProjection } from '../core/projection';
import { renderPrimitive } from '../core/render';
import { TILESET_CONFIG_COUNT, buildTilesetPlacements, faceKey, type TilesetSpriteSet } from '../core/tileset';
import type { ColorSettings, CombinatoricsSet, Palette, PrimitiveType, RenderOptions, Rotation, SceneDocument, SceneObject, SceneSettings, TilesetRef } from '../core/types';
import {
  canShareFiles, deliverFile, exportCombinatoricsJson, exportPrimitiveKit, exportPrimitivePng, exportSceneJson, exportScenePng, exportScenePsd, rgbaToCanvas,
} from '../lib/exporters';
import { deleteTilesetSprites, exportTileset, importTileset, loadTilesetSprites, saveTilesetSprites } from '../lib/tileset';
import { Icon } from './Icon';
import { NumberField, Segmented, Toggle } from './Fields';

// Feature 7 follow-up — Outline and Floor pick from the imported palette's
// swatches instead of a free colour picker. Real buttons keep the grid
// keyboard-operable (R5.3); `aria-pressed` plus a check glyph means selection is
// never shown by colour alone (R5.2). The free picker is used only when no
// palette is imported (see ScenePanel below).
function SwatchPicker(props: {
  label: string;
  colors: string[];
  value: string | undefined;
  fallback: string;
  onPick: (color: string) => void;
}) {
  const selected = (props.value ?? props.fallback).toLowerCase();
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="swatches" role="group" aria-label={`${props.label} colour`}>
        {props.colors.map((color, index) => {
          const isSelected = color.toLowerCase() === selected;
          return (
            <button
              key={`${props.label}-${index}-${color}`}
              type="button"
              className={`swatch swatch-pick${isSelected ? ' is-selected' : ''}`}
              style={{ background: color }}
              title={`${color} — slot ${index}`}
              aria-label={`${props.label} colour, slot ${index}: ${color}`}
              aria-pressed={isSelected}
              onClick={() => props.onPick(color)}
            >
              <span className="swatch-check" aria-hidden="true">✓</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Feature 7 follow-up — a swatch dropdown. A native <select> cannot render
// colour, so this is a small custom disclosure: a trigger button showing the
// current choice, opening a popover grid of real swatch buttons. Keyboard and
// screen-reader access are preserved (R5.3/R5.9): the trigger is a button with
// aria-expanded/aria-controls, options are real buttons with aria-pressed,
// Escape closes and returns focus, and a check glyph plus the hex text mean
// selection is never shown by colour alone (R5.4). The popover is fixed-
// positioned (the panel scroll container would otherwise clip it) and flips
// above the trigger when there is no room below.
function SwatchSelect(props: {
  label: string;
  colors: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { colors, value } = props;
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  const computePlacement = () => {
    const el = triggerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // Once the trigger has scrolled fully out of the viewport there is nothing
    // to anchor to; callers may close the popover.
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    return {
      top: openUp ? undefined : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : undefined,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(120, Math.min(260, openUp ? spaceAbove : spaceBelow)),
    };
  };

  const openPopover = () => {
    const next = computePlacement();
    if (!next) return;
    setPlacement(next);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Reposition on scroll instead of closing: the panel is itself a scroll
    // container, so a capture-phase scroll listener would otherwise dismiss the
    // popover as soon as the user scrolls it. Scrolls that originate *inside*
    // the popover are ignored; only a trigger that has scrolled fully out of
    // view closes the popover.
    const onScroll = (event: Event) => {
      if (popoverRef.current && event.target instanceof Node && popoverRef.current.contains(event.target)) return;
      const next = computePlacement();
      if (!next) {
        setOpen(false);
        return;
      }
      setPlacement(next);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Move focus into the popover when it opens, onto the selected option.
  useEffect(() => {
    if (!open) return;
    const selected = popoverRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    const first = popoverRef.current?.querySelector<HTMLButtonElement>('button');
    (selected ?? first)?.focus();
  }, [open]);

  const index = colors.findIndex((color) => color.toLowerCase() === value.toLowerCase());
  const inPalette = !value || index >= 0;
  const currentLabel = value ? (index >= 0 ? `${index}: ${value}` : value) : 'Auto (ramp)';

  const choose = (next: string) => {
    props.onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="swatch-select" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="swatch-select-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={props.label}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        <span className={`swatch-select-chip${value ? '' : ' is-auto'}`} style={value ? { background: value } : undefined} aria-hidden="true" />
        <span className="swatch-select-text">{currentLabel}</span>
        <span className="swatch-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && placement && (
        <div
          className="swatch-select-popover"
          id={popoverId}
          ref={popoverRef}
          role="group"
          aria-label={props.label}
          style={{ top: placement.top, bottom: placement.bottom, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }}
        >
          <button
            type="button"
            className={`swatch-select-option${value ? '' : ' is-selected'}`}
            aria-pressed={!value}
            onClick={() => choose('')}
          >
            <span className="swatch-select-chip is-auto" aria-hidden="true" />
            <span className="swatch-select-option-text">Auto (ramp)</span>
            <span className="swatch-select-check" aria-hidden="true">✓</span>
          </button>
          {colors.map((color, position) => {
            const selected = color.toLowerCase() === value.toLowerCase();
            return (
              <button
                key={`${position}-${color}`}
                type="button"
                className={`swatch-select-option${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => choose(color)}
              >
                <span className="swatch-select-chip" style={{ background: color }} aria-hidden="true" />
                <span className="swatch-select-option-text">{position}: {color}</span>
                <span className="swatch-select-check" aria-hidden="true">✓</span>
              </button>
            );
          })}
          {!inPalette && value && (
            <button
              type="button"
              className="swatch-select-option is-selected"
              aria-pressed
              onClick={() => choose(value)}
            >
              <span className="swatch-select-chip" style={{ background: value }} aria-hidden="true" />
              <span className="swatch-select-option-text">{value} (not in palette)</span>
              <span className="swatch-select-check" aria-hidden="true">✓</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Feature 7 follow-up — the two-column value → colour map. LEFT: the fixed
// object value bands the colour path uses (from `valueBands`); RIGHT: a swatch
// dropdown per band choosing a palette swatch or Auto. The band number, grey hex
// and palette index are all text, so the mapping never relies on colour alone
// (R5.4). Targets are ≥24×24 CSS px (R5.2). No div click handlers.
function ValueMapping(props: {
  bands: number;
  colors: string[];
  bandColors: string[] | undefined;
  onChange: (bandColors: string[] | undefined) => void;
}) {
  const { bands, colors, bandColors } = props;
  const greys = valueBands(bands);

  // Persist as short as possible: trim trailing Auto entries, but keep any set
  // tail entry so bands beyond the current count are retained (§3.1). An
  // all-Auto map persists as absent.
  const write = (next: string[]) => {
    let end = next.length;
    while (end > 0 && !next[end - 1]) end--;
    const trimmed = next.slice(0, end);
    props.onChange(trimmed.length > 0 ? trimmed : undefined);
  };

  const setBand = (index: number, value: string) => {
    const next = [...(bandColors ?? [])];
    while (next.length <= index) next.push('');
    next[index] = value;
    write(next);
  };

  // Convenience: evenly sample the palette (shadow → ramps → highlight) across
  // the bands, so the ends are the shared shadow/highlight and the middle bands
  // are middle-ramp colours.
  const autoMap = () => {
    const count = colors.length;
    const next: string[] = [];
    for (let band = 0; band < bands; band++) {
      const position = bands > 1 ? Math.round((band * (count - 1)) / (bands - 1)) : 0;
      next.push(colors[position] ?? colors[0] ?? '');
    }
    write(next);
  };

  return (
    <div className="value-map" role="group" aria-label="Value to colour mapping">
      <span className="value-map-head">Scene value</span>
      <span className="value-map-head value-map-arrow" aria-hidden="true">→</span>
      <span className="value-map-head">Swatch colour</span>
      {greys.map((grey, band) => {
        const current = bandColors?.[band] ?? '';
        const tag = band === 0 ? ' · darkest' : band === bands - 1 ? ' · lightest' : '';
        return (
          <Fragment key={band}>
            <span className="value-map-value">
              <span className="value-map-chip" style={{ background: grey }} aria-hidden="true" />
              <span className="value-map-label">{band + 1}{tag}</span>
              <code className="value-map-hex">{grey}</code>
            </span>
            <span className="value-map-arrow" aria-hidden="true">→</span>
            <span className="value-map-pick">
              <SwatchSelect
                label={`Band ${band + 1} (grey ${grey}) colour`}
                colors={colors}
                value={current}
                onChange={(value) => setBand(band, value)}
              />
            </span>
          </Fragment>
        );
      })}
      <div className="button-row value-map-actions">
        <button type="button" className="button" onClick={autoMap}>Auto-map dark→light</button>
        <button type="button" className="button" onClick={() => props.onChange(undefined)}>Clear mapping</button>
      </div>
    </div>
  );
}

// ── Object ──────────────────────────────────────────────────────────────────

export function ObjectPanel(props: {
  object: SceneObject | null;
  settings: SceneSettings;
  onChange: (patch: Partial<SceneObject>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onExport: () => void;
}) {
  const { object, settings, onChange } = props;
  if (!object) {
    return (
      <div className="panel-empty">
        <p>Nothing selected.</p>
        <p className="muted">Use the <strong>Select</strong> tool (V) and tap a piece to edit its size, height and facing. Drag a selected piece to move it.</p>
      </div>
    );
  }
  const snap = settings.snap;
  const spec = PARAMETER_SPECS[object.type];
  const rotate = (to: Rotation) => {
    const [width, depth] = rotatedFootprint(object.width, object.depth, object.rotation, to);
    onChange({ rotation: to, width, depth });
  };
  const nudge = (dx: number, dy: number, dz: number) => onChange({
    x: Math.min(Math.max(0, object.x + dx * snap), settings.floorTilesX - object.width),
    y: Math.min(Math.max(0, object.y + dy * snap), settings.floorTilesY - object.depth),
    z: Math.min(Math.max(0, object.z + dz * snap), settings.levelCount - object.height),
  });
  return (
    <div className="panel-body">
      <div className="field">
        <span className="field-label">Shape</span>
        <select value={object.type} onChange={(event) => onChange({ type: event.target.value as PrimitiveType, parameter: PARAMETER_SPECS[event.target.value as PrimitiveType]?.fallback })}>
          {Object.entries(TYPE_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
        </select>
      </div>

      <h3>Position</h3>
      <div className="nudge">
        <div className="nudge-pad" aria-label="Move on the floor">
          <button type="button" onClick={() => nudge(-1, 0, 0)} title="−x (up-left)"><Icon name="nudgeNW" /></button>
          <button type="button" onClick={() => nudge(0, -1, 0)} title="−y (up-right)"><Icon name="nudgeNE" /></button>
          <button type="button" onClick={() => nudge(0, 1, 0)} title="+y (down-left)"><Icon name="nudgeSW" /></button>
          <button type="button" onClick={() => nudge(1, 0, 0)} title="+x (down-right)"><Icon name="nudgeSE" /></button>
        </div>
        <div className="nudge-z" aria-label="Move up or down">
          <button type="button" onClick={() => nudge(0, 0, 1)} title="Up a step"><Icon name="up" /></button>
          <button type="button" onClick={() => nudge(0, 0, -1)} title="Down a step"><Icon name="down" /></button>
        </div>
      </div>
      <div className="grid-3">
        <NumberField label="X" value={object.x} step={snap} min={0} max={settings.floorTilesX - object.width} onChange={(x) => onChange({ x })} />
        <NumberField label="Y" value={object.y} step={snap} min={0} max={settings.floorTilesY - object.depth} onChange={(y) => onChange({ y })} />
        <NumberField label="Z" value={object.z} step={Math.min(snap, 0.25)} min={0} max={settings.levelCount - object.height} onChange={(z) => onChange({ z })} />
      </div>

      <h3>Size</h3>
      <div className="grid-3">
        <NumberField label="Width" hint="x" value={object.width} step={0.25} min={0.25} max={settings.floorTilesX - object.x} onChange={(width) => onChange({ width })} />
        <NumberField label="Depth" hint="y" value={object.depth} step={0.25} min={0.25} max={settings.floorTilesY - object.y} onChange={(depth) => onChange({ depth })} />
        <NumberField label="Height" hint="levels" value={object.height} step={0.25} min={0.125} max={settings.levelCount - object.z} onChange={(height) => onChange({ height })} />
      </div>

      {LEVEL_CHANGING_TYPES.has(object.type) && (
        <Segmented<number>
          label="Height variant"
          value={object.height / baseHeight(object.type)}
          onChange={(tallness) => onChange({ height: Number((baseHeight(object.type) * tallness).toFixed(4)) })}
          options={TALL_VARIANTS.map((tallness) => ({ value: tallness, label: tallVariantLabel(tallness) }))}
        />
      )}

      {DIRECTIONAL_TYPES.has(object.type) && (
        <Segmented<Rotation>
          label="Facing"
          value={object.rotation}
          onChange={rotate}
          options={[
            { value: 0, label: '↘ +x' },
            { value: 1, label: '↙ +y' },
            { value: 2, label: '↖ −x' },
            { value: 3, label: '↗ −y' },
          ]}
        />
      )}
      {spec && (
        <NumberField label={spec.label} value={parameterOf(object)} step={spec.step} min={spec.min} max={spec.max} onChange={(parameter) => onChange({ parameter })} />
      )}

      {object.type === 'wall' && (
        <>
          <NumberField label="Slope" hint="0 flat · 1 full" value={object.slope ?? 0} step={0.25} min={0} max={1} onChange={(slope) => onChange({ slope })} />
          {(object.slope ?? 0) > 0 && (
            <Segmented<1 | -1>
              label="Slope rises"
              value={object.slopeDirection ?? 1}
              onChange={(slopeDirection) => onChange({ slopeDirection })}
              options={[
                { value: 1, label: '↘ low-y' },
                { value: -1, label: '↖ high-y' },
              ]}
            />
          )}
        </>
      )}

      <div className="button-row">
        <button type="button" className="button" onClick={props.onDuplicate}><Icon name="copy" size={16} /> Duplicate</button>
        <button type="button" className="button" onClick={props.onExport}><Icon name="download" size={16} /> Export alone</button>
        <button type="button" className="button danger" onClick={props.onDelete}><Icon name="trash" size={16} /> Delete</button>
      </div>
    </div>
  );
}

// ── Scene ───────────────────────────────────────────────────────────────────

export function ScenePanel(props: { document: SceneDocument; onSettings: (patch: Partial<SceneSettings>) => void; onRename: (name: string) => void }) {
  const { settings } = props.document;
  const projection = sceneProjection(settings);
  const set = props.onSettings;
  const trueIsoHeight = Math.round(settings.tileWidthPixels * 0.6124);
  return (
    <div className="panel-body">
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={props.document.name} onChange={(event) => props.onRename(event.target.value)} />
      </label>

      <h3>Tile</h3>
      <NumberField label="Tile width" hint="px, tile height is half" value={settings.tileWidthPixels} step={4} min={8} max={256} suffix="px" onChange={(tileWidthPixels) => set({ tileWidthPixels })} />
      <NumberField label="Level height" hint="px per level" value={settings.levelHeightPixels} step={1} min={2} max={512} suffix="px" onChange={(levelHeightPixels) => set({ levelHeightPixels })} />
      <div className="chip-row">
        <button type="button" className={`chip ${settings.levelHeightPixels === settings.tileWidthPixels / 2 ? 'is-active' : ''}`} onClick={() => set({ levelHeightPixels: settings.tileWidthPixels / 2 })}>
          Classic cube · {settings.tileWidthPixels / 2}px
        </button>
        <button type="button" className={`chip ${settings.levelHeightPixels === trueIsoHeight ? 'is-active' : ''}`} onClick={() => set({ levelHeightPixels: trueIsoHeight })}>
          True iso · {trueIsoHeight}px
        </button>
      </div>

      <h3>Floor</h3>
      <div className="grid-2">
        <NumberField label="Tiles X" value={settings.floorTilesX} step={1} min={1} max={64} onChange={(floorTilesX) => set({ floorTilesX })} />
        <NumberField label="Tiles Y" value={settings.floorTilesY} step={1} min={1} max={64} onChange={(floorTilesY) => set({ floorTilesY })} />
      </div>
      <div className="grid-2">
        <NumberField label="Levels" hint="headroom" value={settings.levelCount} step={1} min={1} max={32} onChange={(levelCount) => set({ levelCount })} />
        <NumberField label="Base" hint="levels thick" value={settings.baseThicknessLevels} step={0.25} min={0} max={4} onChange={(baseThicknessLevels) => set({ baseThicknessLevels })} />
      </div>
      <NumberField label="Padding" value={settings.paddingPixels} step={1} min={0} max={128} suffix="px" onChange={(paddingPixels) => set({ paddingPixels })} />
      <Segmented<number>
        label="Snap"
        value={settings.snap}
        onChange={(snap) => set({ snap })}
        options={[{ value: 1, label: '1' }, { value: 0.5, label: '½' }, { value: 0.25, label: '¼' }]}
      />

      <div className="readout-card">
        <span>Canvas</span>
        <strong>{projection.width} × {projection.height}px</strong>
        <small>Make a Procreate canvas this size (or a multiple of it) and set its resampling to nearest neighbour.</small>
      </div>
    </div>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

export function ViewPanel(props: { options: RenderOptions; onChange: (patch: Partial<RenderOptions>) => void }) {
  const { options, onChange } = props;
  return (
    <div className="panel-body">
      <p className="muted small">These settings shape both the editor and every export.</p>
      <Segmented<RenderOptions['shading']>
        label="Values"
        value={options.shading}
        onChange={(shading) => onChange({ shading })}
        options={[
          { value: 'shaded', label: 'Light', title: 'Banded light from upper left' },
          { value: 'height', label: 'Height', title: 'Value by level' },
          { value: 'silhouette', label: 'Flat', title: 'One value per piece' },
          { value: 'blank', label: 'Blank', title: 'White, lines only' },
        ]}
      />
      {options.shading === 'shaded' && (
        <NumberField label="Value bands" value={options.bands} step={1} min={3} max={6} onChange={(bands) => onChange({ bands })} />
      )}
      <Segmented<RenderOptions['outlines']>
        label="Lines"
        value={options.outlines}
        onChange={(outlines) => onChange({ outlines })}
        options={[
          { value: 'all', label: 'All edges' },
          { value: 'silhouette', label: 'Silhouette' },
          { value: 'none', label: 'None' },
        ]}
      />
      <Toggle label="Merge flush faces" hint="no seams between touching pieces" checked={options.mergeCoplanarFaces} onChange={(mergeCoplanarFaces) => onChange({ mergeCoplanarFaces })} />
      <Toggle label="Floor" checked={options.showFloor} onChange={(showFloor) => onChange({ showFloor })} />
      <Toggle label="Floor grid" checked={options.showFloorGrid} onChange={(showFloorGrid) => onChange({ showFloorGrid })} />
      <Segmented<RenderOptions['background']>
        label="Background"
        value={options.background}
        onChange={(background) => onChange({ background })}
        options={[
          { value: 'transparent', label: 'None' },
          { value: 'white', label: 'White' },
          { value: 'neutral', label: 'Grey' },
        ]}
      />
    </div>
  );
}

// ── Export ──────────────────────────────────────────────────────────────────

function PrimitivePreview(props: { settings: SceneSettings; object: SceneObject; options: RenderOptions }) {
  const url = useMemo(() => {
    const buffers = renderPrimitive(props.settings, props.object, props.options);
    return { src: rgbaToCanvas(composeImage(buffers, props.options, props.settings), buffers.width, buffers.height).toDataURL(), width: buffers.width, height: buffers.height };
  }, [props.settings, props.object, props.options]);
  const scale = Math.max(1, Math.min(4, Math.floor(160 / Math.max(url.width, url.height))));
  return (
    <div className="primitive-preview">
      <img src={url.src} width={url.width * scale} height={url.height * scale} alt="Primitive preview" />
      <small>{url.width} × {url.height}px</small>
    </div>
  );
}

export function ExportPanel(props: {
  document: SceneDocument;
  options: RenderOptions;
  onImport: (document: SceneDocument) => void;
  onCombinatorics: (set: CombinatoricsSet | undefined) => void;
  onPalette: (palette: Palette | undefined) => void;
  onColorSettings: (settings: ColorSettings | undefined) => void;
  onTileset: (ref: TilesetRef | undefined) => void;
  notify: (message: string) => void;
}) {
  const { document, options, notify } = props;
  const [scale, setScale] = useState(1);
  const [scheme, setScheme] = useState<CombinatoricsScheme>('iso-4');
  const [pngColor, setPngColor] = useState(false);
  const [psdLayers, setPsdLayers] = useState<'cutaway' | 'levels'>('cutaway');
  const [busy, setBusy] = useState<string | null>(null);
  const shareable = useMemo(() => canShareFiles(), []);
  const faceCount = useMemo(() => new Set(document.objects.map(faceKey)).size, [document.objects]);

  // Feature 10 — decoded tileset sprites (IndexedDB) → per-object render placements,
  // so PNG/PSD exports composite the art with the same precedence as the viewport.
  const [tilesetSprites, setTilesetSprites] = useState<TilesetSpriteSet | null>(null);
  useEffect(() => {
    const ref = document.tileset;
    if (!ref) { setTilesetSprites(null); return; }
    let cancelled = false;
    loadTilesetSprites(ref.id)
      .then((sprites) => { if (!cancelled) setTilesetSprites(sprites); })
      .catch(() => { if (!cancelled) setTilesetSprites(null); });
    return () => { cancelled = true; };
  }, [document.tileset]);
  const tilesetPlacements = useMemo<(TilesetPlacement | null)[] | undefined>(() => {
    if (!document.tileset || !tilesetSprites) return undefined;
    return buildTilesetPlacements(document.objects, document.tileset.manifest, tilesetSprites);
  }, [document.tileset, document.objects, tilesetSprites]);
  const tilesetSpriteCount = document.tileset
    ? document.tileset.manifest.faces.reduce((total, face) => total + Object.keys(face.sprites).length, 0)
    : 0;
  const [presetKey, setPresetKey] = useState(PRIMITIVE_PRESETS[0].key);
  const preset = PRIMITIVE_PRESETS.find((candidate) => candidate.key === presetKey)!;
  const [size, setSize] = useState({ width: preset.width, depth: preset.depth, height: preset.height });
  const [rotation, setRotation] = useState<Rotation>(0);
  const [parameter, setParameter] = useState<number | undefined>(preset.parameter);

  const primitive: SceneObject = {
    id: 'export', type: preset.type, x: 0, y: 0, z: 0, ...size, rotation, parameter,
  };

  const run = async (label: string, make: () => Promise<{ blob: Blob; filename: string }> | { blob: Blob; filename: string }, share = false) => {
    setBusy(label);
    try {
      const { blob, filename } = await make();
      const outcome = await deliverFile(blob, filename, share);
      if (outcome !== 'cancelled') notify(`${outcome === 'shared' ? 'Shared' : 'Saved'} ${filename}`);
    } catch (error) {
      notify(`Export failed: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const exportOptions = { ...options, hideAboveLevel: null };

  // Merge into the existing colour settings so outline/floor overrides survive
  // unrelated edits (enable, assign, ramp size).
  const setColorSettings = (patch: Partial<ColorSettings>) => {
    const base: ColorSettings = document.colorSettings ?? { enabled: true, assign: 'cycle' };
    props.onColorSettings({ ...base, ...patch });
  };

  const exportButton = (buttonProps: { label: string; make: () => Promise<{ blob: Blob; filename: string }> | { blob: Blob; filename: string } }) => (
    <div className="export-action" key={buttonProps.label}>
      <button type="button" className="button primary" disabled={busy !== null} onClick={() => run(buttonProps.label, buttonProps.make)}>
        <Icon name="download" size={16} /> {busy === buttonProps.label ? 'Working…' : buttonProps.label}
      </button>
      {shareable && (
        <button type="button" className="button icon-only" aria-label={`Share ${buttonProps.label}`} disabled={busy !== null} onClick={() => run(buttonProps.label, buttonProps.make, true)}>
          <Icon name="share" size={16} />
        </button>
      )}
    </div>
  );

  return (
    <div className="panel-body">
      <Segmented<number>
        label="Scale"
        value={scale}
        onChange={setScale}
        options={[1, 2, 4, 8].map((value) => ({ value, label: `${value}×` }))}
      />
      <p className="muted small">1× is pixel-exact. Larger scales are nearest-neighbour, for canvases that aren't pixel-sized.</p>

      <h3>Scene</h3>
      {document.palette && (
        <Segmented<'grey' | 'colour'>
          label="PNG values"
          value={pngColor ? 'colour' : 'grey'}
          onChange={(value) => setPngColor(value === 'colour')}
          options={[
            { value: 'grey', label: 'Grey', title: 'Greyscale trace' },
            { value: 'colour', label: 'Colour', title: 'Base colour from the imported palette' },
          ]}
        />
      )}
      {exportButton({ label: 'PNG', make: () => exportScenePng(document, exportOptions, scale, pngColor, tilesetPlacements) })}
      <Segmented<'cutaway' | 'levels'>
        label="PSD layers"
        value={psdLayers}
        onChange={setPsdLayers}
        options={[
          { value: 'cutaway', label: 'Cutaway', title: 'One layer per cut level — hiding from the top down walks the viewer cutaway' },
          { value: 'levels', label: 'By level', title: 'Floor, grid, one layer per base level, outlines' },
        ]}
      />
      {exportButton({ label: 'Layered PSD', make: () => exportScenePsd(document, exportOptions, scale, tilesetPlacements, psdLayers) })}
      <p className="muted small">
        {psdLayers === 'cutaway'
          ? 'Cutaway layers are differences against the previous cut, so hiding them from the top down matches the viewer cutaway — each hidden layer reveals the surfaces underneath instead of leaving a hole. Procreate opens the PSD with layers intact.'
          : 'Floor, grid, one layer per base level and lines as separate layers. Each level layer holds only the pixels that level wins, so hiding one leaves a hole rather than revealing what is behind it.'}
      </p>

      <h3>Primitive in isolation</h3>
      <div className="field">
        <span className="field-label">Shape</span>
        <select value={presetKey} onChange={(event) => {
          const next = PRIMITIVE_PRESETS.find((candidate) => candidate.key === event.target.value)!;
          setPresetKey(next.key);
          setSize({ width: next.width, depth: next.depth, height: next.height });
          setParameter(next.parameter);
          setRotation(0);
        }}>
          {PRIMITIVE_PRESETS.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
        </select>
      </div>
      <div className="grid-3">
        <NumberField label="W" value={size.width} step={0.25} min={0.25} max={16} onChange={(width) => setSize({ ...size, width })} />
        <NumberField label="D" value={size.depth} step={0.25} min={0.25} max={16} onChange={(depth) => setSize({ ...size, depth })} />
        <NumberField label="H" value={size.height} step={0.25} min={0.125} max={16} onChange={(height) => setSize({ ...size, height })} />
      </div>
      {DIRECTIONAL_TYPES.has(preset.type) && (
        <Segmented<Rotation>
          label="Facing"
          value={rotation}
          onChange={(next) => {
            const [width, depth] = rotatedFootprint(size.width, size.depth, rotation, next);
            setSize({ ...size, width, depth });
            setRotation(next);
          }}
          options={[{ value: 0, label: '↘' }, { value: 1, label: '↙' }, { value: 2, label: '↖' }, { value: 3, label: '↗' }]}
        />
      )}
      {PARAMETER_SPECS[preset.type] && (
        <NumberField
          label={PARAMETER_SPECS[preset.type]!.label}
          value={parameter ?? PARAMETER_SPECS[preset.type]!.fallback}
          step={PARAMETER_SPECS[preset.type]!.step}
          min={PARAMETER_SPECS[preset.type]!.min}
          max={PARAMETER_SPECS[preset.type]!.max}
          onChange={setParameter}
        />
      )}
      <PrimitivePreview settings={document.settings} object={primitive} options={exportOptions} />
      {exportButton({ label: 'Primitive PNG', make: () => exportPrimitivePng(document.settings, primitive, exportOptions, scale) })}
      {exportButton({ label: 'Primitive kit (.zip)', make: () => exportPrimitiveKit(document.settings, exportOptions, scale) })}
      <p className="muted small">The kit has every palette shape in every facing at this scene's tile size: individual PNGs cropped to their bounds, a sheet, and kit.json with anchor offsets.</p>

      <h3>Combinatorics</h3>
      <Segmented<CombinatoricsScheme>
        label="Connectivity"
        value={scheme}
        onChange={setScheme}
        options={[
          { value: 'iso-4', label: 'iso-4', title: 'Four orthogonal neighbours (N/E/S/W)' },
          { value: 'iso-8', label: 'iso-8', title: 'Adds diagonals — 47 blob classes' },
        ]}
      />
      <p className="muted small">Center, edge (straight) and corner classes for every primitive in the scene. <strong>edge</strong> means a straight run (two opposite connections).</p>
      {exportButton({ label: 'Combinatorics (JSON)', make: () => exportCombinatoricsJson(document, { scheme }) })}

      <p className="muted small">Import a <code>plinth.combinatorics</code> file to drive each primitive's open faces from the scene's adjacency. Without one, rendering uses geometry and <strong>Merge flush faces</strong> alone.</p>
      <div className="button-row">
        <label className="button">
          <Icon name="folder" size={16} /> Import combinatorics
          <input type="file" accept="application/json,.json" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try {
              const parsed = parseCombinatorics(await file.text());
              props.onCombinatorics(parsed);
              notify(`Imported combinatorics (${parsed.scheme}, ${parsed.primitives.length} primitives)`);
            } catch (error) {
              notify(`Import failed: ${(error as Error).message}`);
            }
          }} />
        </label>
        {document.combinatorics && (
          <button type="button" className="button danger" onClick={() => { props.onCombinatorics(undefined); notify('Cleared combinatorics'); }}>
            <Icon name="trash" size={16} /> Clear
          </button>
        )}
      </div>
      {document.combinatorics && (
        <p className="muted small">
          Active set: <strong>{document.combinatorics.scheme}</strong> · {document.combinatorics.primitives.length} primitive{ document.combinatorics.primitives.length === 1 ? '' : 's' }
          {document.combinatorics.source?.exportedAt ? ` · exported ${document.combinatorics.source.exportedAt}` : ''}
        </p>
      )}

      <h3>Tileset (image combinatorics)</h3>
      <p className="muted small">Discrete block-image templates for drawing over in Procreate: <strong>47</strong> open-corner configurations per face (a grey isometric block with its open edges un-outlined), plus a manifest, packaged as a zip. Faces: <strong>{faceCount}</strong> · configs: <strong>{TILESET_CONFIG_COUNT}</strong>.</p>
      {exportButton({ label: 'Tileset (.zip)', make: () => exportTileset(document, exportOptions, scale) })}
      <p className="muted small">Draw the art over the templates in Procreate, then re-import the zip. Sprites replace the grey textures on each tile; transparent pixels keep grey. Precedence: <strong>{'tileset > rampart colour > grey'}</strong>.</p>
      <div className="button-row">
        <label className="button">
          <Icon name="folder" size={16} /> Import tileset
          <input type="file" accept="application/zip,.zip" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try {
              const warnings: string[] = [];
              const imported = await importTileset(file, undefined, (message) => warnings.push(message));
              await saveTilesetSprites(imported.ref.id, imported.sprites);
              props.onTileset(imported.ref);
              const configs = [...imported.sprites.values()].reduce((total, map) => total + map.size, 0);
              notify(`Imported tileset (${imported.ref.manifest.faces.length} faces, ${configs} sprites)${warnings.length ? ` — ${warnings.join('; ')}` : ''}`);
            } catch (error) {
              notify(`Import failed: ${(error as Error).message}`);
            }
          }} />
        </label>
        {document.tileset && (
          <button type="button" className="button danger" onClick={async () => {
            const id = document.tileset?.id;
            props.onTileset(undefined);
            if (id) await deleteTilesetSprites(id);
            notify('Cleared tileset');
          }}>
            <Icon name="trash" size={16} /> Clear
          </button>
        )}
      </div>
      {document.tileset && (
        <p className="muted small">
          Active tileset: <strong>{document.tileset.manifest.faces.length}</strong> face{document.tileset.manifest.faces.length === 1 ? '' : 's'} · {tilesetSpriteCount} sprites · {document.tileset.manifest.projection.tileWidthPixels}px tiles
          {document.tileset.manifest.exportedAt ? ` · exported ${document.tileset.manifest.exportedAt}` : ''}
        </p>
      )}

      <h3>Colour (rampart)</h3>
      <p className="muted small">Import a rampart palette export to add a real <strong>Base color</strong> layer under the greyscale trace layers. Colour applies only when no combinatorics set is imported.</p>
      <div className="button-row">
        <label className="button">
          <Icon name="folder" size={16} /> Import palette
          <input type="file" accept=".json,.swatches,.gpl,.hex,application/json" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try {
              const warnings: string[] = [];
              const palettes = parseRampartFile(new Uint8Array(await file.arrayBuffer()), file.name, (message) => warnings.push(message));
              const palette = palettes[0];
              props.onPalette(palette);
              setColorSettings({ enabled: true });
              if (palettes.length > 1) warnings.push(`${palettes.length} palettes in the file — imported "${palette.name}"`);
              notify(`Imported palette "${palette.name}" (${palette.colors.length} colours)${warnings.length ? ` — ${warnings.join('; ')}` : ''}`);
            } catch (error) {
              notify(`Import failed: ${(error as Error).message}`);
            }
          }} />
        </label>
        {document.palette && (
          <button type="button" className="button danger" onClick={() => { props.onPalette(undefined); props.onColorSettings(undefined); notify('Cleared palette'); }}>
            <Icon name="trash" size={16} /> Clear
          </button>
        )}
      </div>
      {document.palette && (
        <>
          <Toggle label="Colour base layer" hint="adds a Base color layer to PSD/PNG exports" checked={Boolean(document.colorSettings?.enabled)} onChange={(enabled) => setColorSettings({ enabled })} />
          <Segmented<NonNullable<ColorSettings['colorMode']>>
            label="Colour from"
            value={document.colorSettings?.colorMode ?? 'ramps'}
            onChange={(colorMode) => setColorSettings({ colorMode })}
            options={[
              { value: 'ramps', label: 'Ramps', title: 'Positional ramps built from the palette slots' },
              { value: 'bands', label: 'Value map', title: 'Map each value band to a swatch colour' },
            ]}
          />
          {(document.colorSettings?.colorMode ?? 'ramps') === 'ramps' ? (
            <>
              <div className="swatches">
                {document.palette.colors.map((color, index) => {
                  const used = document.colorSettings?.swatchUse?.used;
                  const isUsed = !used || used.includes(index);
                  return (
                    <button
                      key={`${color}-${index}`}
                      type="button"
                      className="swatch"
                      style={{ background: color, opacity: isUsed ? 1 : 0.25 }}
                      title={isUsed ? `${color} — used (click to exclude)` : `${color} — excluded (click to include)`}
                      aria-pressed={isUsed}
                      onClick={() => {
                        const base = used ?? document.palette!.colors.map((_, position) => position);
                        const next = base.includes(index)
                          ? base.filter((position) => position !== index)
                          : [...base, index].sort((first, second) => first - second);
                        setColorSettings({ swatchUse: { ...document.colorSettings?.swatchUse, used: next } });
                      }}
                    />
                  );
                })}
              </div>
              <p className="muted small">Click a swatch to exclude it from the ramps. Excluded slots are skipped when the ramps are built.</p>
              <p className="muted small">How the list becomes colours: <strong>Shadow slot</strong> is the shared darkest colour and <strong>Highlight slot</strong> is the shared lightest colour — every ramp uses both. The colours in between are split into ramps that run <strong>dark → light</strong>. <strong>Ramp size</strong> sets how many colours are in each ramp. <strong>Assign ramps</strong> picks which ramp a shape uses: Cycle goes in placement order, By type gives each shape its own ramp, and By level gives each height its own ramp.</p>
              <Segmented<ColorSettings['assign']>
                label="Assign ramps"
                value={document.colorSettings?.assign ?? 'cycle'}
                onChange={(assign) => setColorSettings({ assign })}
                options={[
                  { value: 'cycle', label: 'Cycle', title: 'One ramp per object, in placement order' },
                  { value: 'byType', label: 'By type', title: 'One ramp per primitive type' },
                  { value: 'byLevel', label: 'By level', title: 'One ramp per level' },
                ]}
              />
              <NumberField label="Ramp size" value={document.colorSettings?.rampSize ?? Math.max(1, document.palette.colors.length - 2)} step={1} min={1} max={Math.max(1, document.palette.colors.length)} onChange={(rampSize) => setColorSettings({ rampSize })} />
              <div className="grid-2">
                <label className="field">
                  <span className="field-label">Shadow slot</span>
                  <select
                    value={document.colorSettings?.swatchUse?.shadowIndex ?? 0}
                    onChange={(event) => setColorSettings({ swatchUse: { ...document.colorSettings?.swatchUse, shadowIndex: Number(event.target.value) } })}
                  >
                    {document.palette.colors.map((color, index) => <option key={`shadow-${color}-${index}`} value={index}>{index}: {color}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Highlight slot</span>
                  <select
                    value={document.colorSettings?.swatchUse?.highlightIndex ?? document.palette.colors.length - 1}
                    onChange={(event) => setColorSettings({ swatchUse: { ...document.colorSettings?.swatchUse, highlightIndex: Number(event.target.value) } })}
                  >
                    {document.palette.colors.map((color, index) => <option key={`highlight-${color}-${index}`} value={index}>{index}: {color}</option>)}
                  </select>
                </label>
              </div>
            </>
          ) : (
            <>
              <ValueMapping
                bands={options.bands}
                colors={document.palette.colors}
                bandColors={document.colorSettings?.bandColors}
                onChange={(bandColors) => setColorSettings({ bandColors })}
              />
              <p className="muted small">Each value band maps to a swatch colour, or <strong>Auto (ramp)</strong> to fall back to the ramp. The band count follows the <strong>Value bands</strong> control in the View panel. Bands beyond the current value count are kept but unused.</p>
            </>
          )}
          <div className="grid-2">
            <SwatchPicker
              label="Outline"
              colors={document.palette.colors}
              value={document.colorSettings?.outlineColor}
              fallback={sharedShadow(document.palette, document.colorSettings)}
              onPick={(outlineColor) => setColorSettings({ outlineColor })}
            />
            <SwatchPicker
              label="Floor"
              colors={document.palette.colors}
              value={document.colorSettings?.floorColor}
              fallback={sharedShadow(document.palette, document.colorSettings)}
              onPick={(floorColor) => setColorSettings({ floorColor })}
            />
          </div>
          <p className="muted small">Outline and Floor come from the imported swatches. Click a swatch to use it for that layer.</p>
          {document.combinatorics && (
            <p className="muted small">A combinatorics set is imported, so colour is suppressed — the combinatorics surface map takes precedence.</p>
          )}
        </>
      )}

      {!document.palette && (
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Outline</span>
            <input type="color" value={document.colorSettings?.outlineColor ?? '#000000'} onChange={(event) => setColorSettings({ outlineColor: event.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Floor</span>
            <input type="color" value={document.colorSettings?.floorColor ?? '#000000'} onChange={(event) => setColorSettings({ floorColor: event.target.value })} />
          </label>
        </div>
      )}

      <h3>Scene file</h3>
      <div className="button-row">
        <button type="button" className="button" onClick={() => run('JSON', () => exportSceneJson(document))}><Icon name="download" size={16} /> Export JSON</button>
        <label className="button">
          <Icon name="folder" size={16} /> Import JSON
          <input type="file" accept="application/json,.json" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try {
              const parsed = JSON.parse(await file.text()) as SceneDocument;
              if (parsed.version !== 1 || !Array.isArray(parsed.objects) || !parsed.settings) throw new Error('not a plinth scene');
              props.onImport(parsed);
              notify(`Imported ${parsed.name}`);
            } catch (error) {
              notify(`Import failed: ${(error as Error).message}`);
            }
          }} />
        </label>
      </div>
    </div>
  );
}