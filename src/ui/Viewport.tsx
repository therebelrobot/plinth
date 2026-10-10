import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { composeImage, type TilesetPlacement } from '../core/compose';
import { buildTilesetPlacements, type TilesetSpriteSet } from '../core/tileset';
import {
  isOccupiedBySame, objectAt, placementTarget, targetOnPlane, clampTarget,
  type PlacementSize, type PlacementSurface, type PlacementTarget,
} from '../core/placement';
import { DIRECTIONAL_TYPES, type PrimitivePreset } from '../core/primitives';
import { projectPoint, unprojectToPlane, type Projection } from '../core/projection';
import { renderScene, type RenderBuffers } from '../core/render';
import { makeObjectId, type RenderOptions, type Rotation, type SceneObject } from '../core/types';
import { loadTilesetSprites } from '../lib/tileset';
import type { History } from '../state/history';

export type Tool = 'select' | 'place' | 'erase' | 'pan';
export type PlacementStyle = 'stamp' | 'stretch';

export interface ViewportHandle {
  zoomBy: (factor: number) => void;
  fit: () => void;
  actualSize: () => void;
}

interface Props {
  history: History;
  renderOptions: RenderOptions;
  selectionId: string | null;
  onSelect: (id: string | null) => void;
  tool: Tool;
  preset: PrimitivePreset;
  placeRotation: Rotation;
  surface: PlacementSurface;
  style: PlacementStyle;
  activeLevel: number;
  spaceHeld: boolean;
  /** Pixels on the right covered by a floating panel; fit/centre ignore that strip. */
  occludedRight: number;
  handle: Ref<ViewportHandle>;
}

const ACCENT = '#ff7a3d';
const ACCENT_RGB = [255, 122, 61] as const;
const PLANE_COLOUR = 'rgba(120, 200, 255, 0.85)';

interface ViewState { zoom: number; panX: number; panY: number }

type Interaction =
  | { kind: 'none' }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; panX: number; panY: number }
  | { kind: 'pinch'; startDistance: number; startZoom: number; anchorSceneX: number; anchorSceneY: number }
  | { kind: 'stamp'; pointerId: number; planeZ: number; lastKey: string }
  | { kind: 'stretch'; pointerId: number; planeZ: number; start: PlacementTarget; end: PlacementTarget }
  | { kind: 'erase'; pointerId: number }
  | { kind: 'move'; pointerId: number; objectId: string; startWorldX: number; startWorldY: number; origin: SceneObject }
  | { kind: 'ignore'; pointerId: number }; // leftover finger after a pinch

function sizeFor(preset: PrimitivePreset, rotation: Rotation): PlacementSize {
  const swapped = rotation % 2 === 1;
  return { width: swapped ? preset.depth : preset.width, depth: swapped ? preset.width : preset.depth, height: preset.height };
}

/** Walls and arches follow the drag direction when stretched. */
function stretchRotation(preset: PrimitivePreset, rotation: Rotation, spanX: number, spanY: number): Rotation {
  if (!DIRECTIONAL_TYPES.has(preset.type) || preset.type === 'stairs' || preset.type === 'ramp') return rotation;
  if (spanX === spanY) return rotation;
  const runsAlongX = spanX > spanY;
  if (runsAlongX) return (rotation % 2 === 1 ? rotation : ((rotation + 1) % 4)) as Rotation;
  return (rotation % 2 === 0 ? rotation : ((rotation + 3) % 4)) as Rotation;
}

function stretchObject(preset: PrimitivePreset, rotation: Rotation, start: PlacementTarget, end: PlacementTarget): Omit<SceneObject, 'id'> {
  const base = sizeFor(preset, rotation);
  const x0 = Math.min(start.x, end.x), y0 = Math.min(start.y, end.y);
  const x1 = Math.max(start.x, end.x) + base.width, y1 = Math.max(start.y, end.y) + base.depth;
  const finalRotation = stretchRotation(preset, rotation, x1 - x0, y1 - y0);
  return {
    type: preset.type, x: x0, y: y0, z: start.z,
    width: x1 - x0, depth: y1 - y0, height: preset.height,
    rotation: finalRotation, parameter: preset.parameter,
  };
}

export function Viewport(props: Props) {
  const { history, renderOptions, selectionId, onSelect, tool, preset, placeRotation, surface, style, activeLevel, spaceHeld } = props;
  const document = history.document;
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [view, setViewState] = useState<ViewState>({ zoom: 2, panX: 0, panY: 0 });
  const viewRef = useRef(view);
  const setView = useCallback((next: ViewState) => { viewRef.current = next; setViewState(next); }, []);
  const [hover, setHover] = useState<PlacementTarget | null>(null);
  const [hoverObjectId, setHoverObjectId] = useState<string | null>(null);
  const [stretchPreview, setStretchPreview] = useState<Omit<SceneObject, 'id'> | null>(null);
  const [cursorReadout, setCursorReadout] = useState<string>('');
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const interaction = useRef<Interaction>({ kind: 'none' });

  // ── Render ────────────────────────────────────────────────────────────────
  const buffers = useMemo<RenderBuffers>(
    () => renderScene(document.settings, document.objects, renderOptions, document.combinatorics),
    [document.settings, document.objects, renderOptions, document.combinatorics],
  );
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  // ── Tileset sprites (Feature 10) ──────────────────────────────────────────
  // The decoded sprites live in IndexedDB keyed by the document's TilesetRef.id;
  // load them once per reference, then resolve every object's sprite placement.
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

  const selectedIndex = useMemo(() => document.objects.findIndex((object) => object.id === selectionId), [document.objects, selectionId]);

  useEffect(() => {
    const canvas = sceneCanvasRef.current;
    if (!canvas) return;
    canvas.width = buffers.width;
    canvas.height = buffers.height;
    const rgba = composeImage(buffers, renderOptions, document.settings, {
      highlightOwner: selectedIndex >= 0 ? selectedIndex : undefined,
      highlightColor: ACCENT_RGB,
      tileset: tilesetPlacements,
    });
    canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, buffers.width, buffers.height), 0, 0);
  }, [buffers, renderOptions, document.settings, selectedIndex, tilesetPlacements]);

  // ── View helpers ──────────────────────────────────────────────────────────
  const fit = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const margin = 32;
    const visibleWidth = Math.max(120, bounds.width - props.occludedRight);
    let zoom = Math.min((visibleWidth - margin * 2) / buffers.width, (bounds.height - margin * 2) / buffers.height);
    zoom = zoom >= 1 ? Math.floor(zoom) : Math.max(0.25, zoom);
    setView({ zoom, panX: (visibleWidth - buffers.width * zoom) / 2, panY: (bounds.height - buffers.height * zoom) / 2 });
  }, [buffers.width, buffers.height, setView, props.occludedRight]);

  const zoomAround = useCallback((factor: number, screenX: number, screenY: number) => {
    const current = viewRef.current;
    const zoom = Math.min(48, Math.max(0.25, current.zoom * factor));
    const sceneX = (screenX - current.panX) / current.zoom;
    const sceneY = (screenY - current.panY) / current.zoom;
    setView({ zoom, panX: screenX - sceneX * zoom, panY: screenY - sceneY * zoom });
  }, [setView]);

  useImperativeHandle(props.handle, () => ({
    zoomBy: (factor) => {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds) zoomAround(factor, bounds.width / 2, bounds.height / 2);
    },
    fit,
    actualSize: () => {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const zoom = 1;
      setView({ zoom, panX: Math.round((bounds.width - buffers.width) / 2), panY: Math.round((bounds.height - buffers.height) / 2) });
    },
  }), [fit, zoomAround, setView, buffers.width, buffers.height]);

  // Refit when the canvas dimensions change (tile size, floor size, levels).
  const dimensionKey = `${buffers.width}x${buffers.height}:${props.occludedRight}`;
  useEffect(() => { fit(); }, [dimensionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => drawOverlayRef.current());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const toScene = useCallback((clientX: number, clientY: number) => {
    const bounds = containerRef.current!.getBoundingClientRect();
    const current = viewRef.current;
    return {
      localX: clientX - bounds.left,
      localY: clientY - bounds.top,
      sceneX: (clientX - bounds.left - current.panX) / current.zoom,
      sceneY: (clientY - bounds.top - current.panY) / current.zoom,
    };
  }, []);

  // ── Wheel / trackpad / Safari gesture events ──────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = container.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAround(Math.exp(-event.deltaY * 0.01), event.clientX - bounds.left, event.clientY - bounds.top);
      } else {
        const current = viewRef.current;
        setView({ ...current, panX: current.panX - event.deltaX, panY: current.panY - event.deltaY });
      }
    };
    // Safari (macOS trackpad pinch, iPadOS) emits proprietary gesture events; we
    // handle pinch through pointer events, so just stop the page from zooming.
    let gestureStartZoom = 1;
    const onGestureStart = (event: Event) => { event.preventDefault(); gestureStartZoom = viewRef.current.zoom; };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (pointers.current.size >= 2) return; // touch pinch is handled by pointer events
      const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      const bounds = container.getBoundingClientRect();
      zoomAround((gestureStartZoom * gesture.scale) / viewRef.current.zoom, gesture.clientX - bounds.left, gesture.clientY - bounds.top);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('gesturestart', onGestureStart);
    container.addEventListener('gesturechange', onGestureChange);
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('gesturestart', onGestureStart);
      container.removeEventListener('gesturechange', onGestureChange);
    };
  }, [zoomAround, setView]);

  // ── Overlay ───────────────────────────────────────────────────────────────
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current, container = containerRef.current;
    if (!canvas || !container) return;
    const bounds = container.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const targetWidth = Math.round(bounds.width * ratio), targetHeight = Math.round(bounds.height * ratio);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const context = canvas.getContext('2d')!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const { zoom, panX, panY } = viewRef.current;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const projection = buffers.projection;
    const settings = document.settings;
    const point = (x: number, y: number, z: number): [number, number] => {
      const [sx, sy] = projectPoint(projection, x, y, z);
      return [panX + sx * zoom, panY + sy * zoom];
    };
    const line = (from: [number, number], to: [number, number]) => { context.moveTo(...from); context.lineTo(...to); };

    // Scene bounds hairline.
    context.strokeStyle = 'rgba(255,255,255,0.08)';
    context.lineWidth = 1;
    context.strokeRect(panX - 0.5, panY - 0.5, buffers.width * zoom + 1, buffers.height * zoom + 1);

    // Active level plane: always shown in plane mode, and above ground in stack mode.
    if (tool === 'place' && (surface === 'plane' || activeLevel > 0)) {
      context.beginPath();
      context.strokeStyle = PLANE_COLOUR;
      context.lineWidth = 1.25;
      context.setLineDash(surface === 'plane' ? [] : [4, 4]);
      const z = activeLevel;
      line(point(0, 0, z), point(settings.floorTilesX, 0, z));
      line(point(settings.floorTilesX, 0, z), point(settings.floorTilesX, settings.floorTilesY, z));
      line(point(settings.floorTilesX, settings.floorTilesY, z), point(0, settings.floorTilesY, z));
      line(point(0, settings.floorTilesY, z), point(0, 0, z));
      context.stroke();
      if (surface === 'plane' && projection.halfTile * zoom >= 6) {
        context.beginPath();
        context.strokeStyle = 'rgba(120, 200, 255, 0.22)';
        context.setLineDash([]);
        for (let x = 1; x < settings.floorTilesX; x++) line(point(x, 0, z), point(x, settings.floorTilesY, z));
        for (let y = 1; y < settings.floorTilesY; y++) line(point(0, y, z), point(settings.floorTilesX, y, z));
        context.stroke();
      }
      context.setLineDash([]);
    }

    const drawBox = (box: Pick<SceneObject, 'x' | 'y' | 'z' | 'width' | 'depth' | 'height'>, colour: string, fill: boolean, facing?: Rotation) => {
      const x0 = box.x, x1 = box.x + box.width, y0 = box.y, y1 = box.y + box.depth, z0 = box.z, z1 = box.z + box.height;
      if (fill) {
        context.beginPath();
        const outline = [point(x0, y0, z1), point(x1, y0, z1), point(x1, y0, z0), point(x1, y1, z0), point(x0, y1, z0), point(x0, y1, z1)];
        context.moveTo(...outline[0]);
        for (const corner of outline.slice(1)) context.lineTo(...corner);
        context.closePath();
        context.fillStyle = 'rgba(255, 122, 61, 0.16)';
        context.fill();
      }
      context.strokeStyle = colour;
      context.lineWidth = 1.5;
      context.beginPath();
      line(point(x0, y0, z1), point(x1, y0, z1)); line(point(x1, y0, z1), point(x1, y1, z1));
      line(point(x1, y1, z1), point(x0, y1, z1)); line(point(x0, y1, z1), point(x0, y0, z1));
      line(point(x1, y0, z0), point(x1, y0, z1)); line(point(x1, y1, z0), point(x1, y1, z1)); line(point(x0, y1, z0), point(x0, y1, z1));
      line(point(x1, y0, z0), point(x1, y1, z0)); line(point(x1, y1, z0), point(x0, y1, z0));
      context.stroke();
      context.setLineDash([3, 3]);
      context.globalAlpha = 0.45;
      context.beginPath();
      line(point(x0, y0, z0), point(x1, y0, z0)); line(point(x0, y0, z0), point(x0, y1, z0)); line(point(x0, y0, z0), point(x0, y0, z1));
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
      if (facing !== undefined) {
        // Arrow on the top face pointing the way the piece faces.
        const centreX = (x0 + x1) / 2, centreY = (y0 + y1) / 2;
        const [directionX, directionY] = [[1, 0], [0, 1], [-1, 0], [0, -1]][facing];
        const reachX = (box.width / 2) * 0.8, reachY = (box.depth / 2) * 0.8;
        const tipX = centreX + directionX * reachX, tipY = centreY + directionY * reachY;
        context.beginPath();
        line(point(centreX - directionX * reachX * 0.4, centreY - directionY * reachY * 0.4, z1), point(tipX, tipY, z1));
        const sideX = -directionY, sideY = directionX;
        const back = 0.35;
        line(point(tipX, tipY, z1), point(tipX - directionX * back + sideX * back * 0.6, tipY - directionY * back + sideY * back * 0.6, z1));
        line(point(tipX, tipY, z1), point(tipX - directionX * back - sideX * back * 0.6, tipY - directionY * back - sideY * back * 0.6, z1));
        context.lineWidth = 2;
        context.stroke();
      }
    };

    const selected = document.objects.find((object) => object.id === selectionId);
    if (selected && tool === 'select') drawBox(selected, 'rgba(255,122,61,0.9)', false, DIRECTIONAL_TYPES.has(selected.type) ? selected.rotation : undefined);

    if (tool === 'place') {
      if (stretchPreview) {
        drawBox(stretchPreview, ACCENT, true, DIRECTIONAL_TYPES.has(stretchPreview.type) ? stretchPreview.rotation : undefined);
      } else if (hover) {
        const size = sizeFor(preset, placeRotation);
        drawBox({ ...hover, ...size }, ACCENT, true, DIRECTIONAL_TYPES.has(preset.type) ? placeRotation : undefined);
      }
    }
    if (tool === 'erase' && hoverObjectId) {
      const object = document.objects.find((candidate) => candidate.id === hoverObjectId);
      if (object) drawBox(object, '#ff4d5e', false);
    }
  }, [buffers, document, tool, surface, activeLevel, hover, hoverObjectId, stretchPreview, preset, placeRotation, selectionId]);

  const drawOverlayRef = useRef(drawOverlay);
  drawOverlayRef.current = drawOverlay;
  useEffect(() => { drawOverlay(); }, [drawOverlay, view]);

  // ── Tool actions ──────────────────────────────────────────────────────────
  const currentSize = sizeFor(preset, placeRotation);

  const placeAt = useCallback((target: PlacementTarget) => {
    const size = sizeFor(preset, placeRotation);
    const candidate: Omit<SceneObject, 'id'> = {
      type: preset.type, ...target, ...size, rotation: placeRotation, parameter: preset.parameter,
    };
    history.replace((current) => (isOccupiedBySame(current.objects, candidate)
      ? current
      : { ...current, objects: [...current.objects, { id: makeObjectId(), ...candidate }] }));
  }, [preset, placeRotation, history]);

  const eraseAt = useCallback((sceneX: number, sceneY: number) => {
    const object = objectAt(buffersRef.current, sceneX, sceneY);
    if (!object) return;
    history.replace((current) => ({ ...current, objects: current.objects.filter((candidate) => candidate.id !== object.id) }));
    if (object.id === selectionId) onSelect(null);
  }, [history, selectionId, onSelect]);

  const targetKey = (target: PlacementTarget) => `${target.x},${target.y},${target.z}`;

  const finishStroke = useCallback(() => {
    const active = interaction.current;
    if (active.kind === 'stretch') {
      const object = stretchObject(preset, placeRotation, active.start, active.end);
      history.commit((current) => isOccupiedBySame(current.objects, object)
        ? current
        : { ...current, objects: [...current.objects, { id: makeObjectId(), ...object }] });
      setStretchPreview(null);
    } else if (active.kind === 'stamp' || active.kind === 'erase' || active.kind === 'move') {
      history.endStroke();
    }
    interaction.current = { kind: 'none' };
  }, [history, preset, placeRotation]);

  const abortStroke = useCallback(() => {
    const active = interaction.current;
    if (active.kind === 'stamp' || active.kind === 'erase' || active.kind === 'move') history.cancelStroke();
    setStretchPreview(null);
    interaction.current = { kind: 'none' };
  }, [history]);

  const startPinch = useCallback(() => {
    const [first, second] = [...pointers.current.values()];
    const bounds = containerRef.current!.getBoundingClientRect();
    const centreX = (first.x + second.x) / 2 - bounds.left, centreY = (first.y + second.y) / 2 - bounds.top;
    const current = viewRef.current;
    interaction.current = {
      kind: 'pinch',
      startDistance: Math.hypot(first.x - second.x, first.y - second.y) || 1,
      startZoom: current.zoom,
      anchorSceneX: (centreX - current.panX) / current.zoom,
      anchorSceneY: (centreY - current.panY) / current.zoom,
    };
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    const container = containerRef.current!;
    container.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });

    if (pointers.current.size === 2) {
      // Second finger: whatever the first finger started becomes a pinch instead.
      abortStroke();
      startPinch();
      return;
    }
    if (pointers.current.size > 2) return;

    const { sceneX, sceneY } = toScene(event.clientX, event.clientY);
    const wantsPan = tool === 'pan' || spaceHeld || event.button === 1 || event.button === 2;
    if (wantsPan) {
      const current = viewRef.current;
      interaction.current = { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: current.panX, panY: current.panY };
      return;
    }
    if (event.button !== 0) return;

    const settings = history.current().settings;
    if (tool === 'place') {
      const target = placementTarget(buffersRef.current, settings, sceneX, sceneY, surface, activeLevel, currentSize);
      if (!target) return;
      if (style === 'stretch') {
        interaction.current = { kind: 'stretch', pointerId: event.pointerId, planeZ: target.z, start: target, end: target };
        setStretchPreview(stretchObject(preset, placeRotation, target, target));
      } else {
        history.beginStroke();
        placeAt(target);
        interaction.current = { kind: 'stamp', pointerId: event.pointerId, planeZ: target.z, lastKey: targetKey(target) };
      }
      setHover(null);
    } else if (tool === 'erase') {
      history.beginStroke();
      eraseAt(sceneX, sceneY);
      interaction.current = { kind: 'erase', pointerId: event.pointerId };
    } else if (tool === 'select') {
      const object = objectAt(buffersRef.current, sceneX, sceneY);
      if (!object) {
        onSelect(null);
        const current = viewRef.current;
        interaction.current = { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: current.panX, panY: current.panY };
        return;
      }
      onSelect(object.id);
      const [worldX, worldY] = unprojectToPlane(buffersRef.current.projection, sceneX, sceneY, object.z);
      history.beginStroke();
      interaction.current = { kind: 'move', pointerId: event.pointerId, objectId: object.id, startWorldX: worldX, startWorldY: worldY, origin: object };
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const tracked = pointers.current.get(event.pointerId);
    if (tracked) { tracked.x = event.clientX; tracked.y = event.clientY; }
    const active = interaction.current;
    const { sceneX, sceneY, localX, localY } = toScene(event.clientX, event.clientY);
    const projection: Projection = buffersRef.current.projection;
    const settings = history.current().settings;

    // Readout of the floor cell under the pointer at the active level.
    const [worldX, worldY] = unprojectToPlane(projection, sceneX, sceneY, activeLevel);
    setCursorReadout(
      worldX >= 0 && worldY >= 0 && worldX < settings.floorTilesX && worldY < settings.floorTilesY
        ? `x ${Math.floor(worldX)} · y ${Math.floor(worldY)} · level ${activeLevel}`
        : '',
    );

    switch (active.kind) {
      case 'pinch': {
        if (pointers.current.size < 2) return;
        const [first, second] = [...pointers.current.values()];
        const bounds = containerRef.current!.getBoundingClientRect();
        const centreX = (first.x + second.x) / 2 - bounds.left, centreY = (first.y + second.y) / 2 - bounds.top;
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        const zoom = Math.min(48, Math.max(0.25, (active.startZoom * distance) / active.startDistance));
        setView({ zoom, panX: centreX - active.anchorSceneX * zoom, panY: centreY - active.anchorSceneY * zoom });
        return;
      }
      case 'pan':
        if (active.pointerId !== event.pointerId) return;
        setView({ ...viewRef.current, panX: active.panX + event.clientX - active.startX, panY: active.panY + event.clientY - active.startY });
        return;
      case 'stamp': {
        if (active.pointerId !== event.pointerId) return;
        const target = targetOnPlane(projection, settings, sceneX, sceneY, active.planeZ, currentSize);
        const key = targetKey(target);
        if (key !== active.lastKey) { active.lastKey = key; placeAt(target); }
        return;
      }
      case 'stretch': {
        if (active.pointerId !== event.pointerId) return;
        active.end = targetOnPlane(projection, settings, sceneX, sceneY, active.planeZ, currentSize);
        setStretchPreview(stretchObject(preset, placeRotation, active.start, active.end));
        return;
      }
      case 'erase':
        if (active.pointerId === event.pointerId) eraseAt(sceneX, sceneY);
        return;
      case 'move': {
        if (active.pointerId !== event.pointerId) return;
        const [currentX, currentY] = unprojectToPlane(projection, sceneX, sceneY, active.origin.z);
        const snap = settings.snap;
        const moved = clampTarget({
          x: active.origin.x + Math.round((currentX - active.startWorldX) / snap) * snap,
          y: active.origin.y + Math.round((currentY - active.startWorldY) / snap) * snap,
          z: active.origin.z,
        }, active.origin, settings);
        history.replace((current) => ({
          ...current,
          objects: current.objects.map((object) => (object.id === active.objectId ? { ...object, x: moved.x, y: moved.y } : object)),
        }));
        return;
      }
      case 'ignore':
        return;
      case 'none':
        // Hover feedback (mouse and Pencil hover only — fingers don't hover).
        if (event.pointerType === 'touch') return;
        if (tool === 'place') {
          setHover(placementTarget(buffersRef.current, settings, sceneX, sceneY, surface, activeLevel, currentSize));
        } else if (tool === 'erase') {
          setHoverObjectId(objectAt(buffersRef.current, sceneX, sceneY)?.id ?? null);
        }
        void localX; void localY;
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    const active = interaction.current;
    if (active.kind === 'pinch') {
      // Keep ignoring the remaining finger until it lifts, so it can't place anything.
      const remaining = [...pointers.current.keys()][0];
      interaction.current = remaining !== undefined ? { kind: 'ignore', pointerId: remaining } : { kind: 'none' };
      return;
    }
    if ('pointerId' in active && active.pointerId !== event.pointerId) return;
    if (active.kind === 'pan' || active.kind === 'ignore') { interaction.current = { kind: 'none' }; return; }
    finishStroke();
  };

  const onPointerCancel = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    abortStroke();
  };

  const onPointerLeave = (event: React.PointerEvent) => {
    if (event.pointerType !== 'touch' && interaction.current.kind === 'none') {
      setHover(null);
      setHoverObjectId(null);
      setCursorReadout('');
    }
  };

  // Clear stale hover ghosts when the tool or preset changes.
  useEffect(() => { setHover(null); setHoverObjectId(null); }, [tool, preset, placeRotation, surface, activeLevel]);

  const cursor = tool === 'pan' || spaceHeld ? 'grab' : tool === 'place' ? 'crosshair' : tool === 'erase' ? 'not-allowed' : 'default';

  return (
    <div
      ref={containerRef}
      className="viewport"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={(event) => event.preventDefault()}
      data-testid="viewport"
    >
      <canvas
        ref={sceneCanvasRef}
        className="scene-canvas"
        style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }}
      />
      <canvas ref={overlayRef} className="overlay-canvas" />
      <div className="viewport-readout" aria-live="off">
        <span>{buffers.width}×{buffers.height}px</span>
        <span>{Math.round(view.zoom * 100)}%</span>
        {cursorReadout && <span>{cursorReadout}</span>}
      </div>
    </div>
  );
}
