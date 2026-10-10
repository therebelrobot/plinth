import { useMemo, useState } from 'react';
import { parseCombinatorics, type CombinatoricsScheme } from '../core/combinatorics';
import { composeImage } from '../core/compose';
import { DIRECTIONAL_TYPES, LEVEL_CHANGING_TYPES, PARAMETER_SPECS, PRIMITIVE_PRESETS, TALL_VARIANTS, TYPE_LABELS, baseHeight, parameterOf, rotatedFootprint, tallVariantLabel } from '../core/primitives';
import { sceneProjection } from '../core/projection';
import { renderPrimitive } from '../core/render';
import type { CombinatoricsSet, PrimitiveType, RenderOptions, Rotation, SceneDocument, SceneObject, SceneSettings } from '../core/types';
import {
  canShareFiles, deliverFile, exportCombinatoricsJson, exportPrimitiveKit, exportPrimitivePng, exportSceneJson, exportScenePng, exportScenePsd, rgbaToCanvas,
} from '../lib/exporters';
import { Icon } from './Icon';
import { NumberField, Segmented, Toggle } from './Fields';

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
  notify: (message: string) => void;
}) {
  const { document, options, notify } = props;
  const [scale, setScale] = useState(1);
  const [scheme, setScheme] = useState<CombinatoricsScheme>('iso-4');
  const [busy, setBusy] = useState<string | null>(null);
  const shareable = useMemo(() => canShareFiles(), []);
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
      {exportButton({ label: 'PNG', make: () => exportScenePng(document, exportOptions, scale) })}
      {exportButton({ label: 'Layered PSD', make: () => exportScenePsd(document, exportOptions, scale) })}
      <p className="muted small">The PSD has floor, grid, one layer per level and lines as separate layers. Procreate opens it with layers intact. Cutaway is ignored on export.</p>

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
