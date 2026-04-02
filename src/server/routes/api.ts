// ═══════════════════════════════════════════════════════════════════
//  Schema Crisis — API Routes
//
//  GET  /api/init    → puzzle data + leaderboards + completion state
//  POST /api/score   → record a completion (idempotent)
//  POST /api/share   → publish a viral score post to the subreddit
// ═══════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
import { submitScore, getCompletion, getWalls } from '../core/game';
import { generateDailyPuzzle, getTodayDateStr, formatTime } from '../../shared/puzzle';
import type {
  InitResponse,
  ScoreSubmitRequest,
  ScoreSubmitResponse,
  ShareRequest,
  ShareResponse,
} from '../../shared/api';

export const api = new Hono();

// ── GET /api/init ─────────────────────────────────────────────────
api.get('/init', async (c) => {
  const username = context.username ?? 'anon';
  const date     = getTodayDateStr();
  const mode     = (c.req.query('mode') === 'hard' ? 'hard' : 'easy') as import('../../shared/api').DifficultyMode;

  // All three async operations run in parallel.
  const [completionResult, walls, puzzle] = await Promise.all([
    getCompletion(date, username, mode),
    getWalls(date, mode),
    Promise.resolve(generateDailyPuzzle(date, mode)),
  ]);

  return c.json<InitResponse>({
    type: 'init',
    puzzle,
    username,
    hasCompleted:  completionResult.hasCompleted,
    previousEntry: completionResult.entry,
    walls,
    streak:        completionResult.streak,
  }, 200);
});

// ── POST /api/score ───────────────────────────────────────────────
api.post('/score', async (c) => {
  const username = context.username ?? 'anon';
  const body     = await c.req.json<ScoreSubmitRequest>();

  // Guard: only accept submissions for today's puzzle.
  const today = getTodayDateStr();
  if (body.date !== today) {
    return c.json<ScoreSubmitResponse>({
      type: 'score',
      success: false,
      alreadyCompleted: false,
      totalPlayers: 0,
      message: 'Submission is for a past puzzle — not recorded.',
    }, 400);
  }

  const mode = body.mode ?? 'easy';
  const result = await submitScore(
    today, username, body.score, body.timeMs, body.undoCount, body.hintCount ?? 0, mode,
  );

  return c.json<ScoreSubmitResponse>({
    type: 'score',
    success: true,
    alreadyCompleted: result.alreadyCompleted,
    rank:         result.rank,
    fameRank:     result.fameRank,
    shameRank:    result.shameRank,
    totalPlayers: result.totalPlayers,
    streak:       result.streak,
    message: result.alreadyCompleted
      ? 'You already solved today\'s puzzle — score not changed.'
      : `Rank #${result.rank} of ${result.totalPlayers} today!`,
  }, 200);
});

// ── POST /api/share ───────────────────────────────────────────────
// Creates a new Schema Crisis post in the subreddit — the viral loop.
// Each shared score becomes a fully playable game post for others.
api.post('/share', async (c) => {
  const username = context.username ?? 'anon';
  const subreddit = context.subredditName ?? 'unknown';
  const body      = await c.req.json<ShareRequest>();

  const timeStr  = formatTime(body.timeMs);
  const modeLabel = body.mode === 'hard' ? 'HARD' : 'EASY';
  const undoText = body.undoCount === 0 ? 'ZERO errors' : `${body.undoCount} undo${body.undoCount > 1 ? 's' : ''}`;
  const rankText = body.rank ? ` · Rank #${body.rank}` : '';
  const title    = `Schema Crisis [${modeLabel}] · u/${username} scored ${body.score.toLocaleString()} in ${timeStr} (${undoText})${rankText} · Can you beat it?`;

  try {
    const post = await reddit.submitCustomPost({ title });
    const postUrl = `https://www.reddit.com/r/${subreddit}/comments/${post.id}`;
    return c.json<ShareResponse>({ type: 'share', success: true, postUrl, message: 'Posted!' }, 200);
  } catch (err) {
    console.error('[share] Failed to create post:', err);
    return c.json<ShareResponse>({ type: 'share', success: false, message: 'Could not post — try again.' }, 500);
  }
});
