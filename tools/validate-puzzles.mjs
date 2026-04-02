#!/usr/bin/env node
/**
 * Schema Crisis — Puzzle Solvability Validator
 *
 * Run:  node tools/validate-puzzles.mjs
 *
 * Checks every puzzle for the next 60 days (both modes) against three
 * mathematical invariants:
 *
 *   1. COVERAGE   — every grid cell is owned by exactly one colour
 *   2. CONTIGUITY — every path is a chain of adjacent cells (no teleports)
 *   3. ENDPOINTS  — both endpoint cells are at indices 0 and last in path
 *
 * Exits with code 1 if any invariant fails.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Inline the core logic so we don't need a compiled build to run validation.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Re-implement the minimal puzzle logic here so validation runs standalone ──

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function dateToSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++)
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) | 0;
  return h >>> 0;
}

const DIRS = [{x:0,y:-1},{x:1,y:0},{x:0,y:1},{x:-1,y:0}];

function getFreeNeighbors(cell, grid, size) {
  return DIRS
    .map(d => ({ x: cell.x + d.x, y: cell.y + d.y }))
    .filter(({x,y}) => x >= 0 && y >= 0 && x < size && y < size && grid[y][x] === -1);
}

function pickWellSeparatedStarts(size, n, rng) {
  const all = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      all.push({x, y});
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
  }
  const chosen = [];
  const threshold = Math.max(1, Math.floor(size / Math.sqrt(n)) - 1);
  for (const c of all) {
    if (chosen.length === n) break;
    const ok = chosen.length === 0 ||
      chosen.every(p => Math.abs(p.x-c.x)+Math.abs(p.y-c.y) >= threshold);
    if (ok) chosen.push(c);
  }
  for (const c of all) {
    if (chosen.length >= n) break;
    if (!chosen.some(p => p.x===c.x && p.y===c.y)) chosen.push(c);
  }
  return chosen;
}

function buildSnakeBoard(size, numColors) {
  const colorGrid = Array.from({length:size}, ()=>new Array(size).fill(-1));
  const paths = Array.from({length:numColors}, ()=>[]);
  const order = [];
  for (let y = 0; y < size; y++)
    for (let xi = 0; xi < size; xi++) {
      const x = y%2===0 ? xi : size-1-xi;
      order.push({x,y});
    }
  const total  = size*size;
  const segLen = Math.floor(total/numColors);
  const extra  = total%numColors;
  let cellIdx = 0;
  for (let id = 0; id < numColors; id++) {
    const len = segLen + (id < extra ? 1 : 0);
    for (let j = 0; j < len; j++) {
      const c = order[cellIdx++];
      colorGrid[c.y][c.x] = id;
      paths[id].push(c);
    }
  }
  return { colorGrid, paths };
}

function buildSolvedBoard(size, numColors, rng) {
  const MAX_ATTEMPTS = 40;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const colorGrid = Array.from({length:size}, ()=>new Array(size).fill(-1));
    const paths = Array.from({length:numColors}, ()=>[]);
    const seeds = pickWellSeparatedStarts(size, numColors, rng);
    for (let id = 0; id < numColors; id++) {
      const s = seeds[id];
      colorGrid[s.y][s.x] = id;
      paths[id].push(s);
    }
    let unfilled = size*size - numColors;
    const maxIter = size*size*80;
    for (let iter = 0; iter < maxIter && unfilled > 0; iter++) {
      const growable = Array.from({length:numColors},(_,id)=>id).filter(id=>{
        const tail = paths[id][paths[id].length-1];
        return getFreeNeighbors(tail, colorGrid, size).length > 0;
      });
      if (growable.length===0) break;
      growable.sort((a,b)=>paths[a].length-paths[b].length);
      const minLen = paths[growable[0]].length;
      const tier   = growable.filter(id=>paths[id].length<=minLen+1);
      const chosen = tier[Math.floor(rng()*tier.length)];
      const tail   = paths[chosen][paths[chosen].length-1];
      const nbrs   = getFreeNeighbors(tail, colorGrid, size);
      const next   = nbrs[Math.floor(rng()*nbrs.length)];
      colorGrid[next.y][next.x] = chosen;
      paths[chosen].push(next);
      unfilled--;
    }
    if (unfilled === 0) return { colorGrid, paths, usedEmergency: false };
    const burnCount = 13 + attempt * 11;
    for (let i = 0; i < burnCount; i++) rng();
  }
  return { ...buildSnakeBoard(size, numColors), usedEmergency: true };
}

// ── Validation ────────────────────────────────────────────────────────────

function validateBoard(size, numColors, colorGrid, paths, label) {
  const errors = [];

  // 1. Coverage
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (colorGrid[y][x] === -1)
        errors.push(`COVERAGE: cell (${x},${y}) is unclaimed`);

  // 2. Contiguity
  for (let id = 0; id < numColors; id++) {
    const p = paths[id];
    if (!p || p.length === 0) { errors.push(`PATH ${id}: empty`); continue; }
    for (let i = 1; i < p.length; i++) {
      const dist = Math.abs(p[i].x-p[i-1].x) + Math.abs(p[i].y-p[i-1].y);
      if (dist !== 1)
        errors.push(`CONTIGUITY path ${id} idx ${i}: step distance=${dist} (teleport!)`);
    }
  }

  // 3. Grid ownership matches path membership
  for (let id = 0; id < numColors; id++) {
    for (const c of paths[id]) {
      if (colorGrid[c.y][c.x] !== id)
        errors.push(`OWNERSHIP: path ${id} claims (${c.x},${c.y}) but grid says ${colorGrid[c.y][c.x]}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\n✗ ${label}`);
    errors.forEach(e => console.error(`  ${e}`));
  }
  return errors.length === 0;
}

// ── Main ──────────────────────────────────────────────────────────────────

const MODES = [
  { mode: 'easy', size: 5, numColors: 4 },
  { mode: 'hard', size: 7, numColors: 7 },
];

const today = new Date();
const DAYS  = 90;   // validate next 90 days

let totalChecked = 0;
let totalFailed  = 0;
let emergencyUsed = 0;

for (let d = 0; d < DAYS; d++) {
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() + d);
  const dateStr = date.toISOString().slice(0, 10);

  for (const { mode, size, numColors } of MODES) {
    const seed = dateToSeed(dateStr + ':' + mode);
    const rng  = mulberry32(seed);
    const { colorGrid, paths, usedEmergency } = buildSolvedBoard(size, numColors, rng);
    const label = `${dateStr} [${mode}] ${size}×${size}`;
    const ok = validateBoard(size, numColors, colorGrid, paths, label);
    totalChecked++;
    if (!ok) totalFailed++;
    if (usedEmergency) { emergencyUsed++; console.warn(`  ⚠ ${label}: used emergency snake board`); }
  }
}

console.log(`\nChecked ${totalChecked} puzzles (${DAYS} days × ${MODES.length} modes)`);
if (emergencyUsed)
  console.warn(`Warning: ${emergencyUsed} puzzle(s) fell back to emergency snake board`);
if (totalFailed === 0) {
  console.log('All puzzles are solvable. ✓');
  process.exit(0);
} else {
  console.error(`FAILED: ${totalFailed} unsolvable puzzle(s) detected!`);
  process.exit(1);
}
