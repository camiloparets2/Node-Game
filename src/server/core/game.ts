// ═══════════════════════════════════════════════════════════════════
//  Schema Crisis — Redis State Layer
//
//  Redis Key Design (date-scoped, no post-id coupling):
//
//    schema:fame:{date}              Sorted set — score = timeMs (ASC).
//                                    Only zero-undo completions enter.
//    schema:shame:{date}             Sorted set — score = composite (DESC).
//                                    composite = undoCount * 1_000_000 + timeMs
//                                    ZREVRANGE → most-undos first.
//    schema:all:{date}               Sorted set — score = -gameScore (ASC).
//                                    Negative so ZRANGE returns highest first.
//    schema:completed:{date}:{user}  String — JSON CompletionRecord.
//                                    Acts as an idempotency gate: set ONCE.
//    schema:stats:{date}             Hash — totalPlayers, sumTimeMs, sumUndos.
//
//  Race-condition handling:
//    All writes are append-only sorted-set operations (ZADD) or
//    key-absent guards (redis.get → early-return).  Redis processes
//    commands serially on the server side, so ZADD is inherently
//    atomic.  The completion key is written only when redis.get
//    returns null; the tiny window between get and set is acceptable
//    for a game leaderboard (worst case: one extra entry per user).
// ═══════════════════════════════════════════════════════════════════

import { redis } from '@devvit/web/server';
import type { LeaderboardEntry, WallsResponse } from '../../shared/api';

// ── Key Factories ─────────────────────────────────────────────────
//
//  schema:fame:{date}              Sorted set — score = timeMs (ASC, fastest first).
//                                  Only zero-undo completions enter.
//  schema:shame:{date}             Sorted set — score = undoCount*1_000_000+timeMs (ASC).
//                                  ZREVRANGE → most-undos first.
//  schema:all:{date}               Sorted set — score = -gameScore (ASC → highest first).
//  schema:completed:{date}:{user}  String — JSON CompletionRecord (idempotency gate).
//  schema:stats:{date}             Hash — totalPlayers, sumTimeMs, sumUndos (daily aggregate).
//  schema:user_stats:{user}        Hash — lifetime: totalPlays, perfectClears, totalScore,
//                                  totalTimeMs, bestScore, lastPlayedDate.
const K = {
  fame       : (d: string, m = '')    => `schema:fame:${d}${m ? ':' + m : ''}`,
  shame      : (d: string, m = '')    => `schema:shame:${d}${m ? ':' + m : ''}`,
  all        : (d: string, m = '')    => `schema:all:${d}${m ? ':' + m : ''}`,
  completed  : (d: string, u: string, m = '') => `schema:completed:${d}:${u}${m ? ':' + m : ''}`,
  stats      : (d: string, m = '')    => `schema:stats:${d}${m ? ':' + m : ''}`,
  userStats  : (u: string)           => `schema:user_stats:${u}`,
} as const;

// ── Completion Record (stored as JSON string) ─────────────────────
interface CompletionRecord {
  score: number;
  timeMs: number;
  undoCount: number;
  hintCount: number;
  completedAt: string; // ISO timestamp
}

function getYesterdayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Public: Submit Score ──────────────────────────────────────────

export interface SubmitResult {
  alreadyCompleted: boolean;
  rank: number;
  fameRank?: number;
  shameRank?: number;
  totalPlayers: number;
  streak: { current: number; best: number };
}

export async function submitScore(
  date: string,
  username: string,
  score: number,
  timeMs: number,
  undoCount: number,
  hintCount: number,
  mode = '',
): Promise<SubmitResult> {
  const userStatsKey = K.userStats(username);

  // ── Idempotency check ────────────────────────────────────────
  const completedKey = K.completed(date, username, mode);
  const existing     = await redis.get(completedKey);
  if (existing !== null && existing !== undefined) {
    const stored = JSON.parse(existing) as CompletionRecord;
    const storedHints = stored.hintCount ?? 0;
    const isPerfect   = stored.undoCount === 0 && storedHints === 0;
    const [rank, total, fameRank, shameRank, curStreak, bestStreak] = await Promise.all([
      getRankAll(date, username, mode),
      redis.zCard(K.all(date, mode)),
      isPerfect ? getFameRank(date, username, mode)  : Promise.resolve(undefined),
      !isPerfect ? getShameRank(date, username, mode) : Promise.resolve(undefined),
      redis.hGet(userStatsKey, 'currentStreak'),
      redis.hGet(userStatsKey, 'bestStreak'),
    ]);
    return {
      alreadyCompleted: true, rank: rank ?? 1, fameRank, shameRank, totalPlayers: total,
      streak: { current: Number(curStreak ?? 1), best: Number(bestStreak ?? 1) },
    };
  }

  // ── Record completion ────────────────────────────────────────
  const record: CompletionRecord = {
    score, timeMs, undoCount, hintCount,
    completedAt: new Date().toISOString(),
  };
  await redis.set(completedKey, JSON.stringify(record));

  // ── Write to bipartite leaderboards ─────────────────────────
  await redis.zAdd(K.all(date, mode), { score: -score, member: username });

  const isPerfect = undoCount === 0 && hintCount === 0;
  let fameRank: number | undefined;
  let shameRank: number | undefined;

  if (isPerfect) {
    await redis.zAdd(K.fame(date, mode), { score: timeMs, member: username });
    fameRank = await getFameRank(date, username, mode);
  } else {
    const shameScore = (undoCount + hintCount) * 1_000_000 + timeMs;
    await redis.zAdd(K.shame(date, mode), { score: shameScore, member: username });
    shameRank = await getShameRank(date, username, mode);
  }

  // ── Read pre-existing user stats for streak calculation ──────
  const [oldLastPlayed, prevStreakRaw, prevBestStreakRaw, prevBestScoreRaw] = await Promise.all([
    redis.hGet(userStatsKey, 'lastPlayedDate'),
    redis.hGet(userStatsKey, 'currentStreak'),
    redis.hGet(userStatsKey, 'bestStreak'),
    redis.hGet(userStatsKey, 'bestScore'),
  ]);

  // Streak: consecutive days
  const yesterday     = getYesterdayStr(date);
  const currentStreak = oldLastPlayed === yesterday
    ? Number(prevStreakRaw ?? '0') + 1
    : 1;
  const bestStreak    = Math.max(currentStreak, Number(prevBestStreakRaw ?? '0'));
  const bestScore     = Math.max(score, Number(prevBestScoreRaw ?? '0'));

  // ── Update daily aggregate + lifetime user stats ─────────────
  const statsKey = K.stats(date, mode);
  await Promise.all([
    redis.hIncrBy(statsKey, 'totalPlayers', 1),
    redis.hIncrBy(statsKey, 'sumTimeMs', timeMs),
    redis.hIncrBy(statsKey, 'sumUndos', undoCount + hintCount),
    redis.hIncrBy(userStatsKey, 'totalPlays', 1),
    redis.hIncrBy(userStatsKey, 'totalScore', score),
    redis.hIncrBy(userStatsKey, 'totalTimeMs', timeMs),
    isPerfect ? redis.hIncrBy(userStatsKey, 'perfectClears', 1) : Promise.resolve(0),
    redis.hSet(userStatsKey, {
      lastPlayedDate: date,
      currentStreak:  String(currentStreak),
      bestStreak:     String(bestStreak),
      bestScore:      String(bestScore),
    }),
  ]);

  const [rank, totalPlayers] = await Promise.all([
    getRankAll(date, username, mode),
    redis.zCard(K.all(date, mode)),
  ]);

  return {
    alreadyCompleted: false, rank: rank ?? totalPlayers, fameRank, shameRank, totalPlayers,
    streak: { current: currentStreak, best: bestStreak },
  };
}

// ── Public: Check Completion ──────────────────────────────────────

export async function getCompletion(
  date: string,
  username: string,
  mode = '',
): Promise<{
  hasCompleted: boolean;
  entry?: LeaderboardEntry;
  streak?: { current: number; best: number };
}> {
  const [raw, curStreak, bestStreak] = await Promise.all([
    redis.get(K.completed(date, username, mode)),
    redis.hGet(K.userStats(username), 'currentStreak'),
    redis.hGet(K.userStats(username), 'bestStreak'),
  ]);

  const streak = {
    current: Number(curStreak ?? 1),
    best:    Number(bestStreak ?? 1),
  };

  if (!raw) return { hasCompleted: false, streak };

  const rec   = JSON.parse(raw) as CompletionRecord;
  const rank  = await getRankAll(date, username, mode);
  const total = await redis.zCard(K.all(date, mode));

  return {
    hasCompleted: true,
    streak,
    entry: {
      username,
      score:     rec.score,
      timeMs:    rec.timeMs,
      undoCount: rec.undoCount,
      rank:      rank ?? total,
    },
  };
}

// ── Public: Fetch Both Walls ──────────────────────────────────────

export async function getWalls(date: string, mode = ''): Promise<WallsResponse> {
  const [fameRaw, shameRaw, total] = await Promise.all([
    redis.zRange(K.fame(date, mode),  0, 9,  { by: 'rank' }),
    redis.zRange(K.shame(date, mode), 0, 9,  { by: 'rank', reverse: true }),
    redis.zCard(K.all(date, mode)),
  ]);

  const toFameEntry = (m: { member: string; score: number }, i: number): LeaderboardEntry => {
    const timeMs    = typeof m.score === 'number' ? m.score : Number(m.score);
    return {
      username:  m.member,
      score:     Math.max(0, 10_000 - Math.floor(timeMs / 1_000) * 10),
      timeMs,
      undoCount: 0,
      rank: i + 1,
    };
  };

  const toShameEntry = (m: { member: string; score: number }, i: number): LeaderboardEntry => {
    const composite = typeof m.score === 'number' ? m.score : Number(m.score);
    const undoCount = Math.floor(composite / 1_000_000);
    const timeMs    = composite % 1_000_000;
    return {
      username: m.member,
      score:    Math.max(0, 10_000 - Math.floor(timeMs / 1_000) * 10 - undoCount * 200),
      timeMs,
      undoCount,
      rank: i + 1,
    };
  };

  return {
    fame:         fameRaw.map(toFameEntry),
    shame:        shameRaw.map(toShameEntry),
    totalPlayers: total,
  };
}

// ── Internal: Rank Helpers ────────────────────────────────────────

async function getRankAll(date: string, username: string, mode = ''): Promise<number | undefined> {
  try {
    const r = await redis.zRank(K.all(date, mode), username);
    return r != null ? r + 1 : undefined;
  } catch { return undefined; }
}

async function getFameRank(date: string, username: string, mode = ''): Promise<number | undefined> {
  try {
    const r = await redis.zRank(K.fame(date, mode), username);
    return r != null ? r + 1 : undefined;
  } catch { return undefined; }
}

async function getShameRank(date: string, username: string, mode = ''): Promise<number | undefined> {
  try {
    // Shame is sorted ascending; shame rank = position from the END.
    const total = await redis.zCard(K.shame(date, mode));
    const r     = await redis.zRank(K.shame(date, mode), username);
    return r != null ? total - r : undefined;
  } catch { return undefined; }
}
