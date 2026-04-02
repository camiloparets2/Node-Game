// ═══════════════════════════════════════════════════════════════════
//  Schema Crisis — Splash Screen (Redesigned for Reddit Engagement)
//
//  Full-screen animated gameplay trailer:  solution paths draw
//  themselves across the grid in a looping demo, cells illuminate
//  as paths flow through them, creating a scroll-stopping effect.
// ═══════════════════════════════════════════════════════════════════

import { requestExpandedMode } from '@devvit/web/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  generateDailyPuzzle,
  getDailySolution,
  getTodayDateStr,
  COLOR_PALETTE,
} from '../shared/puzzle';

// ── Constants ────────────────────────────────────────────────────
const DATE     = getTodayDateStr();
const PUZZLE   = generateDailyPuzzle(DATE);
const SOLUTION = getDailySolution(DATE);

const FONT = "'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const MONO = "'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace";

// ── Difficulty ───────────────────────────────────────────────────
function getDifficulty() {
  const dow = new Date(`${DATE}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return { label: 'HARD',   color: '#FF4444' };
  if (dow === 3)               return { label: 'MEDIUM', color: '#FFE044' };
  return                              { label: 'EASY',   color: '#44FF88' };
}
const DIFF = getDifficulty();

// ── Grid geometry ────────────────────────────────────────────────
const { gridSize, numColors } = PUZZLE;
const GAP  = 2;
const CELL = Math.max(14, Math.min(28, Math.floor(190 / gridSize) - GAP));
const GRID_PX = CELL * gridSize + GAP * (gridSize - 1);

// ── Animation timing ─────────────────────────────────────────────
const CYCLE_S    = 13;    // full loop duration
const STAGGER_S  = 0.45;  // delay between each colour's draw
const DRAW_PCT   = 18;    // % of cycle spent drawing one path

// ── SVG path data ────────────────────────────────────────────────
const svgPaths = SOLUTION.map((path, ci) => {
  const points = path.map(({ x, y }) =>
    `${x * (CELL + GAP) + CELL / 2},${y * (CELL + GAP) + CELL / 2}`
  ).join(' ');

  let length = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = (path[i]!.x - path[i - 1]!.x) * (CELL + GAP);
    const dy = (path[i]!.y - path[i - 1]!.y) * (CELL + GAP);
    length += Math.sqrt(dx * dx + dy * dy);
  }

  return {
    points,
    length: Math.ceil(length) + 2,
    color: COLOR_PALETTE[ci]!.hex,
    delay: ci * STAGGER_S,
  };
});

// ── Cell glow map — "x,y" → { color, delay } ────────────────────
const cellGlowMap = new Map<string, { color: string; delay: number }>();
const DRAW_TIME_S = (DRAW_PCT / 100) * CYCLE_S; // ~2.34s

SOLUTION.forEach((path, ci) => {
  const base = ci * STAGGER_S;
  path.forEach((cell, idx) => {
    const t = base + (idx / Math.max(1, path.length - 1)) * DRAW_TIME_S;
    cellGlowMap.set(`${cell.x},${cell.y}`, {
      color: COLOR_PALETTE[ci]!.hex,
      delay: t,
    });
  });
});

// ── Node lookup ──────────────────────────────────────────────────
const nodeMap = new Map(PUZZLE.nodes.map(n => [`${n.x},${n.y}`, n]));

// ── Dynamic keyframes (one per SVG path) ─────────────────────────
const drawKeyframes = svgPaths.map((p, i) => `
  @keyframes draw${i} {
    0%   { stroke-dashoffset: ${p.length}; opacity: 0; }
    2%   { stroke-dashoffset: ${p.length}; opacity: 0.9; }
    ${DRAW_PCT}%  { stroke-dashoffset: 0; opacity: 0.9; }
    68%  { stroke-dashoffset: 0; opacity: 0.8; }
    80%  { opacity: 0; stroke-dashoffset: 0; }
    81%  { stroke-dashoffset: ${p.length}; opacity: 0; }
    100% { stroke-dashoffset: ${p.length}; opacity: 0; }
  }`).join('\n');

// ── Global styles ────────────────────────────────────────────────
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap');

  ${drawKeyframes}

  @keyframes cellGlow {
    0%, 1% { opacity: 0; }
    6%     { opacity: 0.5; }
    60%    { opacity: 0.35; }
    76%    { opacity: 0; }
    100%   { opacity: 0; }
  }

  @keyframes nodePulse {
    0%, 100% { transform: scale(1);    filter: brightness(1); }
    50%      { transform: scale(1.18); filter: brightness(1.35); }
  }

  @keyframes scanline {
    0%   { transform: translateY(-100%); }
    100% { transform: translateY(400%); }
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @keyframes shimmer {
    0%   { background-position: -400% center; }
    100% { background-position:  400% center; }
  }

  @keyframes ctaGlow {
    0%, 100% { box-shadow: 0 0 20px rgba(68,255,238,0.3),  0 0 40px rgba(68,255,238,0.08); }
    50%      { box-shadow: 0 0 32px rgba(68,255,238,0.55), 0 0 64px rgba(68,255,238,0.16); }
  }

  @keyframes gridPulse {
    0%, 100% { opacity: 0.04; }
    50%      { opacity: 0.08; }
  }

  @keyframes cornerFlicker {
    0%, 90%, 100% { opacity: 0.6; }
    93%           { opacity: 0.2; }
    96%           { opacity: 0.8; }
  }

  .cta-btn {
    transition: transform 0.12s ease, filter 0.12s ease;
  }
  .cta-btn:hover  { transform: scale(1.06) !important; filter: brightness(1.2); }
  .cta-btn:active { transform: scale(0.96) !important; }
`;

// ── HUD corner bracket ───────────────────────────────────────────
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

// ── Splash ───────────────────────────────────────────────────────
const Splash = () => {
  return (
    <div
      onClick={e => requestExpandedMode(e.nativeEvent, 'game')}
      style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100vh',
        background: 'linear-gradient(165deg, #050810 0%, #080d1e 40%, #06091a 70%, #040710 100%)',
        fontFamily: FONT,
        userSelect: 'none', position: 'relative', overflow: 'hidden',
        cursor: 'pointer',
      }}
    >
      <style>{STYLES}</style>

      {/* ── Background: dot grid ── */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: 'radial-gradient(circle, rgba(68,255,238,0.08) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
        animation: 'gridPulse 4s ease-in-out infinite',
      }} />

      {/* ── Background: ambient colour blobs ── */}
      <div style={{
        position: 'absolute', top: '-15%', right: '-10%',
        width: '55%', height: '55%', borderRadius: '50%', pointerEvents: 'none',
        background: 'radial-gradient(circle, rgba(187,68,255,0.12) 0%, transparent 65%)',
      }} />
      <div style={{
        position: 'absolute', bottom: '-20%', left: '-12%',
        width: '50%', height: '50%', borderRadius: '50%', pointerEvents: 'none',
        background: 'radial-gradient(circle, rgba(68,136,255,0.10) 0%, transparent 65%)',
      }} />
      <div style={{
        position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)',
        width: '45%', height: '45%', borderRadius: '50%', pointerEvents: 'none',
        background: 'radial-gradient(circle, rgba(68,255,238,0.05) 0%, transparent 60%)',
      }} />

      {/* ── Background: scanline sweep ── */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: '2px', pointerEvents: 'none',
        background: 'linear-gradient(90deg, transparent 5%, rgba(68,255,238,0.18) 30%, rgba(68,255,238,0.25) 50%, rgba(68,255,238,0.18) 70%, transparent 95%)',
        animation: 'scanline 4.5s linear infinite',
      }} />

      {/* ── Background: vignette ── */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)',
      }} />

      {/* ════════════════════════════════════════════════════════════
          CONTENT — centered, stacked
          ════════════════════════════════════════════════════════════ */}

      {/* ── Title ── */}
      <h1 style={{
        margin: 0, zIndex: 1,
        fontSize: 'clamp(19px, 5.5vw, 28px)',
        fontFamily: "'Orbitron', " + FONT,
        fontWeight: 900,
        letterSpacing: 6,
        background: 'linear-gradient(135deg, #44ffee 0%, #4488ff 35%, #bb44ff 65%, #ff44bb 85%, #44ffee 100%)',
        backgroundSize: '400% auto',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        animation: 'fadeUp 0.5s ease both, shimmer 5s linear infinite',
        textShadow: 'none',
        filter: 'drop-shadow(0 0 20px rgba(68,255,238,0.3))',
      }}>
        SCHEMA CRISIS
      </h1>

      {/* ── Date + Difficulty + Grid spec ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        margin: '5px 0 14px', zIndex: 1,
        animation: 'fadeUp 0.5s ease 0.08s both',
      }}>
        <span style={{
          fontSize: 9, color: '#44ffee', opacity: 0.5,
          letterSpacing: 3, fontWeight: 700, fontFamily: MONO,
        }}>
          {DATE}
        </span>
        <span style={{
          fontSize: 8, padding: '2px 9px', borderRadius: 10,
          fontWeight: 800, letterSpacing: 2,
          color: DIFF.color,
          background: `${DIFF.color}12`,
          border: `1px solid ${DIFF.color}35`,
          boxShadow: `0 0 14px ${DIFF.color}18`,
        }}>
          {DIFF.label}
        </span>
        <span style={{
          fontSize: 9, color: '#3a4068', letterSpacing: 2, fontWeight: 600,
        }}>
          {gridSize}×{gridSize} · {numColors} PATHS
        </span>
      </div>

      {/* ════════════════════════════════════════════════════════════
          ANIMATED GRID — the hero
          ════════════════════════════════════════════════════════════ */}
      <div style={{
        position: 'relative', zIndex: 1,
        animation: 'fadeUp 0.5s ease 0.14s both',
      }}>
        {/* Glow halo behind grid */}
        <div style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: GRID_PX * 2, height: GRID_PX * 2,
          borderRadius: '50%', pointerEvents: 'none',
          background: 'radial-gradient(circle, rgba(68,255,238,0.06) 0%, rgba(68,136,255,0.03) 35%, transparent 65%)',
        }} />

        {/* HUD frame corners */}
        <Corner top left />
        <Corner top right />
        <Corner bottom left />
        <Corner bottom right />

        {/* Grid cells */}
        <div style={{
          position: 'relative',
          display: 'inline-grid',
          gridTemplateColumns: `repeat(${gridSize}, ${CELL}px)`,
          gridTemplateRows:    `repeat(${gridSize}, ${CELL}px)`,
          gap: GAP,
        }}>
          {Array.from({ length: gridSize * gridSize }, (_, i) => {
            const x    = i % gridSize;
            const y    = Math.floor(i / gridSize);
            const node = nodeMap.get(`${x},${y}`);
            const glow = cellGlowMap.get(`${x},${y}`);

            return (
              <div key={i} style={{ position: 'relative', width: CELL, height: CELL }}>
                {/* Base cell */}
                <div style={{
                  position: 'absolute', inset: 0,
                  borderRadius: node ? '50%' : 2,
                  background: node ? node.color : 'rgba(255,255,255,0.03)',
                  border: node
                    ? `1.5px solid ${node.color}`
                    : '1px solid rgba(255,255,255,0.04)',
                  boxShadow: node
                    ? `0 0 10px ${node.color}88, inset 0 0 4px ${node.color}44`
                    : 'none',
                  zIndex: 2,
                  animation: node
                    ? `nodePulse 2.5s ease-in-out infinite ${node.id * 0.25}s`
                    : 'none',
                }} />
                {/* Path-cell glow overlay */}
                {glow && !node && (
                  <div style={{
                    position: 'absolute', inset: 0,
                    borderRadius: 2,
                    background: glow.color,
                    opacity: 0,
                    animation: `cellGlow ${CYCLE_S}s ease infinite ${glow.delay}s`,
                    pointerEvents: 'none',
                    zIndex: 1,
                  }} />
                )}
              </div>
            );
          })}

          {/* SVG path overlay */}
          <svg
            width={GRID_PX}
            height={GRID_PX}
            viewBox={`0 0 ${GRID_PX} ${GRID_PX}`}
            style={{
              position: 'absolute', top: 0, left: 0,
              pointerEvents: 'none', zIndex: 3,
            }}
          >
            {svgPaths.map((p, i) => (
              <g key={i}>
                {/* Outer glow */}
                <polyline
                  points={p.points}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={CELL * 0.55}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={p.length}
                  strokeDashoffset={p.length}
                  opacity={0.15}
                  style={{
                    animation: `draw${i} ${CYCLE_S}s ease-in-out ${p.delay}s infinite`,
                  }}
                />
                {/* Main pipe */}
                <polyline
                  points={p.points}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={CELL * 0.35}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={p.length}
                  strokeDashoffset={p.length}
                  style={{
                    animation: `draw${i} ${CYCLE_S}s ease-in-out ${p.delay}s infinite`,
                  }}
                />
                {/* Inner highlight */}
                <polyline
                  points={p.points}
                  fill="none"
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth={CELL * 0.1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={p.length}
                  strokeDashoffset={p.length}
                  style={{
                    animation: `draw${i} ${CYCLE_S}s ease-in-out ${p.delay}s infinite`,
                  }}
                />
              </g>
            ))}
          </svg>
        </div>
      </div>

      {/* ── Tagline ── */}
      <p style={{
        margin: '14px 0 4px', zIndex: 1,
        fontSize: 11, color: '#8890b8',
        letterSpacing: 3, fontWeight: 600,
        animation: 'fadeUp 0.5s ease 0.2s both',
      }}>
        CONNECT · FILL · PROVE IT
      </p>

      {/* ── CTA Button ── */}
      <button
        className="cta-btn"
        onClick={e => {
          e.stopPropagation();
          requestExpandedMode(e.nativeEvent, 'game');
        }}
        style={{
          marginTop: 6, padding: '12px 30px',
          background: 'linear-gradient(135deg, rgba(68,255,238,0.18) 0%, rgba(68,136,255,0.18) 100%)',
          color: '#44ffee',
          border: '1.5px solid rgba(68,255,238,0.55)',
          borderRadius: 10,
          fontSize: 12, fontWeight: 800, letterSpacing: 4,
          fontFamily: "'Orbitron', " + FONT,
          cursor: 'pointer',
          zIndex: 1,
          animation: 'fadeUp 0.5s ease 0.26s both, ctaGlow 3s ease-in-out infinite 1.5s',
        }}
      >
        ▶ PLAY NOW
      </button>

      {/* ── Feature pills ── */}
      <div style={{
        display: 'flex', gap: 6, marginTop: 10, zIndex: 1,
        animation: 'fadeUp 0.5s ease 0.32s both',
      }}>
        {[
          { icon: '★', text: 'Fame',  color: '#FFE044' },
          { icon: '☠', text: 'Shame', color: '#FF5555' },
          { icon: '⇧', text: 'Share', color: '#44ffee' },
        ].map(f => (
          <span key={f.text} style={{
            fontSize: 8, padding: '3px 9px', borderRadius: 9,
            background: `${f.color}08`,
            border: `1px solid ${f.color}20`,
            color: `${f.color}99`,
            fontWeight: 700, letterSpacing: 1.5,
          }}>
            {f.icon} {f.text}
          </span>
        ))}
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<StrictMode><Splash /></StrictMode>);
