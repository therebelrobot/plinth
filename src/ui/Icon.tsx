// Small stroke icon set (24×24, currentColor).
const PATHS: Record<string, string> = {
  select: 'M5 3l13 7-6 1.5L9.5 18z',
  place: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  erase: 'M16 4l5 5-10 10H6l-3-3zM9 9l6 6M11 19h10',
  pan: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3',
  rotate: 'M20 12a8 8 0 11-2.4-5.7M20 4v5h-5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.1 3.9M6.6 6.6C3.7 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2',
  panel: 'M3 4h18v16H3zM15 4v16',
  folder: 'M3 6h6l2 2h10v11H3z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M12 15V3M8 7l4-4 4 4M5 12v8h14v-8',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  close: 'M6 6l12 12M18 6L6 18',
  stack: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  plane: 'M12 6l9 5-9 5-9-5z',
  stamp: 'M5 5h4v4H5zM10 10h4v4h-4zM15 15h4v4h-4z',
  stretch: 'M4 4h16v16H4zM4 4l16 16',
  nudgeNW: 'M17 17L7 7M7 15V7h8',
  nudgeNE: 'M7 17L17 7M9 7h8v8',
  nudgeSW: 'M17 7L7 17M7 9v8h8',
  nudgeSE: 'M7 7l10 10M17 9v8H9',
};

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
