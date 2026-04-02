// ═══════════════════════════════════════════════════════════════════
//  Schema Crisis — Daily Puzzle Generator
//
//  Contract: generateDailyPuzzle(dateStr) is PURE and DETERMINISTIC.
//  The same date always produces the same puzzle for every player.
//
//  Algorithm (Balanced Round-Robin Growing Tree):
//    1. Hash the date string → 32-bit seed.
//    2. Derive grid size & colour count from day-of-week.
//    3. Pick N well-separated seed cells via the PRNG.
//    4. Grow N paths in a balanced round-robin (shortest grows first)
//       until every cell is claimed.
//    5. Fallback: flood-fill any unreachable isolated cells.
//    6. Return only the two endpoint nodes per colour — the solution
//       paths are intentionally discarded.
// ═══════════════════════════════════════════════════════════════════

import type { DailyPuzzle, DifficultyMode, PuzzleNode } from './api';

// ── Colour Palette ────────────────────────────────────────────────
export const COLOR_PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'RED',    hex: '#FF4444' },
  { name: 'BLUE',   hex: '#4488FF' },
  { name: 'GREEN',  hex: '#44FF88' },
  { name: 'YELLOW', hex: '#FFE044' },
  { name: 'PURPLE', hex: '#BB44FF' },
  { name: 'CYAN',   hex: '#44FFEE' },
  { name: 'ORANGE', hex: '#FF8844' },
  { name: 'PINK',   hex: '#FF44BB' },
  { name: 'LIME',   hex: '#AAFF44' },
  { name: 'MAROON', hex: '#CC3333' },
];

// ── Scoring Constants ─────────────────────────────────────────────
export const MAX_SCORE         = 10_000;
export const PENALTY_PER_SEC   = 10;   // deducted per elapsed second
export const PENALTY_PER_UNDO  = 200;  // deducted per undo/clear action
export const PENALTY_PER_HINT  = 100;  // deducted per hint used

// ── Mulberry32 PRNG ───────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// FNV-1a hash: maps the date string to a stable 32-bit unsigned int.
export function dateToSeed(dateStr: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dateStr.length; i++) {
    h = Math.imul(h ^ dateStr.charCodeAt(i), 0x01000193) | 0;
  }
  return h >>> 0;
}

// ── Grid Config by Difficulty Mode ────────────────────────────────
// Easy:  5×5, 4 colour pairs  — approachable, fast solves.
// Hard:  7×7, 7 colour pairs  — challenging, requires planning.
function gridConfigForMode(mode: DifficultyMode): { gridSize: number; numColors: number } {
  if (mode === 'hard') return { gridSize: 7, numColors: 7 };
  return { gridSize: 5, numColors: 4 }; // easy
}


// ── Internal Cell Type ────────────────────────────────────────────
interface Cell { x: number; y: number }


// ── Public API ────────────────────────────────────────────────────

/**
 * Generate the canonical puzzle for a given UTC date string (YYYY-MM-DD)
 * and difficulty mode. The seed incorporates the mode so easy and hard
 * produce completely different dot layouts for the same date.
 */
export function generateDailyPuzzle(dateStr: string, mode: DifficultyMode = 'easy'): DailyPuzzle {
  const { gridSize, numColors } = gridConfigForMode(mode);
  const seed = dateToSeed(dateStr + ':' + mode);
  const rng  = mulberry32(seed);

  const { colorGrid, paths } = buildSolvedBoard(gridSize, numColors, rng);

  // ── Solvability invariant check (always runs — catches build bugs) ──
  for (let y = 0; y < gridSize; y++)
    for (let x = 0; x < gridSize; x++)
      if (colorGrid[y]![x] === -1)
        console.error(`[puzzle] UNSOLVABLE: cell (${x},${y}) unclaimed — seed: ${seed}`);

  for (let id = 0; id < numColors; id++) {
    const p = paths[id]!;
    for (let i = 1; i < p.length; i++) {
      const dist = Math.abs(p[i]!.x - p[i-1]!.x) + Math.abs(p[i]!.y - p[i-1]!.y);
      if (dist !== 1)
        console.error(`[puzzle] UNSOLVABLE: path ${id} has non-adjacent step at index ${i} — seed: ${seed}`);
    }
  }

  // Extract the two endpoints per colour as puzzle nodes.
  const nodes: PuzzleNode[] = [];
  for (let id = 0; id < numColors; id++) {
    const path    = paths[id]!;
    const palette = COLOR_PALETTE[id]!;
    const a       = path[0]!;
    const b       = path[path.length - 1]!;
    nodes.push({ id, x: a.x, y: a.y, color: palette.hex, colorName: palette.name });
    nodes.push({ id, x: b.x, y: b.y, color: palette.hex, colorName: palette.name });
  }

  return { date: dateStr, gridSize, numColors, nodes, mode };
}

// ── Scoring Helpers ───────────────────────────────────────────────

export function computeScore(timeMs: number, undoCount: number, hintCount = 0): number {
  const timePenalty = Math.floor(timeMs / 1_000) * PENALTY_PER_SEC;
  const undoPenalty = undoCount * PENALTY_PER_UNDO;
  const hintPenalty = hintCount * PENALTY_PER_HINT;
  return Math.max(0, MAX_SCORE - timePenalty - undoPenalty - hintPenalty);
}

/**
 * Returns the canonical SOLUTION paths for the given date.
 * Index = colorId; each entry is the ordered list of cells that form
 * the solution route from one endpoint to the other.
 *
 * Solvability guarantee: paths are generated FIRST, then only the two
 * endpoints are exposed to the player.  Every cell is covered by
 * construction — the puzzle is always 100% solvable.
 */
export function getDailySolution(dateStr: string, mode: DifficultyMode = 'easy'): { x: number; y: number }[][] {
  const { gridSize, numColors } = gridConfigForMode(mode);
  const seed = dateToSeed(dateStr + ':' + mode);
  const rng  = mulberry32(seed);
  const { paths } = buildSolvedBoard(gridSize, numColors, rng);
  return paths.map(cells => cells.map(c => ({ x: c.x, y: c.y })));
}

export function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1_000);
  const m  = Math.floor(totalSec / 60);
  const s  = totalSec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Returns today's UTC date as YYYY-MM-DD. */
export function getTodayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns tomorrow's UTC date as YYYY-MM-DD. */
export function getTomorrowDateStr(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ═════════════════════════════════════════════════════════════════
//  Board Builder (internal)
// ═════════════════════════════════════════════════════════════════

interface SolvedBoard {
  /** colorGrid[y][x] = colour index (0…numColors-1). Never -1 after build. */
  colorGrid: number[][];
  /** paths[id] = ordered list of cells forming that colour's solution path. */
  paths: Cell[][];
}

/**
 * Build a solved board with GUARANTEED path contiguity.
 *
 * Mathematical guarantee: every path returned is a simple contiguous
 * chain of adjacent cells (each cell touches the next in 4-directional
 * Manhattan distance 1).  Therefore the puzzle is ALWAYS solvable —
 * the player reproduces the exact same chains.
 *
 * Strategy:
 *   Attempt the balanced round-robin algorithm up to MAX_ATTEMPTS times.
 *   On each failure (orphaned cells remain) advance the RNG stream by a
 *   deterministic amount so the next attempt starts with a fresh seed
 *   trajectory.  Both generateDailyPuzzle() and getDailySolution() call
 *   this function with identical RNG state, so they always agree.
 *   Puzzles that succeed on the first attempt are completely unaffected.
 *
 * Last resort: a boustrophedon (snake-row) board that is trivially
 *   solvable but never reached in practice.
 */
function buildSolvedBoard(size: number, numColors: number, rng: () => number): SolvedBoard {
  const MAX_ATTEMPTS = 40;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const colorGrid: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(-1));
    const paths: Cell[][] = Array.from({ length: numColors }, () => []);

    // ── Phase 1: Place well-separated seed cells ────────────────
    const seeds = pickWellSeparatedStarts(size, numColors, rng);
    for (let id = 0; id < numColors; id++) {
      const s = seeds[id]!;
      colorGrid[s.y]![s.x] = id;
      paths[id]!.push(s);
    }

    // ── Phase 2: Balanced round-robin growing ────────────────────
    // Paths grow strictly from their TAIL — this is the invariant that
    // guarantees contiguity.  Never extend from a middle cell.
    let unfilled = size * size - numColors;
    const maxIter = size * size * 80;

    for (let iter = 0; iter < maxIter && unfilled > 0; iter++) {
      const growable = Array.from({ length: numColors }, (_, id) => id).filter(id => {
        const tail = paths[id]![paths[id]!.length - 1]!;
        return getFreeNeighbors(tail, colorGrid, size).length > 0;
      });

      if (growable.length === 0) break; // all tails boxed in — retry

      growable.sort((a, b) => paths[a]!.length - paths[b]!.length);

      const minLen = paths[growable[0]!]!.length;
      const tier   = growable.filter(id => paths[id]!.length <= minLen + 1);
      const chosen = tier[Math.floor(rng() * tier.length)]!;
      const tail   = paths[chosen]![paths[chosen]!.length - 1]!;
      const nbrs   = getFreeNeighbors(tail, colorGrid, size);
      const next   = nbrs[Math.floor(rng() * nbrs.length)]!;

      colorGrid[next.y]![next.x] = chosen;
      paths[chosen]!.push(next);
      unfilled--;
    }

    // ── SUCCESS: every cell is owned, all paths contiguous ──────
    if (unfilled === 0) return { colorGrid, paths };

    // ── FAILURE: orphaned cells exist → advance the RNG stream ──
    // The burn amount is deterministic so both generator and solution
    // helper advance their shared RNG identically across retries.
    const burnCount = 13 + attempt * 11;
    for (let i = 0; i < burnCount; i++) rng();
  }

  // ── EMERGENCY FALLBACK (should never be reached in practice) ──
  // Boustrophedon (snake-row) decomposition: guaranteed full coverage
  // and contiguity.  Produces a boring but 100 % solvable puzzle.
  return buildSnakeBoard(size, numColors);
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Place N seeds ensuring each is at least ⌊size/√N⌋ – 1 Manhattan steps
 * from every already-placed seed.  Falls back to the next candidate if
 * the threshold cannot be met.
 */
function pickWellSeparatedStarts(size: number, n: number, rng: () => number): Cell[] {
  const all: Cell[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      all.push({ x, y });

  // Fisher-Yates shuffle using our seeded PRNG.
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = all[i]!; all[i] = all[j]!; all[j] = tmp;
  }

  const chosen: Cell[] = [];
  const threshold = Math.max(1, Math.floor(size / Math.sqrt(n)) - 1);

  for (const c of all) {
    if (chosen.length === n) break;
    const ok = chosen.length === 0 ||
      chosen.every(p => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) >= threshold);
    if (ok) chosen.push(c);
  }

  // If strict threshold couldn't seat all seeds, fill remaining slots.
  for (const c of all) {
    if (chosen.length >= n) break;
    if (!chosen.some(p => p.x === c.x && p.y === c.y)) chosen.push(c);
  }

  return chosen;
}

const DIRS: ReadonlyArray<Cell> = [
  { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
];

function getFreeNeighbors(cell: Cell, grid: number[][], size: number): Cell[] {
  return DIRS
    .map(d => ({ x: cell.x + d.x, y: cell.y + d.y }))
    .filter(({ x, y }) => x >= 0 && y >= 0 && x < size && y < size && grid[y]![x] === -1);
}

/**
 * Emergency snake-row board builder — only called when all random
 * attempts fail (effectively never in normal operation).
 *
 * Traverses the grid in boustrophedon order (left→right on even rows,
 * right→left on odd rows) and divides cells into numColors contiguous
 * segments of equal length.  The result is a valid, solvable puzzle
 * because each segment is a contiguous path by construction.
 */
function buildSnakeBoard(size: number, numColors: number): SolvedBoard {
  const colorGrid: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(-1));
  const paths: Cell[][] = Array.from({ length: numColors }, () => []);

  // Build the boustrophedon cell order.
  const order: Cell[] = [];
  for (let y = 0; y < size; y++) {
    for (let xi = 0; xi < size; xi++) {
      const x = y % 2 === 0 ? xi : size - 1 - xi;
      order.push({ x, y });
    }
  }

  const total   = size * size;
  const segLen  = Math.floor(total / numColors);
  const extra   = total % numColors; // first `extra` segments get one more cell

  let cellIdx = 0;
  for (let id = 0; id < numColors; id++) {
    const len = segLen + (id < extra ? 1 : 0);
    for (let j = 0; j < len; j++) {
      const c = order[cellIdx++]!;
      colorGrid[c.y]![c.x] = id;
      paths[id]!.push(c);
    }
  }

  return { colorGrid, paths };
}
