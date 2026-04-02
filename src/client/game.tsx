// ═══════════════════════════════════════════════════════════════════
//  Schema Crisis — Production Flow Engine
//
//  Architecture:
//    ┌──────────┐  pointer events   ┌────────────┐  setRenderTick   ┌──────────┐
//    │  Grid    │ ─────────────────► │  drawRef   │ ───────────────► │  React   │
//    │  (DOM)   │  coordinate math   │  (mutable) │  (int bump)      │  render  │
//    └──────────┘                    └────────────┘                  └──────────┘
//
//    • All pointer events are bound to the grid CONTAINER — not individual cells.
//    • Coordinate math converts clientX/Y → grid (x,y) via getBoundingClientRect.
//    • drawRef holds the mutable grid state; mutated directly during drag.
//    • A single integer state (renderTick) is bumped to trigger React re-renders.
//    • CellView is React.memo'd with a 6-field custom comparator.
//    • Win validation runs on every pointerUp AND immediately on path-lock.
//
//  Flow Rules:
//    1. Paths start ONLY from endpoint nodes (coloured circles).
//    2. Movement is strictly 4-directional (no diagonals).
//    3. Backtrack: retracing to ANY cell in the active path truncates to it.
//    4. Sever: crossing another UNLOCKED path truncates the old path at the
//       intersection — cells beyond the cut are freed.
//    5. Block: cannot cross locked paths or another colour's endpoint nodes.
//    6. Lock: path locks when the active line reaches the matching endpoint.
//    7. Win: ALL colours locked AND every grid cell filled.
//
//  Mobile Perf:
//    • touch-action:none on grid prevents Reddit app scroll-jacking.
//    • setPointerCapture on the grid container for reliable finger tracking.
//    • Multi-cell straight-line jump fills intermediates for fast drags.
//    • Timer ticks at 100 ms (not rAF) to avoid layout thrash.
// ═══════════════════════════════════════════════════════════════════

import {
  useState, useEffect, useRef, useMemo, useCallback,
  memo, StrictMode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  generateDailyPuzzle, getDailySolution, computeScore, formatTime, getTodayDateStr,
  MAX_SCORE, COLOR_PALETTE, PENALTY_PER_HINT,
} from '../shared/puzzle';
import type {
  DailyPuzzle, DifficultyMode, PuzzleNode, LeaderboardEntry, WallsResponse,
  InitResponse, ScoreSubmitRequest, ScoreSubmitResponse,
  ShareRequest, ShareResponse,
} from '../shared/api';

// ═════════════════════════════════════════════════════════════════
//  § Types
// ═════════════════════════════════════════════════════════════════

type Phase     = 'select' | 'loading' | 'puzzle' | 'complete' | 'error';
type ResultTab = 'score' | 'fame' | 'shame';

interface Coord { x: number; y: number }

/** Serialisable snapshot for the undo stack. */
interface Snapshot {
  grid:   number[][];            // grid[y][x] = colorId | -1
  paths:  [number, Coord[]][];   // Map entries
  locked: number[];              // locked color IDs
}

/**
 * Mutable draw state — lives in a useRef.
 * Mutated directly during pointer-drag, NEVER triggers React re-renders.
 * React re-renders are triggered by bumping a separate `renderTick` state.
 */
interface DrawRef {
  isDown:          boolean;
  pointerId:       number;
  activeId:        number | null;   // colour being drawn
  lastCell:        Coord | null;    // dedup cell entry
  grid:            number[][];      // grid[y][x] = colorId | -1
  paths:           Map<number, Coord[]>;
  locked:          Set<number>;
  snapBeforeDrag:  Snapshot | null; // taken at pointerDown, pushed on pointerUp
  didChange:       boolean;         // true if anything changed during this drag
}

interface CellViewProps {
  colorId:       number;            // -1 = empty, 0-9 = path colour
  node:          PuzzleNode | null; // non-null = fixed endpoint
  isLocked:      boolean;
  isActive:      boolean;           // in the actively-drawn path (not locked)
  isHead:        boolean;           // leading cell of the active draw
  isHint:        boolean;           // part of the currently-revealed hint path
  isUnstarted:   boolean;           // endpoint not yet reached — pulses to invite touch
  isTapSelected: boolean;           // this color is tap-selected (tap-trace mode)
  isValidMove:   boolean;           // valid next-step for tap-trace mode
  cellPx:        number;
}

// ═════════════════════════════════════════════════════════════════
//  § Constants
// ═════════════════════════════════════════════════════════════════

const FONT     = "'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const MONO     = "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace";
const ORBITRON = "'Orbitron', " + FONT;
const BG       = 'linear-gradient(165deg, #050810 0%, #080d1e 40%, #06091a 70%, #040710 100%)';
const GAP      = 2;    // px between grid cells (thin circuit-board lines)
const GRID_PAD = 10;   // px padding inside the grid container

// ═════════════════════════════════════════════════════════════════
//  § HTTP Helper
// ═════════════════════════════════════════════════════════════════

async function apiFetch<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ═════════════════════════════════════════════════════════════════
//  § Audio (Web Audio API — zero external dependencies)
// ═════════════════════════════════════════════════════════════════

let _actx: AudioContext | null = null;
function actx(): AudioContext | null {
  try {
    if (!_actx) _actx = new (window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)();
    return _actx;
  } catch { return null; }
}
function tone(freq: number, type: OscillatorType, dur: number, vol = 0.18, delay = 0) {
  const ctx = actx(); if (!ctx) return;
  try {
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime + delay);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(ctx.destination);
    o.start(ctx.currentTime + delay);
    o.stop(ctx.currentTime + delay + dur);
  } catch { /* ignore — audio is non-critical */ }
}
const vibrate = (ms: number | number[]) => { try { navigator?.vibrate?.(ms); } catch {} };
const sfx = {
  start:    () => { tone(523, 'sine', 0.06, 0.12); tone(659, 'sine', 0.06, 0.12, 0.07); vibrate(10); },
  tick:     () => { tone(1200, 'sine', 0.02, 0.04); },
  lock:     () => { tone(784, 'sine', 0.12, 0.20); tone(1047, 'sine', 0.18, 0.20, 0.12); vibrate([15, 30, 15]); },
  sever:    () => { tone(260, 'sawtooth', 0.06, 0.08); vibrate(8); },
  undo:     () => { tone(330, 'sawtooth', 0.10, 0.12); vibrate(12); },
  clear:    () => { tone(220, 'sawtooth', 0.15, 0.14); tone(180, 'sawtooth', 0.15, 0.12, 0.1); vibrate(20); },
  complete: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 'sine', 0.28, 0.22, i * 0.09)); vibrate([40, 25, 40, 25, 80]); },
};

// ═════════════════════════════════════════════════════════════════
//  § Grid Utility Functions
// ═════════════════════════════════════════════════════════════════

function takeSnapshot(r: DrawRef): Snapshot {
  return {
    grid:   r.grid.map(row => [...row]),
    paths:  [...r.paths.entries()].map(([id, cells]) => [id, cells.map(c => ({ ...c }))]),
    locked: [...r.locked],
  };
}
function applySnapshot(r: DrawRef, s: Snapshot): void {
  r.grid   = s.grid.map(row => [...row]);
  r.paths  = new Map(s.paths.map(([id, cells]) => [id, cells.map(c => ({ ...c }))]));
  r.locked = new Set(s.locked);
}

/** Remove every cell belonging to a colour's path from the grid. */
function clearColorPath(r: DrawRef, colorId: number): void {
  const path = r.paths.get(colorId);
  if (path) for (const c of path) r.grid[c.y]![c.x] = -1;
  r.paths.delete(colorId);
  r.locked.delete(colorId);
}

function isGridFull(grid: number[][], size: number): boolean {
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (grid[y]![x]! < 0) return false;
  return true;
}

/** Convert viewport coordinates → grid cell, or null if outside the grid.
 *  Includes snap tolerance: fingers in gaps or slightly outside snap to nearest cell. */
function pointerToCell(
  clientX: number, clientY: number,
  gridEl: HTMLDivElement, cellPx: number, gridSize: number,
): Coord | null {
  const rect = gridEl.getBoundingClientRect();
  const step = cellPx + GAP;
  const rx   = clientX - rect.left - GRID_PAD;
  const ry   = clientY - rect.top  - GRID_PAD;
  // Snap: round to nearest cell center instead of strict floor.
  // This makes gap zones and near-edge touches resolve to the closest cell.
  let x = Math.floor((rx + cellPx * 0.1) / step);
  let y = Math.floor((ry + cellPx * 0.1) / step);
  // Allow slight overshoot at edges (up to half a cell beyond the grid boundary)
  const tol = cellPx * 0.4;
  if (x < 0 && rx > -tol) x = 0;
  if (y < 0 && ry > -tol) y = 0;
  if (x >= gridSize && rx < gridSize * step + tol) x = gridSize - 1;
  if (y >= gridSize && ry < gridSize * step + tol) y = gridSize - 1;
  if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) return null;
  return { x, y };
}

function computeCellPx(gridSize: number): number {
  const w = typeof window !== 'undefined' ? window.innerWidth  : 360;
  const h = typeof window !== 'undefined' ? window.innerHeight : 640;
  // Use near-full width; subtract ~180px for HUD + controls so the grid fits vertically too
  // On mobile (narrow screens) be more generous with width usage
  const isMobile = w < 500;
  const widthFrac = isMobile ? 0.98 : 0.95;
  const vPad = isMobile ? 170 : 210;
  const maxDim = Math.min(Math.floor(w * widthFrac), h - vPad);
  // Minimum 42px cells on mobile for comfortable touch targets (was 32)
  return Math.max(isMobile ? 42 : 36, Math.floor((maxDim - GRID_PAD * 2 - (gridSize - 1) * GAP) / gridSize));
}

// ═════════════════════════════════════════════════════════════════
//  § CellView — React.memo with custom comparator
// ═════════════════════════════════════════════════════════════════

const CellView = memo(function CellView({
  colorId, node, isLocked, isActive, isHead, isHint, isUnstarted, isTapSelected, isValidMove, cellPx,
}: CellViewProps) {
  const hex = colorId >= 0 ? (COLOR_PALETTE[colorId]?.hex ?? null) : null;
  const nodeSize = Math.round(cellPx * 0.68);

  // ── Derive visual properties from state flags ──
  // Cell backgrounds are subtle — SVG connection lines carry the visual weight.
  let bg: string, border: string, shadow: string;
  if (isHint && !hex) {
    bg     = 'rgba(255,255,255,0.06)';
    border = '1px dashed rgba(255,255,255,0.25)';
    shadow = '0 0 6px rgba(255,255,255,0.12)';
  } else if (hex) {
    if (isLocked) {
      bg     = `${hex}30`;
      border = `1px solid ${hex}55`;
      shadow = `0 0 8px ${hex}22`;
    } else if (isHint) {
      bg     = `${hex}28`;
      border = `1.5px dashed ${hex}88`;
      shadow = `0 0 8px ${hex}55`;
    } else if (isActive) {
      bg     = `${hex}20`;
      border = `1px solid ${hex}44`;
      shadow = `0 0 4px ${hex}22`;
    } else {
      bg     = `${hex}14`;
      border = `1px solid ${hex}22`;
      shadow = 'none';
    }
  } else if (isValidMove) {
    bg     = 'rgba(68,255,238,0.06)';
    border = '1.5px solid rgba(68,255,238,0.18)';
    shadow = '0 0 6px rgba(68,255,238,0.12)';
  } else {
    bg     = 'rgba(255,255,255,0.015)';
    border = '1px solid rgba(255,255,255,0.03)';
    shadow = 'none';
  }

  return (
    <div style={{
      width: cellPx, height: cellPx,
      borderRadius: node ? cellPx * 0.35 : 6,
      background: bg, border, boxShadow: shadow,
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'background 100ms, box-shadow 100ms',
      animation: isValidMove ? 'validPulse 1.2s ease-in-out infinite' : undefined,
    }}>
      {/* Fixed endpoint node circle */}
      {node && (
        <>
          {/* Tap-selected ring — glowing halo when color is tap-selected */}
          {isTapSelected && (
            <div style={{
              position: 'absolute',
              width: nodeSize + 14, height: nodeSize + 14,
              borderRadius: '50%',
              border: `2.5px solid ${node.color}`,
              boxShadow: `0 0 18px ${node.color}cc, 0 0 6px ${node.color}88`,
              animation: 'tapRing 0.8s ease-in-out infinite',
              zIndex: 3,
              pointerEvents: 'none',
            }} />
          )}
          <div style={{
            width: nodeSize, height: nodeSize, borderRadius: '50%',
            background: `radial-gradient(circle at 35% 35%, ${node.color}ff, ${node.color}cc)`,
            boxShadow: `0 0 ${isHead ? 24 : 14}px ${node.color}${isHead ? 'ee' : 'aa'}, inset 0 0 6px rgba(255,255,255,0.25), 0 2px 8px rgba(0,0,0,0.3)`,
            animation: isHead
              ? 'headPulse 0.6s ease-in-out infinite'
              : isUnstarted
                ? 'idlePulse 2.2s ease-in-out infinite'
                : undefined,
            zIndex: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              fontSize: Math.max(8, nodeSize * 0.38), fontWeight: 900,
              color: 'rgba(255,255,255,0.85)', textShadow: '0 1px 2px rgba(0,0,0,0.4)',
              lineHeight: 1, userSelect: 'none', pointerEvents: 'none',
            }}>
              {node.colorName.charAt(0)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}, (a, b) =>
  a.colorId       === b.colorId       &&
  a.isLocked      === b.isLocked      &&
  a.isActive      === b.isActive      &&
  a.isHead        === b.isHead        &&
  a.isHint        === b.isHint        &&
  a.isUnstarted   === b.isUnstarted   &&
  a.isTapSelected === b.isTapSelected &&
  a.isValidMove   === b.isValidMove   &&
  a.cellPx        === b.cellPx        &&
  a.node          === b.node
);

// ═════════════════════════════════════════════════════════════════
//  § Leaderboard Row
// ═════════════════════════════════════════════════════════════════

const LBRow = ({ entry, highlight }: { entry: LeaderboardEntry; highlight?: boolean }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '7px 12px', borderRadius: '8px',
    background: highlight ? 'rgba(68,255,238,0.07)' : 'rgba(255,255,255,0.025)',
    border: `1px solid ${highlight ? 'rgba(68,255,238,0.2)' : 'rgba(255,255,255,0.05)'}`,
    marginBottom: '4px',
  }}>
    <span style={{
      fontSize: '11px', fontWeight: 700, minWidth: '22px', textAlign: 'right',
      color: entry.rank === 1 ? '#FFE044' : entry.rank === 2 ? '#c0c0c0' : entry.rank === 3 ? '#cd7f32' : '#4b5079',
    }}>#{entry.rank}</span>
    <span style={{ flex: 1, fontSize: '12px', color: '#d0d8f0', fontWeight: 600,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {entry.username}
    </span>
    <span style={{ fontSize: '11px', color: '#44ffee', fontWeight: 700 }}>
      {entry.score.toLocaleString()}
    </span>
    <span style={{ fontSize: '10px', color: '#4b5079' }}>
      {formatTime(entry.timeMs)}
    </span>
    {entry.undoCount > 0 && (
      <span style={{ fontSize: '9px', color: '#FF4444', fontWeight: 700 }}>
        ↩{entry.undoCount}
      </span>
    )}
  </div>
);

// ═════════════════════════════════════════════════════════════════
//  § Stat Helper
// ═════════════════════════════════════════════════════════════════

const Stat = ({ label, value, color, large }: {
  label: string; value: string; color: string; large?: boolean;
}) => (
  <div style={{ textAlign: 'center' }}>
    <div style={{ fontSize: '8px', color: '#3a3f5c', letterSpacing: '3px' }}>{label}</div>
    <div style={{
      fontSize: large ? '24px' : '16px', fontWeight: 800, color,
      filter: `drop-shadow(0 0 8px ${color}66)`,
    }}>{value}</div>
  </div>
);

// ═════════════════════════════════════════════════════════════════
//  § PuzzleView — The Core Flow Engine
//
//  Container-level events:  onPointerDown / onPointerMove / onPointerUp
//  are bound to the outer grid <div>, NOT to individual cells.
//  Coordinate math (getBoundingClientRect + division) maps clientX/Y
//  to the grid cell.  setPointerCapture ensures no events are lost
//  when the finger moves fast on mobile.
// ═════════════════════════════════════════════════════════════════

interface PuzzleViewProps {
  puzzle:     DailyPuzzle;
  elapsedMs:  number;
  onComplete: (undoCount: number, hintCount: number) => void;
}

const PuzzleView = ({ puzzle, elapsedMs, onComplete }: PuzzleViewProps) => {
  const { gridSize, numColors, nodes } = puzzle;

  // ── React state (minimal — only render triggers) ─────────────
  const [renderTick, setRenderTick] = useState(0);
  const [undoCount,  setUndoCount]  = useState(0);
  const [hintCount,  setHintCount]  = useState(0);
  const [cellPx,     setCellPx]     = useState(() => computeCellPx(gridSize));
  // Hint: which colorId is currently being highlighted (-1 = none)
  const [hintColorId, setHintColorId] = useState(-1);
  const hintTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tap-trace mode: user tapped a node without dragging — stores the selected colorId
  const [tapSelectedId, setTapSelectedId] = useState<number | null>(null);
  // Lock celebration flash — stores hex color of last locked path
  const [lockFlash, setLockFlash] = useState<string | null>(null);
  // Tutorial overlay: shown on first play in this session
  const [showTutorial, setShowTutorial] = useState(() => {
    try { return !sessionStorage.getItem('sc_played'); } catch { return true; }
  });
  const dismissTutorial = useCallback(() => {
    setShowTutorial(false);
    try { sessionStorage.setItem('sc_played', '1'); } catch {}
  }, []);

  // Precompute full solution paths (same deterministic seed as server)
  const solutionPaths = useMemo(
    () => getDailySolution(puzzle.date, puzzle.mode),
    [puzzle.date],
  );

  // ── Refs ─────────────────────────────────────────────────────
  const gridElRef   = useRef<HTMLDivElement>(null);
  const undoStackRef = useRef<Snapshot[]>([]);
  const completedRef = useRef(false); // guard: fire onComplete only once

  const drawRef = useRef<DrawRef>({
    isDown: false, pointerId: -1, activeId: null, lastCell: null,
    grid: [], paths: new Map(), locked: new Set(),
    snapBeforeDrag: null, didChange: false,
  });

  // ── Precomputed lookups (stable across re-renders) ──────────
  const nodeMap = useMemo<Map<string, PuzzleNode>>(
    () => new Map(nodes.map(n => [`${n.x},${n.y}`, n])),
    [nodes],
  );
  const colorNodes = useMemo<Map<number, PuzzleNode[]>>(() => {
    const m = new Map<number, PuzzleNode[]>();
    for (const n of nodes) {
      const arr = m.get(n.id) ?? [];
      arr.push(n);
      m.set(n.id, arr);
    }
    return m;
  }, [nodes]);

  // ── Initialise empty grid when puzzle loads ──────────────────
  useEffect(() => {
    const r = drawRef.current;
    r.grid   = Array.from({ length: gridSize }, () => new Array<number>(gridSize).fill(-1));
    r.paths  = new Map();
    r.locked = new Set();
    r.isDown = false;
    r.activeId = null;
    completedRef.current = false;
    undoStackRef.current = [];
    setUndoCount(0);
    setHintCount(0);
    setHintColorId(-1);
    setRenderTick(t => t + 1);
  }, [gridSize, puzzle]);

  // Clear hint timer on unmount
  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
  }, []);

  // Auto-dismiss tutorial after 4 seconds
  useEffect(() => {
    if (!showTutorial) return;
    const t = setTimeout(dismissTutorial, 4000);
    return () => clearTimeout(t);
  }, [showTutorial, dismissTutorial]);

  // ── Responsive cell sizing ──────────────────────────────────
  useEffect(() => {
    const handle = () => setCellPx(computeCellPx(gridSize));
    window.addEventListener('resize', handle);
    return () => window.removeEventListener('resize', handle);
  }, [gridSize]);

  // ── Keyboard support: Arrow/WASD for desktop tap-trace ──────
  const tapSelRef = useRef(tapSelectedId);
  tapSelRef.current = tapSelectedId;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (completedRef.current) return;
      const activeId = tapSelRef.current;

      // Undo shortcut
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        const stack = undoStackRef.current;
        if (stack.length === 0) return;
        sfx.undo();
        applySnapshot(drawRef.current, stack.pop()!);
        setUndoCount(c => c + 1);
        setRenderTick(t => t + 1);
        return;
      }

      // Direction mapping
      let dx = 0, dy = 0;
      switch (e.key) {
        case 'ArrowUp':    case 'w': case 'W': dy = -1; break;
        case 'ArrowDown':  case 's': case 'S': dy = 1;  break;
        case 'ArrowLeft':  case 'a': case 'A': dx = -1; break;
        case 'ArrowRight': case 'd': case 'D': dx = 1;  break;
        case 'Escape':
          if (activeId !== null) { setTapSelectedId(null); setRenderTick(t => t + 1); }
          return;
        default: return;
      }
      e.preventDefault();
      if (activeId === null) return;

      const r = drawRef.current;
      const path = r.paths.get(activeId);
      if (!path || path.length === 0) return;

      const tail = path[path.length - 1]!;
      const target = { x: tail.x + dx, y: tail.y + dy };
      if (target.x < 0 || target.y < 0 || target.x >= gridSize || target.y >= gridSize) return;

      const snapBefore = takeSnapshot(r);
      r.activeId = activeId;
      const accepted = processCell(target);
      r.activeId = null;

      if (accepted) {
        undoStackRef.current.push(snapBefore);
        if (r.locked.has(activeId)) setTapSelectedId(null);
        if (r.locked.size >= numColors && isGridFull(r.grid, gridSize)) {
          completedRef.current = true;
          sfx.complete();
          setRenderTick(t => t + 1);
          setTimeout(() => onComplete(undoCount, hintCount), 50);
          return;
        }
      }
      setRenderTick(t => t + 1);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridSize, numColors]);

  // ── processCell: the atomic unit of the Flow Engine ─────────
  //
  // Called for each cell the pointer enters during a drag.
  // Mutates drawRef.current directly (zero React overhead).
  // Returns true if the cell was accepted, false if blocked.

  function processCell(target: Coord): boolean {
    const r  = drawRef.current;
    const id = r.activeId;
    if (id === null) return false;

    // If this colour is already locked, stop accepting cells.
    if (r.locked.has(id)) return false;

    const path = r.paths.get(id);
    if (!path || path.length === 0) return false;
    const tail = path[path.length - 1]!;

    // Adjacency check (strict 4-directional, no diagonals)
    if (Math.abs(target.x - tail.x) + Math.abs(target.y - tail.y) !== 1) return false;

    const existing = r.grid[target.y]![target.x]!;
    const nodeHere = nodeMap.get(`${target.x},${target.y}`);

    // ── BLOCK: Another colour's endpoint node ─────────────────
    if (nodeHere && nodeHere.id !== id) return false;

    // ── BLOCK: Locked path ────────────────────────────────────
    if (existing >= 0 && existing !== id && r.locked.has(existing)) return false;

    // ── BACKTRACK: Cell is already in the active path ─────────
    if (existing === id) {
      const idx = path.findIndex(c => c.x === target.x && c.y === target.y);
      if (idx >= 0) {
        // Truncate everything AFTER this cell
        const removed = path.splice(idx + 1);
        for (const c of removed) r.grid[c.y]![c.x] = -1;
        r.didChange = true;
        return true;
      }
    }

    // ── SEVER: Cell belongs to another UNLOCKED path ──────────
    if (existing >= 0 && existing !== id) {
      const otherPath = r.paths.get(existing);
      if (otherPath) {
        const cutIdx = otherPath.findIndex(c => c.x === target.x && c.y === target.y);
        if (cutIdx >= 0) {
          const removed = otherPath.splice(cutIdx);
          for (const c of removed) r.grid[c.y]![c.x] = -1;
          r.locked.delete(existing);
        }
      }
    }

    // ── SEVER feedback ─────────────────────────────────────────
    if (existing >= 0 && existing !== id) sfx.sever();

    // ── EXTEND: Claim cell and append to active path ──────────
    r.grid[target.y]![target.x] = id;
    path.push({ x: target.x, y: target.y });
    r.didChange = true;
    sfx.tick();

    // ── LOCK: Check if we reached the matching endpoint ───────
    if (nodeHere && nodeHere.id === id) {
      const pair = colorNodes.get(id);
      if (pair && pair.length === 2) {
        const start = path[0]!;
        const other = pair.find(n => !(n.x === start.x && n.y === start.y));
        if (other && target.x === other.x && target.y === other.y) {
          r.locked.add(id);
          sfx.lock();
          const hex = COLOR_PALETTE[id]?.hex ?? '#44ffee';
          setLockFlash(hex);
          setTimeout(() => setLockFlash(null), 700);
        }
      }
    }
    return true;
  }

  // ── Win check (runs after lock, and on pointerUp) ───────────
  function checkWin(): boolean {
    const r = drawRef.current;
    return r.locked.size >= numColors && isGridFull(r.grid, gridSize);
  }

  function triggerWin() {
    if (completedRef.current) return;
    completedRef.current = true;
    const r = drawRef.current;
    r.isDown = false;
    if (gridElRef.current && r.pointerId >= 0) {
      try { gridElRef.current.releasePointerCapture(r.pointerId); } catch { /* ok */ }
    }
    // Push the undo snapshot so the user could theoretically undo
    if (r.snapBeforeDrag && r.didChange) {
      undoStackRef.current.push(r.snapBeforeDrag);
      r.snapBeforeDrag = null;
    }
    sfx.complete();
    setRenderTick(t => t + 1);
    // Schedule onComplete to fire after the state flush
    setTimeout(() => onComplete(undoCount, hintCount), 50);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Pointer Event Handlers — bound to the GRID CONTAINER
  // ═══════════════════════════════════════════════════════════════

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (completedRef.current) return;
    dismissTutorial();
    e.preventDefault();

    const el = gridElRef.current;
    if (!el) return;

    const cell = pointerToCell(e.clientX, e.clientY, el, cellPx, gridSize);
    if (!cell) return;

    const nodeHere = nodeMap.get(`${cell.x},${cell.y}`);
    const r = drawRef.current;

    // ── TAP-TRACE MODE: a color is already selected, handle cell taps ──
    if (tapSelectedId !== null) {
      if (!nodeHere) {
        // Tap on a non-node cell — try to extend the selected path one step
        const path = r.paths.get(tapSelectedId);
        if (path && path.length > 0) {
          const tail = path[path.length - 1]!;
          if (Math.abs(cell.x - tail.x) + Math.abs(cell.y - tail.y) === 1) {
            const snapBefore = takeSnapshot(r);
            r.activeId = tapSelectedId;
            const accepted = processCell(cell);
            r.activeId = null;
            if (accepted) {
              undoStackRef.current.push(snapBefore);
              // Auto-exit tap mode when the path locks
              if (r.locked.has(tapSelectedId)) setTapSelectedId(null);
              if (checkWin()) { triggerWin(); return; }
            }
            setRenderTick(t => t + 1);
            return;
          }
        }
        // Non-adjacent or no path — deselect
        setTapSelectedId(null);
        setRenderTick(t => t + 1);
        return;
      }
      // Tap on any endpoint node — clear tap mode and fall through to normal drag start
      setTapSelectedId(null);
    }

    // ── NORMAL DRAG START: must begin on an endpoint node ────────────
    if (!nodeHere) return;

    // Capture the pointer so we don't lose events on fast mobile drags
    el.setPointerCapture(e.pointerId);

    // Snapshot for undo (captures state BEFORE this draw operation)
    r.snapBeforeDrag = takeSnapshot(r);
    r.didChange      = false;

    // Clear any existing path for this colour (locked or not)
    clearColorPath(r, nodeHere.id);

    // Start a fresh path from this node
    r.grid[cell.y]![cell.x] = nodeHere.id;
    r.paths.set(nodeHere.id, [{ x: cell.x, y: cell.y }]);
    r.locked.delete(nodeHere.id);
    r.didChange = true;

    // Set draw state
    r.isDown    = true;
    r.pointerId = e.pointerId;
    r.activeId  = nodeHere.id;
    r.lastCell  = cell;

    sfx.start();
    setRenderTick(t => t + 1);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const r = drawRef.current;
    if (!r.isDown || r.activeId === null) return;
    if (e.pointerId !== r.pointerId) return;
    if (completedRef.current) return;
    e.preventDefault();

    const el = gridElRef.current;
    if (!el) return;

    const cell = pointerToCell(e.clientX, e.clientY, el, cellPx, gridSize);
    if (!cell) return;

    // Dedup: already at this cell
    if (r.lastCell && cell.x === r.lastCell.x && cell.y === r.lastCell.y) return;

    const path = r.paths.get(r.activeId);
    if (!path || path.length === 0) return;
    const tail = path[path.length - 1]!;

    const dx   = cell.x - tail.x;
    const dy   = cell.y - tail.y;
    const dist = Math.abs(dx) + Math.abs(dy);

    if (dist === 0) return;

    if (dist === 1) {
      // ── Normal single-cell move ─────────────────────────────
      processCell(cell);
    } else if (dx === 0 || dy === 0) {
      // ── Multi-cell straight-line jump (fast mobile drag) ────
      // Fill every intermediate cell so the path doesn't skip.
      const sx = dx === 0 ? 0 : dx > 0 ? 1 : -1;
      const sy = dy === 0 ? 0 : dy > 0 ? 1 : -1;
      let cx = tail.x + sx;
      let cy = tail.y + sy;
      const limit = gridSize; // safety bound
      for (let i = 0; i < limit; i++) {
        if (!processCell({ x: cx, y: cy })) break;
        if (cx === cell.x && cy === cell.y) break;
        if (checkWin()) { triggerWin(); return; }
        cx += sx;
        cy += sy;
      }
    } else {
      // ── Diagonal drift (finger moves diagonally between cells) ──
      // Phones frequently produce diagonal pointer coordinates when
      // the user intends a straight drag.  Snap to the dominant axis
      // and take ONE step toward the target.  On the next event the
      // finger will still be near the target so we approach it
      // incrementally without the path ever teleporting.
      // Setting r.lastCell to the STEP (not the raw cell) ensures the
      // dedup check doesn't suppress the next pointer event.
      const goHoriz  = Math.abs(dx) >= Math.abs(dy);
      const stepCell = goHoriz
        ? { x: tail.x + (dx > 0 ? 1 : -1), y: tail.y }
        : { x: tail.x,                       y: tail.y + (dy > 0 ? 1 : -1) };
      if (processCell(stepCell)) {
        // Use the step cell for dedup so the next event re-evaluates
        r.lastCell = stepCell;
        if (checkWin()) { triggerWin(); return; }
        setRenderTick(t => t + 1);
      }
      return; // skip the r.lastCell = cell assignment below
    }

    r.lastCell = cell;

    // Immediate win check after the final processed cell
    if (checkWin()) { triggerWin(); return; }

    setRenderTick(t => t + 1);
  }

  function handlePointerUp(_e: React.PointerEvent<HTMLDivElement>) {
    const r = drawRef.current;
    if (!r.isDown) return;

    // Detect a "tap": user pressed a node but never moved to another cell
    const activePath = r.activeId !== null ? r.paths.get(r.activeId) : undefined;
    const wasTap     = activePath !== undefined && activePath.length === 1;
    const activeAtUp = r.activeId;

    r.isDown   = false;
    r.activeId = null;
    r.lastCell = null;

    if (gridElRef.current && r.pointerId >= 0) {
      try { gridElRef.current.releasePointerCapture(r.pointerId); } catch { /* ok */ }
    }

    // Push undo snapshot only if the state actually changed
    if (r.snapBeforeDrag && r.didChange) {
      undoStackRef.current.push(r.snapBeforeDrag);
    }
    r.snapBeforeDrag = null;
    r.didChange = false;

    // Win validation on every pointerUp
    if (checkWin()) { triggerWin(); return; }

    // Enter tap-trace mode when user tapped a node without dragging
    // (lets them tap adjacent cells one at a time to draw the path)
    if (wasTap && activeAtUp !== null) {
      setTapSelectedId(activeAtUp);
    }

    setRenderTick(t => t + 1);
  }

  // ── Undo / Clear ────────────────────────────────────────────
  function handleUndo() {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    sfx.undo();
    const snap = stack.pop()!;
    applySnapshot(drawRef.current, snap);
    setUndoCount(c => c + 1);
    setRenderTick(t => t + 1);
  }

  function handleClear() {
    const r = drawRef.current;
    // Only if there's something to clear
    let hasAnything = false;
    for (const row of r.grid) { if (row.some(v => v >= 0)) { hasAnything = true; break; } }
    if (!hasAnything) return;
    sfx.clear();
    // Snapshot for undo
    undoStackRef.current.push(takeSnapshot(r));
    // Wipe grid
    r.grid = Array.from({ length: gridSize }, () => new Array<number>(gridSize).fill(-1));
    r.paths = new Map();
    r.locked = new Set();
    setUndoCount(c => c + 1);
    setRenderTick(t => t + 1);
  }

  // ── Hint: reveal the next un-locked colour's solution path ───
  // Picks the first colour that isn't already locked and shows its
  // canonical solution cells for 2 seconds with a dashed highlight.
  // Costs PENALTY_PER_HINT pts and disqualifies from Wall of Fame.
  function handleHint() {
    if (completedRef.current) return;
    const r = drawRef.current;

    // Find the first unlocked colour that has a solution path
    let targetId = -1;
    for (let id = 0; id < numColors; id++) {
      if (!r.locked.has(id) && solutionPaths[id] && solutionPaths[id]!.length > 0) {
        targetId = id;
        break;
      }
    }
    if (targetId === -1) return;

    // Clear any existing hint timer
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);

    tone(440, 'sine', 0.08, 0.10);
    tone(554, 'sine', 0.08, 0.10, 0.09);

    setHintCount(c => c + 1);
    setHintColorId(targetId);

    // Auto-dismiss after 2 s
    hintTimerRef.current = setTimeout(() => {
      setHintColorId(-1);
    }, 2000);
  }

  // ── Render ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void renderTick; // read it so React knows to re-render when it bumps

  const r          = drawRef.current;
  const activePath = r.activeId !== null ? r.paths.get(r.activeId) ?? [] : [];
  const headCell   = r.isDown && activePath.length > 0 ? activePath[activePath.length - 1]! : null;
  const liveScore  = Math.max(0, MAX_SCORE - Math.floor(elapsedMs / 1_000) * 10 - undoCount * 200 - hintCount * PENALTY_PER_HINT);

  // Build hint cell set: the solution path for hintColorId
  const hintCells = useMemo(() => {
    if (hintColorId < 0) return new Set<string>();
    const path = solutionPaths[hintColorId] ?? [];
    return new Set(path.map(c => `${c.x},${c.y}`));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintColorId]);
  const lockedCount = r.locked.size;
  const progressPct = Math.round((lockedCount / numColors) * 100);

  // Valid-move cells for tap-trace mode — show where user can tap next
  const validMoves = useMemo(() => {
    if (tapSelectedId === null) return new Set<string>();
    const path = r.paths.get(tapSelectedId);
    if (!path || path.length === 0 || r.locked.has(tapSelectedId)) return new Set<string>();
    const tail = path[path.length - 1]!;
    const moves = new Set<string>();
    for (const d of [{x:0,y:-1},{x:1,y:0},{x:0,y:1},{x:-1,y:0}]) {
      const nx = tail.x + d.x, ny = tail.y + d.y;
      if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
      const ex = r.grid[ny]?.[nx] ?? -1;
      const nd = nodeMap.get(`${nx},${ny}`);
      if (nd && nd.id !== tapSelectedId) continue;
      if (ex >= 0 && ex !== tapSelectedId && r.locked.has(ex)) continue;
      moves.add(`${nx},${ny}`);
    }
    return moves;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapSelectedId, renderTick]);

  // Count filled cells for the secondary progress indicator
  let filledCells = 0;
  for (let y = 0; y < gridSize; y++)
    for (let x = 0; x < gridSize; x++)
      if ((r.grid[y]?.[x] ?? -1) >= 0) filledCells++;
  const totalCells = gridSize * gridSize;
  const cellPct    = Math.round((filledCells / totalCells) * 100);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      width: '100%', height: '100vh',
      background: BG, fontFamily: FONT,
      position: 'relative', overflow: 'hidden',
    }}>
      <style>{GLOBAL_STYLES}</style>
      <BgDecor />

      {/* ── HUD ── */}
      <div style={{
        width: '100%', maxWidth: `${cellPx * gridSize + GRID_PAD * 2 + (gridSize - 1) * GAP + 24}px`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px 6px',
      }}>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: '8px', color: '#44ffee', letterSpacing: '3px', fontFamily: ORBITRON, opacity: 0.6 }}>SCHEMA CRISIS</div>
          <div style={{
            fontSize: '18px', fontWeight: 800, color: '#44ffee', letterSpacing: '-0.5px',
            filter: 'drop-shadow(0 0 8px rgba(68,255,238,0.5))',
          }}>
            {formatTime(elapsedMs)}
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '8px', color: '#3a3f5c', letterSpacing: '3px' }}>SCORE</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#FFE044' }}>
            {liveScore.toLocaleString()}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '8px', color: '#3a3f5c', letterSpacing: '3px' }}>CELLS</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: '#BB44FF' }}>
            {filledCells}/{totalCells}
          </div>
        </div>
      </div>

      {/* Progress bars — pairs locked + cells filled */}
      <div style={{
        width: '100%', maxWidth: `${cellPx * gridSize + GRID_PAD * 2 + (gridSize - 1) * GAP + 24}px`,
        padding: '0 12px 6px', display: 'flex', flexDirection: 'column', gap: '3px',
      }}>
        {/* Pairs bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ flex: 1, height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.06)' }}>
            <div style={{
              height: '100%', borderRadius: '2px',
              width: `${progressPct}%`,
              background: 'linear-gradient(90deg, #4488ff, #44ffee)',
              transition: 'width 0.3s ease',
              boxShadow: '0 0 8px rgba(68,255,238,0.5)',
            }} />
          </div>
          <span style={{ fontSize: '8px', color: '#BB44FF', fontWeight: 700, minWidth: '28px', textAlign: 'right' }}>
            {lockedCount}/{numColors}
          </span>
        </div>
        {/* Cells bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ flex: 1, height: '2px', borderRadius: '2px', background: 'rgba(255,255,255,0.04)' }}>
            <div style={{
              height: '100%', borderRadius: '2px',
              width: `${cellPct}%`,
              background: 'linear-gradient(90deg, #BB44FF55, #4488ff88)',
              transition: 'width 0.2s ease',
            }} />
          </div>
          <span style={{ fontSize: '7px', color: '#4b5079', fontWeight: 600, minWidth: '28px', textAlign: 'right' }}>
            {filledCells}/{totalCells}
          </span>
        </div>
        {/* ── Color Legend Strip: pair progress indicators ── */}
        <div style={{ display: 'flex', gap: '5px', marginTop: '4px', justifyContent: 'center', flexWrap: 'wrap' }}>
          {Array.from({ length: numColors }, (_, id) => {
            const hex = COLOR_PALETTE[id]?.hex ?? '#fff';
            const isLk = r.locked.has(id);
            const hasPath = (r.paths.get(id)?.length ?? 0) > 1;
            const isSel = tapSelectedId === id;
            return (
              <div key={id} style={{
                width: 14, height: 14, borderRadius: '50%',
                background: isLk ? hex : hasPath ? `${hex}55` : `${hex}22`,
                border: `1.5px solid ${isSel ? '#fff' : isLk ? hex : `${hex}44`}`,
                boxShadow: isLk ? `0 0 6px ${hex}88` : isSel ? `0 0 6px ${hex}cc` : 'none',
                transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '7px', color: '#fff', fontWeight: 800,
              }}>
                {isLk ? '✓' : ''}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Grid Container: ALL pointer events bound HERE ── */}
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <Corner top left />
        <Corner top right />
        <Corner bottom left />
        <Corner bottom right />
      <div
        ref={gridElRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${gridSize}, ${cellPx}px)`,
          gridTemplateRows:    `repeat(${gridSize}, ${cellPx}px)`,
          gap: `${GAP}px`,
          padding: `${GRID_PAD}px`,
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '16px',
          border: '1.5px solid rgba(68,255,238,0.08)',
          boxShadow: '0 0 20px rgba(68,255,238,0.04), inset 0 0 30px rgba(68,255,238,0.02)',
          touchAction: 'none',        // ← prevents Reddit app scroll-jacking
          userSelect: 'none',
          WebkitUserSelect: 'none',
          cursor: 'crosshair',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: gridSize * gridSize }, (_, i) => {
          const x       = i % gridSize;
          const y       = Math.floor(i / gridSize);
          const colorId = r.grid[y]?.[x] ?? -1;
          const node    = nodeMap.get(`${x},${y}`) ?? null;
          const isLk    = colorId >= 0 && r.locked.has(colorId);
          const isAct   = r.isDown && !isLk && colorId >= 0 && colorId === r.activeId;
          const isHd    = headCell !== null && headCell.x === x && headCell.y === y;
          const isHt    = hintCells.has(`${x},${y}`);
          return (
            <CellView key={i}
              colorId={colorId} node={node}
              isLocked={isLk} isActive={isAct} isHead={isHd} isHint={isHt}
              isUnstarted={node !== null && colorId < 0}
              isTapSelected={node !== null && tapSelectedId === node.id}
              isValidMove={validMoves.has(`${x},${y}`)}
              cellPx={cellPx}
            />
          );
        })}

        {/* ── SVG Connection Lines — flow pipes between path cells ── */}
        {(() => {
          const step = cellPx + GAP;
          const svgW = GRID_PAD * 2 + gridSize * cellPx + (gridSize - 1) * GAP;
          const cc = (v: number) => GRID_PAD + v * step + cellPx / 2;
          const lineW = Math.max(6, cellPx * 0.38);
          const glowW = lineW + 10;
          const entries = [...r.paths.entries()];
          return (
            <svg
              style={{
                position: 'absolute', top: 0, left: 0,
                width: svgW, height: svgW,
                pointerEvents: 'none', zIndex: 1,
              }}
              viewBox={`0 0 ${svgW} ${svgW}`}
            >
              {/* Connection pipes for each path */}
              {entries.map(([cId, path]) => {
                if (path.length < 2) return null;
                const hex = COLOR_PALETTE[cId]?.hex ?? '#ffffff';
                const isLk = r.locked.has(cId);
                const isAct = r.isDown && cId === r.activeId;
                const pts = path.map(c => `${cc(c.x)},${cc(c.y)}`).join(' ');
                return (
                  <g key={cId}>
                    {/* Outer glow */}
                    <polyline points={pts} fill="none"
                      stroke={hex} strokeWidth={glowW}
                      strokeOpacity={isLk ? 0.18 : isAct ? 0.14 : 0.08}
                      strokeLinecap="round" strokeLinejoin="round" />
                    {/* Main pipe */}
                    <polyline points={pts} fill="none"
                      stroke={hex} strokeWidth={lineW}
                      strokeOpacity={isLk ? 0.82 : isAct ? 0.62 : 0.45}
                      strokeLinecap="round" strokeLinejoin="round" />
                    {/* Inner highlight for 3D pipe effect */}
                    <polyline points={pts} fill="none"
                      stroke="#ffffff" strokeWidth={lineW * 0.25}
                      strokeOpacity={isLk ? 0.14 : 0.06}
                      strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                );
              })}
              {/* Active draw-head cursor */}
              {headCell && r.activeId !== null && (() => {
                const hex = COLOR_PALETTE[r.activeId]?.hex ?? '#ffffff';
                const cx = cc(headCell.x);
                const cy = cc(headCell.y);
                return (
                  <>
                    <circle cx={cx} cy={cy} r={cellPx * 0.34}
                      fill={hex} fillOpacity={0.18}
                      stroke={hex} strokeWidth={2.5} strokeOpacity={0.6} />
                    <circle cx={cx} cy={cy} r={cellPx * 0.14}
                      fill={hex} fillOpacity={0.95}>
                      <animate attributeName="r"
                        values={`${cellPx * 0.14};${cellPx * 0.2};${cellPx * 0.14}`}
                        dur="0.7s" repeatCount="indefinite" />
                    </circle>
                  </>
                );
              })()}
            </svg>
          );
        })()}
      </div>
      </div>{/* end Corner wrapper */}

      {/* ── Controls ── */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button onClick={handleUndo} style={CTRL_BTN}>
          ↩ UNDO
          {undoCount > 0 && <span style={{ marginLeft: '4px', color: '#FF4444', fontWeight: 800 }}>−200</span>}
        </button>
        <button onClick={handleClear} style={{ ...CTRL_BTN, borderColor: 'rgba(255,68,68,0.3)', color: '#FF8888' }}>
          ✕ CLEAR
        </button>
        <button onClick={handleHint} style={{ ...CTRL_BTN, borderColor: 'rgba(255,224,68,0.3)', color: '#FFE044' }}>
          💡 HINT
          <span style={{ marginLeft: '4px', color: '#FF8844', fontWeight: 800 }}>−{PENALTY_PER_HINT}</span>
        </button>
      </div>
      {(undoCount > 0 || hintCount > 0) && (
        <p style={{ fontSize: '9px', color: '#FF8844', marginTop: '5px', letterSpacing: '1px' }}>
          {undoCount > 0 && `↩ ${undoCount} undo${undoCount > 1 ? 's' : ''} · −${undoCount * 200} pts`}
          {undoCount > 0 && hintCount > 0 && ' · '}
          {hintCount > 0 && `💡 ${hintCount} hint${hintCount > 1 ? 's' : ''} · −${hintCount * PENALTY_PER_HINT} pts`}
          {' · not eligible for Wall of Fame'}
        </p>
      )}

      {/* Bottom instruction bar */}
      {!completedRef.current && (
        <p style={{
          fontSize: '10px',
          color: tapSelectedId !== null ? '#44ffeebb' : '#3a3f5c',
          letterSpacing: '1.5px', marginTop: '6px', textAlign: 'center',
          transition: 'color 0.3s',
          userSelect: 'none',
        }}>
          {tapSelectedId !== null
            ? 'TAP ADJACENT CELLS · TAP ANOTHER DOT TO SWITCH'
            : 'DRAG OR TAP A DOT · CONNECT MATCHING PAIRS'}
        </p>
      )}

      {/* Tutorial overlay — shown on first play, auto-dismisses after 4 s */}
      {showTutorial && (
        <div
          onClick={dismissTutorial}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(5,7,15,0.91)',
            padding: '32px',
            animation: 'fadeIn 0.35s ease',
          }}
        >
          {/* Colour dots demo */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '8px' }}>
            {['#FF4444','#4488FF','#44FF88'].map((c, i) => (
              <div key={i} style={{
                width: 28, height: 28, borderRadius: '50%', background: c,
                boxShadow: `0 0 14px ${c}bb`,
                animation: `idlePulse ${2 + i * 0.3}s ease-in-out infinite`,
              }} />
            ))}
          </div>
          <h3 style={{
            margin: '0 0 20px', fontSize: '17px', fontWeight: 900, letterSpacing: '3px',
            color: '#44ffee', textAlign: 'center',
          }}>HOW TO PLAY</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '280px' }}>
            {[
              { num: '①', text: 'Drag from a dot, or tap it then tap cells one by one', color: '#FF4444' },
              { num: '②', text: 'Connect each matching colour pair', color: '#4488FF' },
              { num: '③', text: 'Fill every square to solve it!', color: '#44FF88' },
            ].map(({ num, text, color }) => (
              <div key={num} style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <span style={{ fontSize: '18px', color, fontWeight: 800, minWidth: '22px' }}>{num}</span>
                <span style={{ fontSize: '13px', color: '#c0c8e0', lineHeight: 1.5 }}>{text}</span>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: '24px', padding: '8px 22px', borderRadius: '20px',
            background: 'rgba(68,255,238,0.07)', border: '1px solid rgba(68,255,238,0.2)',
          }}>
            <span style={{ fontSize: '10px', color: '#44ffee', letterSpacing: '2px', fontWeight: 700 }}>
              TAP TO START
            </span>
          </div>
        </div>
      )}

      {/* Lock flash — brief radial burst when a path completes */}
      {lockFlash && (
        <div key={lockFlash + Date.now()} style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 98,
          background: `radial-gradient(circle at center, ${lockFlash}25 0%, transparent 60%)`,
          animation: 'lockBurst 0.65s ease-out forwards',
        }} />
      )}

      {/* Win flash overlay — fires once when completedRef flips */}
      {completedRef.current && (
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 99,
          background: 'radial-gradient(circle at center, rgba(68,255,238,0.18) 0%, transparent 70%)',
          animation: 'winFlash 0.9s ease-out forwards',
        }} />
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════
//  § Performance Grade + Confetti
// ═════════════════════════════════════════════════════════════════

function performanceGrade(score: number): { grade: string; color: string; label: string } {
  if (score >= 9000) return { grade: 'S', color: '#FFE044', label: 'LEGENDARY' };
  if (score >= 7500) return { grade: 'A', color: '#44FF88', label: 'EXCELLENT' };
  if (score >= 5000) return { grade: 'B', color: '#44ffee', label: 'GREAT' };
  if (score >= 3000) return { grade: 'C', color: '#BB44FF', label: 'GOOD' };
  if (score >= 1000) return { grade: 'D', color: '#FF8844', label: 'OK' };
  return { grade: 'F', color: '#FF4444', label: 'KEEP TRYING' };
}

/** Seed-stable pseudo-random for confetti layout (no Math.random in render). */
function seededRandom(seed: number): number {
  let s = (seed * 9301 + 49297) % 233280;
  return s / 233280;
}

const WinConfetti = ({ colors }: { colors: string[] }) => {
  const particles = useMemo(() =>
    Array.from({ length: 50 }, (_, i) => ({
      x: seededRandom(i * 7 + 1) * 100,
      size: 4 + seededRandom(i * 13 + 3) * 7,
      color: colors[i % colors.length]!,
      delay: seededRandom(i * 11 + 5) * 0.6,
      dur: 1.8 + seededRandom(i * 17 + 7) * 1.5,
      drift: -40 + seededRandom(i * 19 + 9) * 80,
      shape: seededRandom(i * 23 + 11) > 0.5 ? '50%' : '2px',
    })), [colors],
  );
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 100, overflow: 'hidden' }}>
      {particles.map((p, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: `${p.x}%`, top: '-3%',
          width: p.size, height: p.size,
          borderRadius: p.shape,
          background: p.color,
          opacity: 0,
          animation: `confettiFall ${p.dur}s ease-out ${p.delay}s forwards`,
          transform: `translateX(${p.drift}px)`,
        }} />
      ))}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════
//  § ResultsView
// ═════════════════════════════════════════════════════════════════

interface ResultsViewProps {
  puzzle:       DailyPuzzle;
  username:     string;
  finalScore:   number;
  finalTime:    number;
  undoCount:    number;
  hintCount:    number;
  submitResult: ScoreSubmitResponse | null;
  walls:        WallsResponse | null;
  resultTab:    ResultTab;
  onTabChange:  (t: ResultTab) => void;
  shareStatus:  'idle' | 'loading' | 'done' | 'error';
  shareUrl:     string;
  onShare:      () => void;
}

const ResultsView = ({
  puzzle, username, finalScore, finalTime, undoCount, hintCount,
  submitResult, walls, resultTab, onTabChange,
  shareStatus, shareUrl, onShare,
}: ResultsViewProps) => {
  const isPerfect   = undoCount === 0 && hintCount === 0;
  const accentColor = isPerfect ? '#FFE044' : '#BB44FF';
  const streak      = submitResult?.streak;
  const grade       = performanceGrade(finalScore);

  // Animated score counter — counts up from 0 to finalScore over 1.2s
  const [displayScore, setDisplayScore] = useState(0);
  useEffect(() => {
    if (finalScore === 0) return;
    const dur = 1200;
    const start = Date.now();
    const tick = () => {
      const pct = Math.min(1, (Date.now() - start) / dur);
      const eased = 1 - Math.pow(1 - pct, 3); // ease-out cubic
      setDisplayScore(Math.round(eased * finalScore));
      if (pct < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [finalScore]);

  // Confetti colors from the puzzle palette
  const confettiColors = useMemo(
    () => COLOR_PALETTE.slice(0, puzzle.numColors).map(p => p.hex),
    [puzzle.numColors],
  );

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
      width: '100%', minHeight: '100vh',
      background: BG, fontFamily: FONT,
      padding: '16px', overflowY: 'auto',
      position: 'relative',
    }}>
      <style>{GLOBAL_STYLES}</style>
      <BgDecor />

      {/* Confetti particles */}
      <WinConfetti colors={confettiColors} />

      {/* Performance Grade Badge */}
      <div style={{
        marginTop: '14px', marginBottom: '2px',
        display: 'flex', alignItems: 'center', gap: '10px',
        animation: 'fadeIn 0.4s ease 0.3s both',
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${grade.color}18`,
          border: `2.5px solid ${grade.color}88`,
          boxShadow: `0 0 20px ${grade.color}44`,
          animation: 'gradeReveal 0.6s ease-out 0.5s both',
        }}>
          <span style={{
            fontSize: '28px', fontWeight: 900, color: grade.color,
            filter: `drop-shadow(0 0 8px ${grade.color}66)`,
          }}>{grade.grade}</span>
        </div>
        <div>
          <div style={{ fontSize: '8px', color: '#3a3f5c', letterSpacing: '3px' }}>{grade.label}</div>
          <div style={{
            fontSize: '22px', fontWeight: 900, color: accentColor, letterSpacing: '-0.5px',
            filter: `drop-shadow(0 0 10px ${accentColor}66)`,
          }}>
            {displayScore.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Headline */}
      <h2 style={{
        margin: '0 0 2px', fontSize: '20px', fontWeight: 900, letterSpacing: '4px',
        fontFamily: ORBITRON,
        background: `linear-gradient(135deg, ${accentColor}, #44ffee)`,
        backgroundSize: '200% auto',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        animation: 'shimmer 4s linear infinite',
      }}>
        {isPerfect ? 'PROTOCOL SOLVED' : 'SCHEMA RESOLVED'}
      </h2>
      <p style={{ margin: '0 0 12px', fontSize: '9px', color: '#3a3f5c', letterSpacing: '3px' }}>
        {puzzle.date} · {puzzle.mode === 'hard' ? 'HARD' : 'EASY'} · {puzzle.gridSize}×{puzzle.gridSize} · {puzzle.numColors} PAIRS
      </p>

      {/* Score card */}
      <div style={{
        width: '100%', maxWidth: '340px',
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${accentColor}33`,
        borderRadius: '16px', padding: '16px', marginBottom: '12px',
        boxShadow: `0 0 32px ${accentColor}14`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
          <Stat label="SCORE" value={finalScore.toLocaleString()} color={accentColor} large />
          <Stat label="TIME"  value={formatTime(finalTime)} color="#44ffee" />
          <Stat label="UNDOS" value={String(undoCount)} color={undoCount === 0 ? '#44FF88' : '#FF4444'} />
          <Stat label="HINTS" value={String(hintCount)} color={hintCount === 0 ? '#44FF88' : '#FFE044'} />
        </div>
        {/* Streak banner */}
        {streak && streak.current > 0 && (
          <div style={{
            marginBottom: '8px', padding: '6px 12px', borderRadius: '8px',
            background: 'rgba(68,255,238,0.06)', border: '1px solid rgba(68,255,238,0.18)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: '10px', color: '#44ffee', fontWeight: 700 }}>
              🔥 {streak.current}-day streak
            </span>
            <span style={{ fontSize: '9px', color: '#4b5079' }}>
              best: {streak.best}
            </span>
          </div>
        )}
        {submitResult && (
          <div style={{
            padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: '10px', color: '#4b5079' }}>
              {submitResult.alreadyCompleted ? 'Previously solved' : 'Today\'s rank'}
            </span>
            <span style={{ fontSize: '14px', fontWeight: 800, color: '#44ffee' }}>
              #{submitResult.rank ?? '—'} of {submitResult.totalPlayers}
            </span>
          </div>
        )}
        {isPerfect && (
          <div style={{
            marginTop: '10px', padding: '12px 16px', borderRadius: '12px',
            background: 'rgba(255,224,68,0.10)', border: '1.5px solid rgba(255,224,68,0.4)',
            textAlign: 'center',
            boxShadow: '0 0 24px rgba(255,224,68,0.15)',
            animation: 'fadeIn 0.5s ease 0.6s both',
          }}>
            <div style={{ fontSize: '20px', marginBottom: '4px' }}>★</div>
            <div style={{ fontSize: '13px', color: '#FFE044', fontWeight: 800, letterSpacing: '3px' }}>
              WALL OF FAME
            </div>
            <div style={{ fontSize: '10px', color: '#b8a840', marginTop: '2px' }}>
              {submitResult?.fameRank
                ? `Rank #${submitResult.fameRank} · Zero errors, pure skill`
                : 'Perfect run! Zero errors, zero hints'}
            </div>
          </div>
        )}
        {!isPerfect && (
          <div style={{
            marginTop: '10px', padding: '12px 16px', borderRadius: '12px',
            background: 'rgba(255,68,68,0.08)', border: '1.5px solid rgba(255,68,68,0.3)',
            textAlign: 'center',
            boxShadow: '0 0 24px rgba(255,68,68,0.12)',
            animation: 'fadeIn 0.5s ease 0.6s both',
          }}>
            <div style={{ fontSize: '20px', marginBottom: '4px' }}>☠</div>
            <div style={{ fontSize: '13px', color: '#FF6666', fontWeight: 800, letterSpacing: '3px' }}>
              WALL OF SHAME
            </div>
            <div style={{ fontSize: '10px', color: '#8a4444', marginTop: '2px' }}>
              {submitResult?.shameRank
                ? `#${submitResult.shameRank} most undos/hints today`
                : `${undoCount} undo${undoCount !== 1 ? 's' : ''} + ${hintCount} hint${hintCount !== 1 ? 's' : ''}`}
            </div>
          </div>
        )}
      </div>

      {/* Share button */}
      <div style={{ width: '100%', maxWidth: '340px', marginBottom: '12px' }}>
        {shareStatus === 'idle' && (
          <button onClick={onShare} style={SHARE_BTN}>▲ SHARE PROTOCOL · Challenge the community</button>
        )}
        {shareStatus === 'loading' && (
          <div style={{ ...SHARE_BTN as React.CSSProperties, opacity: 0.6, pointerEvents: 'none', cursor: 'default' }}>Posting…</div>
        )}
        {shareStatus === 'done' && (
          <div style={{ ...SHARE_BTN as React.CSSProperties, borderColor: '#44FF88aa', color: '#44FF88' }}>
            ✓ Posted! <a href={shareUrl} target="_blank" rel="noopener noreferrer"
              style={{ color: '#44ffee', marginLeft: '8px' }}>View post</a>
          </div>
        )}
        {shareStatus === 'error' && (
          <button onClick={onShare} style={{ ...SHARE_BTN, borderColor: '#FF444488', color: '#FF8888' }}>
            ✕ Failed — tap to retry
          </button>
        )}
      </div>

      {/* Leaderboard tabs */}
      <div style={{ width: '100%', maxWidth: '340px', display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['score', 'fame', 'shame'] as ResultTab[]).map(t => (
          <button key={t} onClick={() => onTabChange(t)} style={{
            flex: 1, padding: '7px 0', borderRadius: '8px', cursor: 'pointer',
            fontFamily: FONT, fontSize: '9px', fontWeight: 700, letterSpacing: '2px',
            background: resultTab === t ? 'rgba(68,255,238,0.1)' : 'rgba(255,255,255,0.025)',
            border: `1px solid ${resultTab === t ? 'rgba(68,255,238,0.4)' : 'rgba(255,255,255,0.06)'}`,
            color: resultTab === t ? '#44ffee' : '#4b5079',
            transition: 'all 0.15s',
          }}>
            {t === 'score' ? 'YOUR SCORE' : t === 'fame' ? '★ FAME' : '☠ SHAME'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ width: '100%', maxWidth: '340px' }}>
        {resultTab === 'score' && (
          <div style={{
            padding: '14px', borderRadius: '12px',
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
          }}>
            <p style={{ fontSize: '11px', color: '#44ffee', fontWeight: 700, marginBottom: '8px', letterSpacing: '1px' }}>
              {isPerfect
                ? '⚡ Perfect run! Zero errors, zero hints — Wall of Fame!'
                : hintCount > 0
                  ? `💡 ${hintCount} hint${hintCount > 1 ? 's' : ''} used · −${hintCount * 100} pts. Go hint-free for Fame.`
                  : `🎯 Solid solve! ${undoCount} undo${undoCount > 1 ? 's' : ''} cost ${undoCount * 200} pts. Go error-free for Fame.`}
            </p>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {[
                { k: 'Base score',   v: MAX_SCORE.toLocaleString() },
                { k: 'Time −',       v: `−${Math.floor(finalTime / 1_000) * 10}` },
                { k: 'Undo −',       v: `−${undoCount * 200}` },
                { k: 'Hint −',       v: `−${hintCount * 100}` },
                { k: 'Final',        v: finalScore.toLocaleString() },
              ].map(({ k, v }) => (
                <div key={k} style={{
                  padding: '5px 10px', borderRadius: '6px',
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
                }}>
                  <div style={{ fontSize: '8px', color: '#3a3f5c', letterSpacing: '1px' }}>{k}</div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#d0d8f0' }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {resultTab === 'fame' && (
          <div>
            <p style={{ fontSize: '8px', color: '#FFE044', letterSpacing: '2px', marginBottom: '6px', fontWeight: 700 }}>
              ★ WALL OF FAME — ZERO ERRORS, FASTEST TIME
            </p>
            {(walls?.fame ?? []).length === 0
              ? <p style={{ fontSize: '11px', color: '#3a3f5c', textAlign: 'center', padding: '16px' }}>No perfect runs yet. Be the first!</p>
              : (walls?.fame ?? []).map((e, i) => <LBRow key={i} entry={e} highlight={e.username === username} />)}
          </div>
        )}
        {resultTab === 'shame' && (
          <div>
            <p style={{ fontSize: '8px', color: '#FF4444', letterSpacing: '2px', marginBottom: '6px', fontWeight: 700 }}>
              ☠ WALL OF SHAME — MOST UNDOS / ERRORS
            </p>
            {(walls?.shame ?? []).length === 0
              ? <p style={{ fontSize: '11px', color: '#3a3f5c', textAlign: 'center', padding: '16px' }}>No data yet.</p>
              : (walls?.shame ?? []).map((e, i) => <LBRow key={i} entry={e} highlight={e.username === username} />)}
          </div>
        )}
      </div>
      <div style={{ height: '32px' }} />
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════
//  § Shared background decorations (used on every screen)
// ═════════════════════════════════════════════════════════════════

/** HUD corner bracket — place 4 of these around any panel */
const Corner = ({ top, left, right, bottom }: {
  top?: boolean; left?: boolean; right?: boolean; bottom?: boolean;
}) => (
  <div style={{
    position: 'absolute',
    top:    top    ? -6 : undefined,
    bottom: bottom ? -6 : undefined,
    left:   left   ? -6 : undefined,
    right:  right  ? -6 : undefined,
    width: 14, height: 14,
    borderTop:    top    ? '2px solid rgba(68,255,238,0.45)' : 'none',
    borderBottom: bottom ? '2px solid rgba(68,255,238,0.45)' : 'none',
    borderLeft:   left   ? '2px solid rgba(68,255,238,0.45)' : 'none',
    borderRight:  right  ? '2px solid rgba(68,255,238,0.45)' : 'none',
    pointerEvents: 'none',
    animation: 'cornerFlicker 4s ease-in-out infinite',
  }} />
);

// ═════════════════════════════════════════════════════════════════
//  § Mode Selection Screen
// ═════════════════════════════════════════════════════════════════

/** Tiny read-only grid showing today's puzzle dots for a given mode */
const ModePreview = ({ puzzle }: { puzzle: DailyPuzzle }) => {
  const { gridSize, nodes } = puzzle;
  const CELL = Math.max(11, Math.min(19, Math.floor(110 / gridSize) - 2));
  const nodeMap = new Map(nodes.map(n => [`${n.x},${n.y}`, n]));
  return (
    <div style={{
      display: 'inline-grid',
      gridTemplateColumns: `repeat(${gridSize}, ${CELL}px)`,
      gridTemplateRows:    `repeat(${gridSize}, ${CELL}px)`,
      gap: 2,
    }}>
      {Array.from({ length: gridSize * gridSize }, (_, i) => {
        const x    = i % gridSize;
        const y    = Math.floor(i / gridSize);
        const node = nodeMap.get(`${x},${y}`);
        return (
          <div key={i} style={{
            width: CELL, height: CELL,
            borderRadius: node ? '50%' : 2,
            background: node ? node.color : 'rgba(255,255,255,0.04)',
            border: node
              ? `1px solid ${node.color}`
              : '1px solid rgba(255,255,255,0.05)',
            boxShadow: node ? `0 0 7px ${node.color}88` : 'none',
          }} />
        );
      })}
    </div>
  );
};

const SelectView = ({ date, onSelect }: {
  date: string;
  onSelect: (m: DifficultyMode) => void;
}) => {
  const easyPuzzle = useMemo(() => generateDailyPuzzle(date, 'easy'), [date]);
  const hardPuzzle = useMemo(() => generateDailyPuzzle(date, 'hard'), [date]);

  return (
    <div style={{
      ...CENTER,
      background: 'linear-gradient(165deg, #050810 0%, #080d1e 40%, #06091a 70%, #040710 100%)',
      fontFamily: FONT, position: 'relative', overflow: 'hidden',
    }}>
      <style>{GLOBAL_STYLES}</style>

      {/* Dot grid */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
        backgroundImage: 'radial-gradient(circle, rgba(68,255,238,0.07) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
        animation: 'gridPulse 4s ease-in-out infinite',
      }} />
      {/* Green ambient blob — top-right, hints at EASY */}
      <div style={{
        position: 'absolute', top: '-20%', right: '-12%',
        width: '52%', height: '52%', borderRadius: '50%',
        pointerEvents: 'none', zIndex: 0,
        background: 'radial-gradient(circle, rgba(68,255,136,0.09) 0%, transparent 65%)',
      }} />
      {/* Red ambient blob — bottom-left, hints at HARD */}
      <div style={{
        position: 'absolute', bottom: '-22%', left: '-12%',
        width: '52%', height: '52%', borderRadius: '50%',
        pointerEvents: 'none', zIndex: 0,
        background: 'radial-gradient(circle, rgba(255,68,68,0.09) 0%, transparent 65%)',
      }} />
      {/* Scanline sweep */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: '2px',
        pointerEvents: 'none', zIndex: 0,
        background: 'linear-gradient(90deg, transparent 5%, rgba(68,255,238,0.15) 30%, rgba(68,255,238,0.22) 50%, rgba(68,255,238,0.15) 70%, transparent 95%)',
        animation: 'scanline 4.5s linear infinite',
      }} />
      {/* Vignette */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
        background: 'radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.55) 100%)',
      }} />

      {/* Logo */}
      <div style={{
        fontSize: 30, marginBottom: 4, zIndex: 1,
        animation: 'nodeFloat 3s ease-in-out infinite',
        filter: 'drop-shadow(0 0 14px rgba(68,255,238,0.55))',
      }}>&#x29C2;</div>

      {/* Title */}
      <h1 style={{
        margin: '0 0 3px', fontSize: 'clamp(14px,5vw,20px)',
        fontWeight: 900, letterSpacing: 6, zIndex: 1, fontFamily: ORBITRON,
        background: 'linear-gradient(135deg, #44ffee 0%, #4488ff 35%, #bb44ff 65%, #44ffee 100%)',
        backgroundSize: '300% auto',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        animation: 'shimmer 5s linear infinite',
      }}>SCHEMA CRISIS</h1>

      {/* Subtitle */}
      <p style={{
        margin: '0 0 20px', fontSize: 8, color: '#35405a',
        letterSpacing: 4, fontWeight: 600, zIndex: 1,
        animation: 'fadeUp 0.45s ease 0.05s both',
      }}>
        {date} · CHOOSE YOUR MISSION
      </p>

      {/* ── Mission cards ── */}
      <div style={{ display: 'flex', gap: 12, zIndex: 1 }}>

        {/* ─── EASY ─── */}
        <button
          className="sel-card-easy"
          onClick={() => onSelect('easy')}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '16px 14px 14px', width: 148, borderRadius: 18,
            background: 'linear-gradient(158deg, rgba(68,255,136,0.08) 0%, rgba(68,255,136,0.03) 50%, rgba(5,8,20,0.72) 100%)',
            border: '1.5px solid rgba(68,255,136,0.27)',
            fontFamily: FONT,
          }}>
          {/* Tier badge */}
          <span style={{
            fontSize: 8, padding: '2px 10px', borderRadius: 10,
            background: 'rgba(68,255,136,0.1)',
            border: '1px solid rgba(68,255,136,0.22)',
            color: '#44FF88', fontWeight: 700, letterSpacing: 2, marginBottom: 9,
          }}>✦ RECRUIT</span>

          {/* Mode name */}
          <div style={{
            fontSize: 'clamp(19px,5.5vw,24px)', fontWeight: 900, letterSpacing: 4,
            color: '#44FF88', marginBottom: 3, fontFamily: ORBITRON,
            filter: 'drop-shadow(0 0 12px rgba(68,255,136,0.55))',
          }}>EASY</div>

          {/* Spec */}
          <div style={{
            fontSize: 8, color: 'rgba(68,255,136,0.38)',
            letterSpacing: 2, fontWeight: 600, marginBottom: 12,
          }}>5×5 · 4 PATHS</div>

          {/* Divider */}
          <div style={{
            width: '76%', height: 1, marginBottom: 12,
            background: 'linear-gradient(90deg, transparent, rgba(68,255,136,0.25), transparent)',
          }} />

          {/* Live puzzle preview */}
          <div style={{
            padding: 8, borderRadius: 9,
            background: 'rgba(0,0,0,0.28)',
            border: '1px solid rgba(68,255,136,0.07)',
            marginBottom: 12,
          }}>
            <ModePreview puzzle={easyPuzzle} />
          </div>

          {/* CTA */}
          <div style={{
            fontSize: 9, color: '#44FF88', letterSpacing: 3,
            fontWeight: 800, opacity: 0.55,
          }}>PLAY →</div>
        </button>

        {/* ─── HARD ─── */}
        <button
          className="sel-card-hard"
          onClick={() => onSelect('hard')}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '16px 14px 14px', width: 148, borderRadius: 18,
            background: 'linear-gradient(158deg, rgba(255,68,68,0.08) 0%, rgba(255,68,68,0.03) 50%, rgba(5,8,20,0.72) 100%)',
            border: '1.5px solid rgba(255,68,68,0.27)',
            fontFamily: FONT,
          }}>
          {/* Tier badge */}
          <span style={{
            fontSize: 8, padding: '2px 10px', borderRadius: 10,
            background: 'rgba(255,68,68,0.1)',
            border: '1px solid rgba(255,68,68,0.22)',
            color: '#FF4444', fontWeight: 700, letterSpacing: 2, marginBottom: 9,
          }}>⬡ EXPERT</span>

          {/* Mode name */}
          <div style={{
            fontSize: 'clamp(19px,5.5vw,24px)', fontWeight: 900, letterSpacing: 4,
            color: '#FF4444', marginBottom: 3, fontFamily: ORBITRON,
            filter: 'drop-shadow(0 0 12px rgba(255,68,68,0.55))',
          }}>HARD</div>

          {/* Spec */}
          <div style={{
            fontSize: 8, color: 'rgba(255,68,68,0.38)',
            letterSpacing: 2, fontWeight: 600, marginBottom: 12,
          }}>7×7 · 7 PATHS</div>

          {/* Divider */}
          <div style={{
            width: '76%', height: 1, marginBottom: 12,
            background: 'linear-gradient(90deg, transparent, rgba(255,68,68,0.25), transparent)',
          }} />

          {/* Live puzzle preview */}
          <div style={{
            padding: 8, borderRadius: 9,
            background: 'rgba(0,0,0,0.28)',
            border: '1px solid rgba(255,68,68,0.07)',
            marginBottom: 12,
          }}>
            <ModePreview puzzle={hardPuzzle} />
          </div>

          {/* CTA */}
          <div style={{
            fontSize: 9, color: '#FF4444', letterSpacing: 3,
            fontWeight: 800, opacity: 0.55,
          }}>PLAY →</div>
        </button>
      </div>
    </div>
  );
};

/** Full-screen ambient decorations: dot grid, blobs, scanline, vignette */
const BgDecor = () => (
  <>
    {/* Dot grid */}
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
      backgroundImage: 'radial-gradient(circle, rgba(68,255,238,0.08) 1px, transparent 1px)',
      backgroundSize: '22px 22px',
      animation: 'gridPulse 4s ease-in-out infinite',
    }} />
    {/* Ambient blobs */}
    <div style={{
      position: 'absolute', top: '-15%', right: '-10%',
      width: '55%', height: '55%', borderRadius: '50%', pointerEvents: 'none', zIndex: 0,
      background: 'radial-gradient(circle, rgba(187,68,255,0.12) 0%, transparent 65%)',
    }} />
    <div style={{
      position: 'absolute', bottom: '-20%', left: '-12%',
      width: '50%', height: '50%', borderRadius: '50%', pointerEvents: 'none', zIndex: 0,
      background: 'radial-gradient(circle, rgba(68,136,255,0.10) 0%, transparent 65%)',
    }} />
    <div style={{
      position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)',
      width: '45%', height: '45%', borderRadius: '50%', pointerEvents: 'none', zIndex: 0,
      background: 'radial-gradient(circle, rgba(68,255,238,0.05) 0%, transparent 60%)',
    }} />
    {/* Scanline sweep */}
    <div style={{
      position: 'absolute', left: 0, right: 0, height: '2px', pointerEvents: 'none', zIndex: 0,
      background: 'linear-gradient(90deg, transparent 5%, rgba(68,255,238,0.18) 30%, rgba(68,255,238,0.25) 50%, rgba(68,255,238,0.18) 70%, transparent 95%)',
      animation: 'scanline 4.5s linear infinite',
    }} />
    {/* Vignette */}
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
      background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)',
    }} />
  </>
);

// ═════════════════════════════════════════════════════════════════
//  § App — State Machine (loading → puzzle → complete)
// ═════════════════════════════════════════════════════════════════

const App = () => {
  const date = getTodayDateStr();

  // ── Phase machine ───────────────────────────────────────────
  const [phase,        setPhase]        = useState<Phase>('select');
  const [mode,         setMode]         = useState<DifficultyMode>('easy');
  const [puzzle,       setPuzzle]       = useState<DailyPuzzle | null>(null);
  const [username,     setUsername]     = useState('');
  const [walls,        setWalls]        = useState<WallsResponse | null>(null);

  // ── Timer ───────────────────────────────────────────────────
  const [elapsedMs,   setElapsedMs]   = useState(0);
  const startTimeRef  = useRef<number | null>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Results ─────────────────────────────────────────────────
  const [finalScore,    setFinalScore]    = useState(0);
  const [finalTime,     setFinalTime]     = useState(0);
  const [finalUndoCount, setFinalUndoCount] = useState(0);
  const [finalHintCount, setFinalHintCount] = useState(0);
  const [submitResult,  setSubmitResult]  = useState<ScoreSubmitResponse | null>(null);
  const [resultTab,     setResultTab]     = useState<ResultTab>('score');
  const [shareStatus,   setShareStatus]   = useState<'idle'|'loading'|'done'|'error'>('idle');
  const [shareUrl,      setShareUrl]      = useState('');

  // ── Timer helpers ───────────────────────────────────────────
  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - (startTimeRef.current ?? Date.now()));
    }, 100);
  }, []);

  const stopTimer = useCallback((): number => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    return Date.now() - (startTimeRef.current ?? Date.now());
  }, []);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // ── Load puzzle for selected mode ───────────────────────────
  const loadPuzzle = useCallback((selectedMode: DifficultyMode) => {
    setMode(selectedMode);
    setPhase('loading');
    apiFetch<InitResponse>(`/api/init?mode=${selectedMode}`)
      .then(res => {
        setPuzzle(res.puzzle);
        setUsername(res.username);
        setWalls(res.walls);
        if (res.hasCompleted && res.previousEntry) {
          setFinalScore(res.previousEntry.score);
          setFinalTime(res.previousEntry.timeMs);
          setFinalUndoCount(res.previousEntry.undoCount);
          const isPrev = res.previousEntry.undoCount === 0;
          setResultTab(isPrev ? 'fame' : 'shame');
          setSubmitResult({
            type: 'score', success: true, alreadyCompleted: true,
            rank: res.previousEntry.rank, totalPlayers: res.walls.totalPlayers,
            ...(res.streak ? { streak: res.streak } : {}),
            message: 'Already completed today!',
          });
          setPhase('complete');
        } else {
          setPhase('puzzle');
          startTimer();
        }
      })
      .catch(err => {
        console.error('[init]', err);
        setPuzzle(generateDailyPuzzle(date, selectedMode));
        setUsername('anon');
        setWalls({ fame: [], shame: [], totalPlayers: 0 });
        setPhase('puzzle');
        startTimer();
      });
  }, [date, startTimer]);

  // ── Puzzle complete callback (from PuzzleView) ──────────────
  const handleComplete = useCallback(async (undoCount: number, hintCount: number) => {
    const elapsed = stopTimer();
    const score   = computeScore(elapsed, undoCount, hintCount);
    setFinalScore(score);
    setFinalTime(elapsed);
    setFinalUndoCount(undoCount);
    setFinalHintCount(hintCount);
    setPhase('complete');

    const isPerfect = undoCount === 0 && hintCount === 0;
    setResultTab(isPerfect ? 'fame' : 'shame');

    const body: ScoreSubmitRequest = { date, mode, timeMs: elapsed, undoCount, hintCount, score };
    try {
      const res = await apiFetch<ScoreSubmitResponse>('/api/score', body);
      setSubmitResult(res);
      try {
        const fresh = await apiFetch<InitResponse>(`/api/init?mode=${mode}`);
        setWalls(fresh.walls);
      } catch { /* leaderboard refresh is non-critical */ }
    } catch (err) {
      console.error('[score submit]', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopTimer, date, mode]);

  // ── Share ───────────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    setShareStatus('loading');
    const body: ShareRequest = {
      date, mode, score: finalScore, timeMs: finalTime,
      undoCount: finalUndoCount,
      ...(submitResult?.rank !== undefined ? { rank: submitResult.rank } : {}),
    };
    try {
      const res = await apiFetch<ShareResponse>('/api/share', body);
      if (res.success && res.postUrl) {
        setShareUrl(res.postUrl);
        setShareStatus('done');
      } else {
        setShareStatus('error');
      }
    } catch {
      setShareStatus('error');
    }
  }, [date, mode, finalScore, finalTime, finalUndoCount, submitResult]);

  // ── Render ──────────────────────────────────────────────────

  if (phase === 'select') {
    return <SelectView date={date} onSelect={loadPuzzle} />;
  }

  if (phase === 'loading') {
    return (
      <div style={{ ...CENTER, background: BG, fontFamily: FONT, position: 'relative', overflow: 'hidden' }}>
        <style>{GLOBAL_STYLES}</style>
        <BgDecor />
        <div style={{ fontSize: '32px', animation: 'nodeFloat 1.5s ease-in-out infinite', zIndex: 1 }}>&#x29C2;</div>
        <p style={{ color: '#44ffee', fontSize: '11px', letterSpacing: '4px', marginTop: '12px', zIndex: 1, fontFamily: MONO }}>
          LOADING SCHEMA…
        </p>
      </div>
    );
  }

  if (phase === 'puzzle' && puzzle) {
    return (
      <PuzzleView
        puzzle={puzzle}
        elapsedMs={elapsedMs}
        onComplete={handleComplete}
      />
    );
  }

  if (phase === 'complete' && puzzle) {
    return (
      <ResultsView
        puzzle={puzzle}
        username={username}
        finalScore={finalScore}
        finalTime={finalTime}
        undoCount={finalUndoCount}
        hintCount={finalHintCount}
        submitResult={submitResult}
        walls={walls}
        resultTab={resultTab}
        onTabChange={setResultTab}
        shareStatus={shareStatus}
        shareUrl={shareUrl}
        onShare={handleShare}
      />
    );
  }

  return (
    <div style={{ ...CENTER, background: BG, fontFamily: FONT, position: 'relative', overflow: 'hidden' }}>
      <style>{GLOBAL_STYLES}</style>
      <BgDecor />
      <p style={{ color: '#FF4444', fontSize: '14px', zIndex: 1 }}>⚠ Connection lost</p>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════
//  § Style Constants
// ═════════════════════════════════════════════════════════════════

const CENTER: React.CSSProperties = {
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  width: '100%', height: '100vh',
};

const CTRL_BTN: React.CSSProperties = {
  padding: '11px 20px', minHeight: '44px', borderRadius: '10px', cursor: 'pointer',
  fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '2px',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.09)',
  color: '#7080a0', transition: 'all 0.15s',
};

const SHARE_BTN: React.CSSProperties = {
  width: '100%', padding: '12px', borderRadius: '10px', cursor: 'pointer',
  fontFamily: FONT, fontSize: '11px', fontWeight: 700, letterSpacing: '2px',
  background: 'rgba(68,136,255,0.08)',
  border: '1.5px solid rgba(68,136,255,0.35)',
  color: '#4488ff', transition: 'all 0.15s', textAlign: 'center',
};

const GLOBAL_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap');

  @keyframes nodeFloat {
    0%,100% { transform: translateY(0) scale(1); }
    50%     { transform: translateY(-8px) scale(1.04); }
  }
  @keyframes shimmer {
    0%   { background-position: -300% center; }
    100% { background-position:  300% center; }
  }
  @keyframes headPulse {
    0%,100% { transform: scale(1); opacity: 0.8; }
    50%     { transform: scale(1.35); opacity: 1; }
  }
  @keyframes idlePulse {
    0%,100% { transform: scale(1);    opacity: 0.82; }
    50%     { transform: scale(1.22); opacity: 1; }
  }
  @keyframes tapRing {
    0%,100% { transform: scale(1);    opacity: 0.65; }
    50%     { transform: scale(1.18); opacity: 1; }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.97); }
    to   { opacity: 1; transform: scale(1); }
  }
  @keyframes winFlash {
    0%   { opacity: 0; }
    15%  { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes validPulse {
    0%,100% { border-color: rgba(68,255,238,0.12); box-shadow: 0 0 4px rgba(68,255,238,0.06); }
    50%     { border-color: rgba(68,255,238,0.30); box-shadow: 0 0 10px rgba(68,255,238,0.18); }
  }
  @keyframes lockBurst {
    0%   { opacity: 0; transform: scale(0.8); }
    20%  { opacity: 1; transform: scale(1); }
    100% { opacity: 0; transform: scale(1.3); }
  }
  @keyframes confettiFall {
    0%   { opacity: 1; transform: translateY(0) rotate(0deg) scale(1); }
    80%  { opacity: 0.8; }
    100% { opacity: 0; transform: translateY(92vh) rotate(720deg) scale(0.4); }
  }
  @keyframes gradeReveal {
    0%   { opacity: 0; transform: scale(0.3) rotate(-20deg); }
    60%  { transform: scale(1.15) rotate(5deg); }
    100% { opacity: 1; transform: scale(1) rotate(0deg); }
  }
  @keyframes scanline {
    0%   { transform: translateY(-100%); }
    100% { transform: translateY(400%); }
  }
  @keyframes gridPulse {
    0%, 100% { opacity: 0.04; }
    50%      { opacity: 0.09; }
  }
  @keyframes cornerFlicker {
    0%, 90%, 100% { opacity: 0.6; }
    93%           { opacity: 0.2; }
    96%           { opacity: 0.8; }
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes ctaGlow {
    0%, 100% { box-shadow: 0 0 20px rgba(68,255,238,0.3),  0 0 40px rgba(68,255,238,0.08); }
    50%      { box-shadow: 0 0 32px rgba(68,255,238,0.55), 0 0 64px rgba(68,255,238,0.16); }
  }
  .cta-btn { transition: transform 0.12s ease, filter 0.12s ease; }
  .cta-btn:hover  { transform: scale(1.06) !important; filter: brightness(1.2); }
  .cta-btn:active { transform: scale(0.96) !important; }
  @keyframes cardEntryLeft {
    from { opacity: 0; transform: translateX(-22px) scale(0.93); }
    to   { opacity: 1; transform: translateX(0)     scale(1);    }
  }
  @keyframes cardEntryRight {
    from { opacity: 0; transform: translateX(22px)  scale(0.93); }
    to   { opacity: 1; transform: translateX(0)     scale(1);    }
  }
  @keyframes easyCardPulse {
    0%,100% { box-shadow: 0 4px 28px rgba(68,255,136,0.10), 0 0 0 1.5px rgba(68,255,136,0.20); }
    50%     { box-shadow: 0 8px 44px rgba(68,255,136,0.24), 0 0 0 1.5px rgba(68,255,136,0.42); }
  }
  @keyframes hardCardPulse {
    0%,100% { box-shadow: 0 4px 28px rgba(255,68,68,0.10), 0 0 0 1.5px rgba(255,68,68,0.20); }
    50%     { box-shadow: 0 8px 44px rgba(255,68,68,0.24), 0 0 0 1.5px rgba(255,68,68,0.42); }
  }
  .sel-card-easy {
    animation: cardEntryLeft  0.55s cubic-bezier(0.16,1,0.3,1) 0.12s both,
               easyCardPulse 3.2s  ease-in-out infinite 0.8s;
    transition: transform 0.18s ease, filter 0.18s ease;
    cursor: pointer;
  }
  .sel-card-easy:hover  { transform: translateY(-5px) scale(1.025) !important; filter: brightness(1.12); }
  .sel-card-easy:active { transform: scale(0.97) !important; }
  .sel-card-hard {
    animation: cardEntryRight 0.55s cubic-bezier(0.16,1,0.3,1) 0.22s both,
               hardCardPulse  3.2s ease-in-out infinite 0.95s;
    transition: transform 0.18s ease, filter 0.18s ease;
    cursor: pointer;
  }
  .sel-card-hard:hover  { transform: translateY(-5px) scale(1.025) !important; filter: brightness(1.12); }
  .sel-card-hard:active { transform: scale(0.97) !important; }
  * { box-sizing: border-box; }
  body { margin: 0; overflow: hidden; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(68,255,238,0.2); border-radius: 2px; }
`;

// ═════════════════════════════════════════════════════════════════
//  § Mount
// ═════════════════════════════════════════════════════════════════

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
