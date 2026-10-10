import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlacementSurface } from './core/placement';
import { DIRECTIONAL_TYPES, PRIMITIVE_PRESETS, rotatedFootprint } from './core/primitives';
import {
  DEFAULT_RENDER_OPTIONS, makeObjectId, newDocument,
  type RenderOptions, type Rotation, type SceneDocument, type SceneObject, type SceneSettings,
} from './core/types';
import { clearDraft, lastSceneId, loadDraft, rememberLastScene, saveDraft, sceneApi } from './lib/api';
import { deliverFile, exportPrimitivePng } from './lib/exporters';
import { presetIcon } from './lib/icons';
import { useHistory } from './state/history';
import { Icon } from './ui/Icon';
import { ExportPanel, ObjectPanel, ScenePanel, ViewPanel } from './ui/Panels';
import { ScenesDrawer } from './ui/ScenesDrawer';
import { Viewport, type PlacementStyle, type Tool, type ViewportHandle } from './ui/Viewport';

type PanelTab = 'object' | 'scene' | 'view' | 'export';
type SaveState = 'idle' | 'saving' | 'saved' | 'local' | 'error';

const VIEW_OPTIONS_KEY = 'plinth:view';

function loadViewOptions(): RenderOptions {
  try {
    const raw = window.localStorage.getItem(VIEW_OPTIONS_KEY);
    return raw ? { ...DEFAULT_RENDER_OPTIONS, ...JSON.parse(raw) } : DEFAULT_RENDER_OPTIONS;
  } catch {
    return DEFAULT_RENDER_OPTIONS;
  }
}

function sceneIdFromHash(): string | null {
  const match = window.location.hash.match(/scene=([\w-]+)/);
  return match ? match[1] : null;
}

const TOOLS: { tool: Tool; label: string; key: string; icon: string }[] = [
  { tool: 'select', label: 'Select', key: 'V', icon: 'select' },
  { tool: 'place', label: 'Place', key: 'B', icon: 'place' },
  { tool: 'erase', label: 'Erase', key: 'E', icon: 'erase' },
  { tool: 'pan', label: 'Pan', key: 'H', icon: 'pan' },
];

export function App() {
  const history = useHistory(newDocument());
  const document = history.document;
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('place');
  const [presetKey, setPresetKey] = useState(PRIMITIVE_PRESETS[0].key);
  const [placeRotation, setPlaceRotation] = useState<Rotation>(0);
  const [surface, setSurface] = useState<PlacementSurface>('stack');
  const [style, setStyle] = useState<PlacementStyle>('stamp');
  const [activeLevel, setActiveLevel] = useState(0);
  const [cutaway, setCutaway] = useState(false);
  const [viewOptions, setViewOptions] = useState<RenderOptions>(loadViewOptions);
  const [tab, setTab] = useState<PanelTab>('scene');
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1000);
  const [scenesOpen, setScenesOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const viewportRef = useRef<ViewportHandle>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1000);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 999px)');
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  // A 401 from any API call means the session lapsed. The server-rendered login
  // page is the primary sign-in, so a reload lands there directly.
  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true);
    window.addEventListener('plinth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('plinth:unauthorized', onUnauthorized);
  }, []);
  const loaded = useRef(false);
  const savedSnapshot = useRef<string>('');

  const preset = PRIMITIVE_PRESETS.find((candidate) => candidate.key === presetKey)!;
  const selected = document.objects.find((object) => object.id === selectionId) ?? null;

  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout((notify as unknown as { timer?: number }).timer);
    (notify as unknown as { timer?: number }).timer = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // ── Loading & saving ──────────────────────────────────────────────────────
  const openScene = useCallback(async (id: string) => {
    try {
      const { document: loadedDocument } = await sceneApi.get(id);
      const draft = loadDraft(id);
      savedSnapshot.current = JSON.stringify(loadedDocument);
      // A newer unsynced draft on this device wins over the server copy.
      history.reset(draft && draft.savedAt > Date.now() - 7 * 864e5 && JSON.stringify(draft.document) !== savedSnapshot.current
        ? draft.document
        : loadedDocument);
      setSceneId(id);
      setSaveState('saved');
    } catch {
      const draft = loadDraft(id);
      if (draft) { savedSnapshot.current = ''; history.reset(draft.document); setSceneId(id); setSaveState('local'); return; }
      throw new Error('not found');
    } finally {
      setSelectionId(null);
    }
  }, [history]);

  const createScene = useCallback(async (seed: SceneDocument) => {
    savedSnapshot.current = JSON.stringify(seed);
    history.reset(seed);
    setSelectionId(null);
    try {
      const { id } = await sceneApi.create(seed);
      setSceneId(id);
      setSaveState('saved');
    } catch {
      const id = `local-${makeObjectId()}`;
      setSceneId(id);
      saveDraft(id, seed);
      setSaveState('local');
    }
  }, [history]);

  useEffect(() => {
    const initial = sceneIdFromHash() ?? lastSceneId();
    (initial ? openScene(initial) : Promise.reject()).catch(() => createScene(newDocument()))
      .finally(() => { loaded.current = true; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sceneId) return;
    rememberLastScene(sceneId);
    if (!window.location.hash.includes(sceneId)) window.history.replaceState(null, '', `#scene=${sceneId}`);
  }, [sceneId]);

  // Autosave: draft immediately, server after a short pause. Skips when the
  // document matches what was last loaded or saved (opening a scene isn't an edit).
  useEffect(() => {
    if (!sceneId || !loaded.current) return;
    const serialised = JSON.stringify(document);
    if (serialised === savedSnapshot.current) return;
    saveDraft(sceneId, document);
    setSaveState('saving');
    const timer = window.setTimeout(async () => {
      if (sceneId.startsWith('local-')) { setSaveState('local'); return; }
      try {
        await sceneApi.save(sceneId, document);
        savedSnapshot.current = serialised;
        clearDraft(sceneId);
        setSaveState('saved');
      } catch {
        setSaveState('local');
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [document, sceneId]);

  useEffect(() => {
    try { window.localStorage.setItem(VIEW_OPTIONS_KEY, JSON.stringify({ ...viewOptions, hideAboveLevel: null })); } catch { /* ignore */ }
  }, [viewOptions]);

  // ── Edits ─────────────────────────────────────────────────────────────────
  const updateSelected = useCallback((patch: Partial<SceneObject>) => {
    if (!selectionId) return;
    history.commit((current) => ({
      ...current,
      objects: current.objects.map((object) => (object.id === selectionId ? { ...object, ...patch } : object)),
    }));
  }, [history, selectionId]);

  const deleteSelected = useCallback(() => {
    if (!selectionId) return;
    history.commit((current) => ({ ...current, objects: current.objects.filter((object) => object.id !== selectionId) }));
    setSelectionId(null);
  }, [history, selectionId]);

  const duplicateSelected = useCallback(() => {
    const source = history.current().objects.find((object) => object.id === selectionId);
    if (!source) return;
    const settings = history.current().settings;
    const copy: SceneObject = {
      ...source,
      id: makeObjectId(),
      x: Math.min(source.x + settings.snap, settings.floorTilesX - source.width),
    };
    history.commit((current) => ({ ...current, objects: [...current.objects, copy] }));
    setSelectionId(copy.id);
  }, [history, selectionId]);

  const rotateSelected = useCallback(() => {
    const source = history.current().objects.find((object) => object.id === selectionId);
    if (!source) return;
    const to = ((source.rotation + 1) % 4) as Rotation;
    const [width, depth] = rotatedFootprint(source.width, source.depth, source.rotation, to);
    updateSelected({ rotation: to, width, depth });
  }, [history, selectionId, updateSelected]);

  const updateSettings = useCallback((patch: Partial<SceneSettings>) => {
    history.commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  }, [history]);

  const nudgeSelected = useCallback((dx: number, dy: number, dz: number) => {
    if (!selected) return;
    const settings = document.settings;
    updateSelected({
      x: Math.min(Math.max(0, selected.x + dx * settings.snap), settings.floorTilesX - selected.width),
      y: Math.min(Math.max(0, selected.y + dy * settings.snap), settings.floorTilesY - selected.depth),
      z: Math.min(Math.max(0, selected.z + dz * settings.snap), settings.levelCount - selected.height),
    });
  }, [selected, document.settings, updateSelected]);

  const changeLevel = useCallback((delta: number) => {
    setActiveLevel((level) => Math.min(Math.max(0, level + delta), Math.max(0, document.settings.levelCount - 1)));
  }, [document.settings.levelCount]);

  useEffect(() => {
    if (activeLevel > document.settings.levelCount - 1) setActiveLevel(Math.max(0, document.settings.levelCount - 1));
  }, [activeLevel, document.settings.levelCount]);

  const selectTool = (next: Tool) => {
    setTool(next);
    if (next !== 'select') setSelectionId(null);
  };

  const choosePreset = (key: string) => {
    setPresetKey(key);
    setTool('place');
    setSelectionId(null);
  };

  const onSelect = useCallback((id: string | null) => {
    setSelectionId(id);
    if (id) setTab('object');
  }, []);

  // ── Keyboard (desktop, and iPad with a keyboard) ──────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, select, textarea')) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) history.redo(); else history.undo(); return; }
      if (mod && key === 'y') { event.preventDefault(); history.redo(); return; }
      if (mod && key === 'd') { event.preventDefault(); duplicateSelected(); return; }
      if (mod) return;
      if (event.key === ' ') { event.preventDefault(); setSpaceHeld(true); return; }
      if (key === 'v') selectTool('select');
      else if (key === 'b') selectTool('place');
      else if (key === 'e') selectTool('erase');
      else if (key === 'h') selectTool('pan');
      else if (key === 'r') { if (selected && tool === 'select') rotateSelected(); else setPlaceRotation((rotation) => ((rotation + 1) % 4) as Rotation); }
      else if (key === 'f') viewportRef.current?.fit();
      else if (key === 't') setSurface((current) => (current === 'stack' ? 'plane' : 'stack'));
      else if (key === 's') setStyle((current) => (current === 'stamp' ? 'stretch' : 'stamp'));
      else if (key === 'c') setCutaway((current) => !current);
      else if (event.key === ']' || event.key === 'PageUp') changeLevel(1);
      else if (event.key === '[' || event.key === 'PageDown') changeLevel(-1);
      else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
      else if (event.key === 'Escape') setSelectionId(null);
      else if (event.key.startsWith('Arrow') && selected) {
        event.preventDefault();
        if (event.shiftKey && event.key === 'ArrowUp') nudgeSelected(0, 0, 1);
        else if (event.shiftKey && event.key === 'ArrowDown') nudgeSelected(0, 0, -1);
        else if (event.key === 'ArrowRight') nudgeSelected(1, 0, 0);
        else if (event.key === 'ArrowLeft') nudgeSelected(-1, 0, 0);
        else if (event.key === 'ArrowDown') nudgeSelected(0, 1, 0);
        else if (event.key === 'ArrowUp') nudgeSelected(0, -1, 0);
      } else {
        const match = PRIMITIVE_PRESETS.find((candidate) => candidate.shortcut === event.key);
        if (match) choosePreset(match.key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ') setSpaceHeld(false); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  });

  // ── Derived render options ────────────────────────────────────────────────
  const renderOptions = useMemo<RenderOptions>(
    () => ({ ...viewOptions, hideAboveLevel: cutaway ? activeLevel : null }),
    [viewOptions, cutaway, activeLevel],
  );

  const exportSelected = async () => {
    if (!selected) return;
    const { blob, filename } = await exportPrimitivePng(document.settings, selected, { ...viewOptions, hideAboveLevel: null }, 1);
    await deliverFile(blob, filename, false);
    notify(`Saved ${filename}`);
  };

  const saveLabel: Record<SaveState, string> = {
    idle: '', saving: 'Saving…', saved: 'Saved', local: 'Saved on this device', error: 'Not saved',
  };

  return (
    <div className={`app ${panelOpen ? 'panel-open' : 'panel-closed'}`}>
      <header className="topbar">
        <div className="brand" aria-label="plinth">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l8 4-8 4-8-4z" fill="#e8e8e8" /><path d="M4 8v8l8 4v-8z" fill="#a0a0a0" /><path d="M20 8v8l-8 4v-8z" fill="#6a6a6a" /></svg>
          <span>plinth</span>
        </div>
        <button type="button" className="scene-name" onClick={() => setScenesOpen(true)} title="Scenes">
          <Icon name="folder" size={16} />
          <span>{document.name}</span>
        </button>
        <span className={`save-state save-${saveState}`}>{saveLabel[saveState]}</span>
        <div className="topbar-spacer" />
        <div className="button-group">
          <button type="button" className="icon-button" onClick={history.undo} disabled={!history.canUndo} aria-label="Undo" title="Undo (⌘Z)"><Icon name="undo" /></button>
          <button type="button" className="icon-button" onClick={history.redo} disabled={!history.canRedo} aria-label="Redo" title="Redo (⇧⌘Z)"><Icon name="redo" /></button>
        </div>
        <div className="button-group zoom-group">
          <button type="button" className="icon-button" onClick={() => viewportRef.current?.zoomBy(1 / 1.5)} aria-label="Zoom out"><Icon name="minus" /></button>
          <button type="button" className="icon-button" onClick={() => viewportRef.current?.fit()} aria-label="Fit" title="Fit (F)"><Icon name="fit" /></button>
          <button type="button" className="icon-button" onClick={() => viewportRef.current?.zoomBy(1.5)} aria-label="Zoom in"><Icon name="plus" /></button>
        </div>
        <button type="button" className={`icon-button ${panelOpen ? 'is-active' : ''}`} onClick={() => setPanelOpen((open) => !open)} aria-label="Toggle panel"><Icon name="panel" /></button>
      </header>

      <aside className="rail" aria-label="Tools">
        <div className="tool-grid">
          {TOOLS.map((entry) => (
            <button
              key={entry.tool}
              type="button"
              className={`tool ${tool === entry.tool ? 'is-active' : ''}`}
              onClick={() => selectTool(entry.tool)}
              title={`${entry.label} (${entry.key})`}
              aria-pressed={tool === entry.tool}
            >
              <Icon name={entry.icon} />
              <span>{entry.label}</span>
            </button>
          ))}
        </div>

        <div className="rail-section-label">Shapes</div>
        <div className="palette">
          {PRIMITIVE_PRESETS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`swatch ${tool === 'place' && presetKey === entry.key ? 'is-active' : ''}`}
              onClick={() => choosePreset(entry.key)}
              title={entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label}
              aria-pressed={tool === 'place' && presetKey === entry.key}
            >
              <img src={presetIcon(entry.key, DIRECTIONAL_TYPES.has(entry.type) ? placeRotation : 0)} alt="" />
              <span>{entry.label}</span>
            </button>
          ))}
        </div>

        <div className="rail-section-label">Placing</div>
        <button type="button" className="rail-button" onClick={() => setPlaceRotation((rotation) => ((rotation + 1) % 4) as Rotation)} title="Rotate (R)">
          <Icon name="rotate" size={18} />
          <span>Facing {['↘', '↙', '↖', '↗'][placeRotation]}</span>
        </button>
        <div className="rail-toggle" role="radiogroup" aria-label="Placement surface">
          <button type="button" role="radio" aria-checked={surface === 'stack'} className={surface === 'stack' ? 'is-active' : ''} onClick={() => setSurface('stack')} title="Stack on whatever you tap (T)">
            <Icon name="stack" size={18} /><span>Stack</span>
          </button>
          <button type="button" role="radio" aria-checked={surface === 'plane'} className={surface === 'plane' ? 'is-active' : ''} onClick={() => setSurface('plane')} title="Place on the active level's plane (T)">
            <Icon name="plane" size={18} /><span>Level</span>
          </button>
        </div>
        <div className="rail-toggle" role="radiogroup" aria-label="Drag behaviour">
          <button type="button" role="radio" aria-checked={style === 'stamp'} className={style === 'stamp' ? 'is-active' : ''} onClick={() => setStyle('stamp')} title="Drag paints one piece per cell (S)">
            <Icon name="stamp" size={18} /><span>Stamp</span>
          </button>
          <button type="button" role="radio" aria-checked={style === 'stretch'} className={style === 'stretch' ? 'is-active' : ''} onClick={() => setStyle('stretch')} title="Drag sizes one piece (S)">
            <Icon name="stretch" size={18} /><span>Stretch</span>
          </button>
        </div>
      </aside>

      <main className="stage">
        <Viewport
          handle={viewportRef}
          history={history}
          renderOptions={renderOptions}
          selectionId={selectionId}
          onSelect={onSelect}
          tool={tool}
          preset={preset}
          placeRotation={placeRotation}
          surface={surface}
          style={style}
          activeLevel={activeLevel}
          spaceHeld={spaceHeld}
          occludedRight={narrow && panelOpen ? Math.min(320, window.innerWidth - 156) + 16 : 0}
        />
        <div className="level-control" aria-label="Active level">
          <button type="button" className="icon-button" onClick={() => changeLevel(1)} disabled={activeLevel >= document.settings.levelCount - 1} aria-label="Level up" title="Level up (])"><Icon name="up" /></button>
          <div className="level-value"><small>Level</small><strong>{activeLevel}</strong></div>
          <button type="button" className="icon-button" onClick={() => changeLevel(-1)} disabled={activeLevel <= 0} aria-label="Level down" title="Level down ([)"><Icon name="down" /></button>
          <button
            type="button"
            className={`icon-button ${cutaway ? 'is-active' : ''}`}
            onClick={() => setCutaway((current) => !current)}
            aria-pressed={cutaway}
            aria-label="Hide levels above"
            title="Hide everything above the active level (C)"
          >
            <Icon name={cutaway ? 'eyeOff' : 'eye'} />
          </button>
        </div>
        {toast && <div className="toast" role="status">{toast}</div>}
      </main>

      <aside className="panel" aria-label="Inspector">
        <nav className="tabs" role="tablist">
          {(['object', 'scene', 'view', 'export'] as PanelTab[]).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? 'is-active' : ''} onClick={() => setTab(name)}>
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          ))}
          <button type="button" className="icon-button tabs-close" onClick={() => setPanelOpen(false)} aria-label="Close panel"><Icon name="close" size={18} /></button>
        </nav>
        <div className="panel-scroll">
          {tab === 'object' && (
            <ObjectPanel
              object={selected}
              settings={document.settings}
              onChange={updateSelected}
              onDelete={deleteSelected}
              onDuplicate={duplicateSelected}
              onExport={exportSelected}
            />
          )}
          {tab === 'scene' && (
            <ScenePanel
              document={document}
              onSettings={updateSettings}
              onRename={(name) => history.replace((current) => ({ ...current, name }))}
            />
          )}
          {tab === 'view' && <ViewPanel options={viewOptions} onChange={(patch) => setViewOptions((current) => ({ ...current, ...patch }))} />}
          {tab === 'export' && (
            <ExportPanel
              document={document}
              options={viewOptions}
              notify={notify}
              onImport={(imported) => createScene({ ...imported, name: `${imported.name}` })}
            />
          )}
        </div>
      </aside>

      {scenesOpen && (
        <ScenesDrawer
          currentId={sceneId}
          notify={notify}
          onClose={() => setScenesOpen(false)}
          onOpen={(id) => { setScenesOpen(false); openScene(id).catch(() => notify('Could not open that scene')); }}
          onNew={() => { setScenesOpen(false); createScene(newDocument()); }}
          onDuplicate={() => { setScenesOpen(false); createScene({ ...history.current(), name: `${history.current().name} copy` }); }}
        />
      )}

      {unauthorized && (
        <div className="auth-overlay" role="alertdialog" aria-modal="true" aria-label="Session expired">
          <div className="auth-card">
            <h2>Session expired</h2>
            <p>Reload to sign in again.</p>
            <button type="button" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      )}
    </div>
  );
}
