// ═══════════════════════════════════════════════════════════════════
//  Schema Crisis — Shared API Contract
//  All types crossing the client ↔ server boundary live here.
// ═══════════════════════════════════════════════════════════════════

/** Difficulty mode — determines grid size and colour count. */
export type DifficultyMode = 'easy' | 'hard';

/** A single endpoint node on the puzzle grid (one half of a colour pair). */
export interface PuzzleNode {
  /** Colour-pair index — both nodes of a pair share the same id. */
  id: number;
  /** Column (0-indexed, left→right). */
  x: number;
  /** Row (0-indexed, top→bottom). */
  y: number;
  /** Hex colour string, e.g. '#FF4444'. */
  color: string;
  /** Human-readable colour name, e.g. 'RED'. */
  colorName: string;
}

/** Full specification of one day's puzzle (endpoints only — no solution paths). */
export interface DailyPuzzle {
  /** ISO date string YYYY-MM-DD — also used as the deterministic seed. */
  date: string;
  /** N for an N×N grid. */
  gridSize: number;
  /** Number of distinct colour pairs. */
  numColors: number;
  /**
   * Exactly 2 × numColors nodes.  Both nodes that share an `id` must be
   * connected by the player using a continuous, non-intersecting path.
   * All grid cells must be covered.
   */
  nodes: PuzzleNode[];
  /** Difficulty mode this puzzle was generated for. */
  mode: DifficultyMode;
}

/** One row on either leaderboard. */
export interface LeaderboardEntry {
  username: string;
  /** Computed game score (0 – 10 000). */
  score: number;
  /** Wall-clock milliseconds from puzzle-display to completion. */
  timeMs: number;
  /** Total undo / clear-board actions taken. */
  undoCount: number;
  /** 1-indexed position on the relevant board. */
  rank: number;
}

/**
 * Both bipartite leaderboards for a given day.
 *
 * Wall of Fame  — fastest completions with zero undos (perfect runs).
 * Wall of Shame — most undo/clear actions, tiebroken by slowest time.
 */
export interface WallsResponse {
  fame: LeaderboardEntry[];
  shame: LeaderboardEntry[];
  totalPlayers: number;
}

// ── GET /api/init ────────────────────────────────────────────────────

export interface InitResponse {
  type: 'init';
  puzzle: DailyPuzzle;
  username: string;
  /** True when this user already submitted a score for today's puzzle. */
  hasCompleted: boolean;
  /** The user's existing entry, populated when hasCompleted is true. */
  previousEntry?: LeaderboardEntry;
  walls: WallsResponse;
  /** Consecutive-day play streak for this user. */
  streak?: { current: number; best: number };
}

// ── POST /api/score ──────────────────────────────────────────────────

export interface ScoreSubmitRequest {
  date: string;
  mode: DifficultyMode;
  timeMs: number;
  undoCount: number;
  hintCount: number;
  score: number;
}

export interface ScoreSubmitResponse {
  type: 'score';
  success: boolean;
  /** True when the user already had a recorded score — not re-recorded. */
  alreadyCompleted: boolean;
  /** Overall rank among all players today. */
  rank?: number;
  /** Rank on the Wall of Fame (present only when undoCount === 0 and hintCount === 0). */
  fameRank?: number;
  /** Rank on the Wall of Shame (present only when undoCount > 0 or hintCount > 0). */
  shameRank?: number;
  totalPlayers: number;
  message: string;
  /** Updated streak after this submission. */
  streak?: { current: number; best: number };
}

// ── POST /api/share ──────────────────────────────────────────────────

export interface ShareRequest {
  date: string;
  mode: DifficultyMode;
  score: number;
  timeMs: number;
  undoCount: number;
  rank?: number;
}

export interface ShareResponse {
  type: 'share';
  success: boolean;
  postUrl?: string;
  message: string;
}
