// Undo/redo over whole documents. Documents are small (a few hundred objects),
// so snapshotting is simpler and safer than diffing.
//
// Strokes: a drag (paint a row of blocks, move a piece) changes the document
// many times but should undo as one step. beginStroke() remembers the starting
// document; live updates go through `replace` without touching history;
// endStroke() records one entry. cancelStroke() restores the start — used when
// a one-finger touch turns out to be the first finger of a pinch.
//
// The ref is the source of truth and React state just mirrors it, so pointer
// handlers firing several times between renders always see the latest document.

import { useCallback, useRef, useState } from 'react';
import type { SceneDocument } from '../core/types';

const LIMIT = 200;

interface State { document: SceneDocument; past: SceneDocument[]; future: SceneDocument[] }
type Next = SceneDocument | ((current: SceneDocument) => SceneDocument);

export interface History {
  document: SceneDocument;
  /** Latest document, readable synchronously from event handlers. */
  current: () => SceneDocument;
  commit: (next: Next) => void;
  replace: (next: Next) => void;
  reset: (next: SceneDocument) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  beginStroke: () => void;
  endStroke: () => void;
  cancelStroke: () => void;
}

export function useHistory(initial: SceneDocument): History {
  const store = useRef<State>({ document: initial, past: [], future: [] });
  const strokeStart = useRef<SceneDocument | null>(null);
  const [state, setState] = useState<State>(store.current);

  const set = useCallback((next: State) => {
    store.current = next;
    setState(next);
  }, []);

  const resolve = (next: Next): SceneDocument => (typeof next === 'function' ? next(store.current.document) : next);

  const commit = useCallback((next: Next) => {
    const previous = store.current;
    const document = resolve(next);
    if (document === previous.document) return;
    set({ document, past: [...previous.past, previous.document].slice(-LIMIT), future: [] });
  }, [set]);

  const replace = useCallback((next: Next) => {
    set({ ...store.current, document: resolve(next) });
  }, [set]);

  const reset = useCallback((document: SceneDocument) => {
    strokeStart.current = null;
    set({ document, past: [], future: [] });
  }, [set]);

  const undo = useCallback(() => {
    const previous = store.current;
    if (!previous.past.length) return;
    set({
      document: previous.past[previous.past.length - 1],
      past: previous.past.slice(0, -1),
      future: [previous.document, ...previous.future],
    });
  }, [set]);

  const redo = useCallback(() => {
    const previous = store.current;
    if (!previous.future.length) return;
    const [document, ...future] = previous.future;
    set({ document, past: [...previous.past, previous.document], future });
  }, [set]);

  const beginStroke = useCallback(() => { strokeStart.current = store.current.document; }, []);

  const endStroke = useCallback(() => {
    const start = strokeStart.current;
    strokeStart.current = null;
    const previous = store.current;
    if (!start || start === previous.document) return;
    set({ document: previous.document, past: [...previous.past, start].slice(-LIMIT), future: [] });
  }, [set]);

  const cancelStroke = useCallback(() => {
    const start = strokeStart.current;
    strokeStart.current = null;
    if (start) set({ ...store.current, document: start });
  }, [set]);

  const current = useCallback(() => store.current.document, []);

  return {
    document: state.document,
    current,
    commit, replace, reset, undo, redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    beginStroke, endStroke, cancelStroke,
  };
}
