import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Users, Bot, BookOpen, Trophy, Volume2, VolumeX, Moon, Sun, RotateCcw,
  Play, X, ChevronRight, ChevronLeft, Crown, Info, Wifi, WifiOff,
  Swords, Target, Shield, Sparkles, ArrowLeft, Check, Copy, Clock, Loader2
} from "lucide-react";
import { isSupabaseConfigured } from "./lib/supabase";
import { createRoom, joinRoom, pushRoomState, leaveRoom, subscribeToRoom } from "./lib/rooms";

/* =========================================================================
   ENGINE  —  pure, UI-independent Mlabalaba (Morabaraba-family) rules
   ========================================================================= */

const POINTS = [
  { x: 50, y: 50 }, { x: 300, y: 50 }, { x: 550, y: 50 },
  { x: 550, y: 300 }, { x: 550, y: 550 }, { x: 300, y: 550 },
  { x: 50, y: 550 }, { x: 50, y: 300 },
  { x: 150, y: 150 }, { x: 300, y: 150 }, { x: 450, y: 150 },
  { x: 450, y: 300 }, { x: 450, y: 450 }, { x: 300, y: 450 },
  { x: 150, y: 450 }, { x: 150, y: 300 },
  { x: 250, y: 250 }, { x: 300, y: 250 }, { x: 350, y: 250 },
  { x: 350, y: 300 }, { x: 350, y: 350 }, { x: 300, y: 350 },
  { x: 250, y: 350 }, { x: 250, y: 300 },
];

const RING_EDGES = [
  [0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,0],
  [8,9],[9,10],[10,11],[11,12],[12,13],[13,14],[14,15],[15,8],
  [16,17],[17,18],[18,19],[19,20],[20,21],[21,22],[22,23],[23,16],
];
const CROSS_EDGES = [[1,9],[9,17],[3,11],[11,19],[5,13],[13,21],[7,15],[15,23]];
const DIAG_EDGES = [[0,8],[8,16],[2,10],[10,18],[4,12],[12,20],[6,14],[14,22]];
const ALL_EDGES = [...RING_EDGES, ...CROSS_EDGES, ...DIAG_EDGES];

const MILLS = [
  [0,1,2],[2,3,4],[4,5,6],[6,7,0],
  [8,9,10],[10,11,12],[12,13,14],[14,15,8],
  [16,17,18],[18,19,20],[20,21,22],[22,23,16],
  [1,9,17],[3,11,19],[5,13,21],[7,15,23],
  [0,8,16],[2,10,18],[4,12,20],[6,14,22],
];

const ADJACENCY = Array.from({ length: 24 }, () => new Set<number>());
ALL_EDGES.forEach(([a, b]) => { ADJACENCY[a].add(b); ADJACENCY[b].add(a); });

const PIECES_PER_PLAYER = 12;
const OPP = (p) => (p === "P1" ? "P2" : "P1");

function createInitialState() {
  return {
    points: Array(24).fill(null),
    phase: "placement",
    placedCount: { P1: 0, P2: 0 },
    capturedCount: { P1: 0, P2: 0 }, // pieces THIS player has LOST
    capturedBy: { P1: [], P2: [] }, // pieces this player has TAKEN (opponent's color)
    millsFormed: { P1: 0, P2: 0 },
    currentPlayer: "P1",
    selected: null,
    pendingCapture: false,
    lastMillPoints: [],
    lastMoved: null,
    moveHistory: [],
    gameOver: null,
    moveCount: 0,
  };
}

function totalOwned(state, player) {
  return PIECES_PER_PLAYER - state.capturedCount[player];
}

function onBoardCount(state, player) {
  return state.points.filter((p) => p === player).length;
}

function millPointsFor(points, player) {
  const set = new Set();
  MILLS.forEach((line) => {
    if (line.every((i) => points[i] === player)) line.forEach((i) => set.add(i));
  });
  return set;
}

function isFlying(state, player) {
  return state.phase === "movement" && onBoardCount(state, player) === 3;
}

function getLegalPlacements(state) {
  if (state.phase !== "placement") return [];
  return state.points.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
}

function getLegalDestinations(state, from) {
  const player = state.points[from];
  if (!player) return [];
  if (isFlying(state, player)) {
    return state.points.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  }
  return [...ADJACENCY[from]].filter((i) => state.points[i] === null);
}

function getMovablePieces(state, player) {
  return state.points
    .map((v, i) => (v === player ? i : -1))
    .filter((i) => i >= 0 && getLegalDestinations(state, i).length > 0);
}

function newMillsFrom(points, player, touchedPoint) {
  return MILLS.filter(
    (line) => line.includes(touchedPoint) && line.every((i) => points[i] === player)
  );
}

function getCapturablePoints(state, capturingPlayer) {
  const opponent = OPP(capturingPlayer);
  const oppPoints = state.points
    .map((v, i) => (v === opponent ? i : -1))
    .filter((i) => i >= 0);
  const millSet = millPointsFor(state.points, opponent);
  const free = oppPoints.filter((i) => !millSet.has(i));
  return free.length > 0 ? free : oppPoints;
}

function checkWinner(state) {
  for (const player of ["P1", "P2"]) {
    const opponent = OPP(player);
    if (state.phase === "movement" || totalOwned(state, opponent) < PIECES_PER_PLAYER) {
      if (totalOwned(state, opponent) < 3 && state.placedCount[opponent] >= PIECES_PER_PLAYER) {
        return { winner: player, reason: "capture" };
      }
    }
  }
  if (state.phase === "movement") {
    const mover = state.currentPlayer;
    if (!state.pendingCapture && getMovablePieces(state, mover).length === 0) {
      return { winner: OPP(mover), reason: "blocked" };
    }
  }
  return null;
}

function logMove(state, text) {
  state.moveHistory = [
    ...state.moveHistory,
    { n: state.moveHistory.length + 1, text, player: state.currentPlayer },
  ];
}

function finishTurnOrCapture(state, millLines) {
  if (millLines.length > 0) {
    state.lastMillPoints = [...new Set(millLines.flat())];
    state.millsFormed[state.currentPlayer] += millLines.length;
    logMove(state, `formed a mill${millLines.length > 1 ? "s" : ""}!`);
    const capturable = getCapturablePoints(state, state.currentPlayer);
    if (capturable.length > 0) {
      state.pendingCapture = true;
      return state;
    }
  }
  advanceTurn(state);
  return state;
}

function advanceTurn(state) {
  state.selected = null;
  state.pendingCapture = false;
  if (
    state.phase === "placement" &&
    state.placedCount.P1 >= PIECES_PER_PLAYER &&
    state.placedCount.P2 >= PIECES_PER_PLAYER
  ) {
    state.phase = "movement";
  }
  state.currentPlayer = OPP(state.currentPlayer);
  state.moveCount += 1;
  const w = checkWinner(state);
  if (w) state.gameOver = w;
}

function applyPlace(prev, point) {
  const state = structuredCloneState(prev);
  if (state.gameOver || state.pendingCapture) return state;
  if (state.points[point] !== null) return state;
  const player = state.currentPlayer;
  state.points[point] = player;
  state.placedCount[player] += 1;
  state.lastMoved = { to: point };
  logMove(state, `placed a piece`);
  const mills = newMillsFrom(state.points, player, point);
  return finishTurnOrCapture(state, mills);
}

function applySelect(prev, point) {
  const state = structuredCloneState(prev);
  if (state.gameOver || state.pendingCapture || state.phase !== "movement") return state;
  const player = state.currentPlayer;
  if (state.points[point] === player && getLegalDestinations(state, point).length > 0) {
    state.selected = state.selected === point ? null : point;
  } else if (state.selected !== null && state.points[point] === null) {
    return applyMove(prev, state.selected, point);
  }
  return state;
}

function applyMove(prev, from, to) {
  const state = structuredCloneState(prev);
  if (state.gameOver || state.pendingCapture) return state;
  const player = state.currentPlayer;
  if (state.points[from] !== player) return state;
  if (!getLegalDestinations(state, from).includes(to)) return state;
  state.points[from] = null;
  state.points[to] = player;
  state.selected = null;
  state.lastMoved = { from, to };
  logMove(state, `moved a piece`);
  const mills = newMillsFrom(state.points, player, to);
  return finishTurnOrCapture(state, mills);
}

function applyCapture(prev, point) {
  const state = structuredCloneState(prev);
  if (!state.pendingCapture) return state;
  const player = state.currentPlayer;
  const opponent = OPP(player);
  if (state.points[point] !== opponent) return state;
  if (!getCapturablePoints(state, player).includes(point)) return state;
  state.points[point] = null;
  state.capturedCount[opponent] += 1;
  state.capturedBy[player] = [...state.capturedBy[player], opponent];
  logMove(state, `captured an opponent piece`);
  state.pendingCapture = false;
  advanceTurn(state);
  return state;
}

function structuredCloneState(state) {
  return {
    ...state,
    points: [...state.points],
    placedCount: { ...state.placedCount },
    capturedCount: { ...state.capturedCount },
    capturedBy: { P1: [...state.capturedBy.P1], P2: [...state.capturedBy.P2] },
    millsFormed: { ...state.millsFormed },
    moveHistory: state.moveHistory,
  };
}

/* =========================================================================
   AI  —  heuristic + depth-limited minimax, scaled by difficulty
   ========================================================================= */

function enumerateActions(state, player) {
  const actions = [];
  if (state.pendingCapture) {
    getCapturablePoints(state, player).forEach((point) => actions.push({ type: "capture", point }));
    return actions;
  }
  if (state.phase === "placement") {
    getLegalPlacements(state).forEach((point) => actions.push({ type: "place", point }));
  } else {
    getMovablePieces(state, player).forEach((from) => {
      getLegalDestinations(state, from).forEach((to) => actions.push({ type: "move", from, to }));
    });
  }
  return actions;
}

function applyAction(state, action) {
  if (action.type === "place") return applyPlace(state, action.point);
  if (action.type === "move") return applyMove(state, action.from, action.to);
  if (action.type === "capture") return applyCapture(state, action.point);
  return state;
}

function countPotentialMills(state, player) {
  // lines with exactly 2 of this player's pieces and 1 empty point — a threat one move from completing
  let count = 0;
  for (const line of MILLS) {
    const vals = line.map((i) => state.points[i]);
    const mine = vals.filter((v) => v === player).length;
    const empty = vals.filter((v) => v === null).length;
    if (mine === 2 && empty === 1) count += 1;
  }
  return count;
}

function evaluate(state, player) {
  if (state.gameOver) {
    if (state.gameOver.winner === player) return 100000;
    if (state.gameOver.winner === OPP(player)) return -100000;
  }
  const opp = OPP(player);
  const myCount = onBoardCount(state, player);
  const oppCount = onBoardCount(state, opp);
  const myMills = millPointsFor(state.points, player).size / 3;
  const oppMills = millPointsFor(state.points, opp).size / 3;
  const myMobility = state.phase === "movement" ? getMovablePieces(state, player).length : 0;
  const oppMobility = state.phase === "movement" ? getMovablePieces(state, opp).length : 0;
  const myThreats = countPotentialMills(state, player);
  const oppThreats = countPotentialMills(state, opp);
  return (
    (myCount - oppCount) * 10 +
    (myMills - oppMills) * 8 +
    (myMobility - oppMobility) * 2 +
    (myThreats - oppThreats) * 4 +
    (state.capturedCount[opp] - state.capturedCount[player]) * 5
  );
}

function bestCaptureFor(state, player) {
  const options = getCapturablePoints(state, player);
  let best = options[0];
  let bestScore = -Infinity;
  for (const point of options) {
    const next = applyCapture(state, point);
    const score = evaluate(next, player);
    if (score > bestScore) { bestScore = score; best = point; }
  }
  return best;
}

function minimax(state, player, depth, alpha, beta, maximizing, rootPlayer) {
  if (depth === 0 || state.gameOver) return evaluate(state, rootPlayer);
  const actor = state.pendingCapture ? state.currentPlayer : state.currentPlayer;
  const actions = enumerateActions(state, actor);
  if (actions.length === 0) return evaluate(state, rootPlayer);

  if (maximizing) {
    let value = -Infinity;
    for (const action of actions) {
      const next = applyAction(state, action);
      const nextIsCapture = next.pendingCapture;
      const childMax = nextIsCapture ? next.currentPlayer === rootPlayer : next.currentPlayer === rootPlayer;
      value = Math.max(value, minimax(next, actor, depth - 1, alpha, beta, childMax, rootPlayer));
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return value;
  } else {
    let value = Infinity;
    for (const action of actions) {
      const next = applyAction(state, action);
      const childMax = next.currentPlayer === rootPlayer;
      value = Math.min(value, minimax(next, actor, depth - 1, alpha, beta, childMax, rootPlayer));
      beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    return value;
  }
}

function chooseAiAction(state, player, difficulty) {
  const actions = enumerateActions(state, player);
  if (actions.length === 0) return null;

  if (state.pendingCapture) {
    if (difficulty === "beginner") return { type: "capture", point: actions[Math.floor(Math.random() * actions.length)].point };
    return { type: "capture", point: bestCaptureFor(state, player) };
  }

  if (difficulty === "beginner") {
    const millMakers = actions.filter((a) => {
      const next = applyAction(state, a);
      return next.pendingCapture;
    });
    if (millMakers.length > 0 && Math.random() < 0.6) {
      return millMakers[Math.floor(Math.random() * millMakers.length)];
    }
    return actions[Math.floor(Math.random() * actions.length)];
  }

  const depth = { intermediate: 1, advanced: 2, expert: 4 }[difficulty] || 1;
  const epsilon = { intermediate: 0.15, advanced: 0.03, expert: 0 }[difficulty] ?? 0.1;

  if (Math.random() < epsilon) return actions[Math.floor(Math.random() * actions.length)];

  let best = actions[0];
  let bestScore = -Infinity;
  for (const action of actions) {
    const next = applyAction(state, action);
    const maximizingNext = next.currentPlayer === player;
    const score = next.pendingCapture
      ? evaluate(applyCapture(next, bestCaptureFor(next, player)), player)
      : minimax(next, player, depth - 1, -Infinity, Infinity, maximizingNext, player);
    if (score > bestScore) { bestScore = score; best = action; }
  }
  return best;
}

/* =========================================================================
   PERSISTENCE
   ========================================================================= */

const STATS_KEY = "mlabalaba:stats:v1";
const defaultStats = () => ({
  gamesPlayed: 0, gamesWon: 0, gamesLost: 0,
  piecesCaptured: 0, millsFormed: 0,
  bestStreak: 0, currentStreak: 0,
  recent: [], // {result, opponent, date, moves}
});

async function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw ? JSON.parse(raw) : defaultStats();
  } catch { return defaultStats(); }
}
async function saveStats(stats) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch {}
}

/* =========================================================================
   SOUND
   ========================================================================= */

function useBeeper(enabled) {
  const ctxRef = useRef(null);
  const play = useCallback((freqs = [440], dur = 0.09, type = "sine") => {
    if (!enabled) return;
    try {
      if (!ctxRef.current) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        ctxRef.current = new AudioCtx();
      }
      const ctx = ctxRef.current;
      freqs.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = f;
        const t0 = ctx.currentTime + idx * dur * 0.9;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      });
    } catch {}
  }, [enabled]);
  return {
    place: () => play([320], 0.07),
    move: () => play([260], 0.06),
    mill: () => play([440, 550, 660], 0.1),
    capture: () => play([500, 300], 0.09, "triangle"),
    win: () => play([440, 550, 660, 880], 0.14),
    click: () => play([380], 0.04),
  };
}

/* =========================================================================
   THEME TOKENS
   ========================================================================= */

const THEME = {
  dark: {
    bg: "#14110D", surface: "#1D1912", surface2: "#241F16", border: "#332B1E",
    text: "#F3ECDD", textDim: "#B7A98D", gold: "#D9A64C", copper: "#C6672E",
    teal: "#2F7566", wood: "#7A4A2C", woodLight: "#9C6B3F",
  },
  light: {
    bg: "#F4EEE0", surface: "#FFFBF2", surface2: "#EFE6D2", border: "#DDCEA9",
    text: "#241C10", textDim: "#6C5C3E", gold: "#B67F1F", copper: "#A8451D",
    teal: "#1F5F51", wood: "#8A5A34", woodLight: "#B98750",
  },
};

/* =========================================================================
   SMALL UI PRIMITIVES
   ========================================================================= */

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Yeseva+One&family=Manrope:wght@400;500;600;700;800&display=swap');
      .mlb-root { font-family: 'Manrope', sans-serif; }
      .mlb-display { font-family: 'Yeseva One', serif; }
      .mlb-fade-in { animation: mlbFadeIn 0.35s ease both; }
      @keyframes mlbFadeIn { from { opacity:0; transform: translateY(6px);} to {opacity:1; transform:none;} }
      .mlb-pop { animation: mlbPop 0.28s cubic-bezier(.34,1.56,.64,1) both; }
      @keyframes mlbPop { from { transform: scale(0.3); opacity:0;} to { transform: scale(1); opacity:1;} }
      .mlb-pulse { animation: mlbPulse 1.4s ease-in-out infinite; }
      @keyframes mlbPulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
      .mlb-ring { animation: mlbRing 1.6s ease-in-out infinite; }
      @keyframes mlbRing { 0%,100% { stroke-opacity: .35; r: 20;} 50% { stroke-opacity: 1; r: 24; } }
      .mlb-shake { animation: mlbShake .4s; }
      @keyframes mlbShake { 10%,90%{transform:translateX(-1px)} 20%,80%{transform:translateX(2px)} 30%,50%,70%{transform:translateX(-3px)} 40%,60%{transform:translateX(3px)} }
      .mlb-scroll::-webkit-scrollbar { width: 6px; }
      .mlb-scroll::-webkit-scrollbar-thumb { background: var(--mlb-border); border-radius: 4px; }
      .mlb-focus:focus-visible { outline: 2px solid var(--mlb-gold); outline-offset: 2px; }
      .mlb-confetti span { position:absolute; top:-10%; animation: mlbFall linear forwards; }
      @keyframes mlbFall { to { transform: translateY(120vh) rotate(360deg); opacity: 0.2; } }
    `}</style>
  );
}

/* Isihlangu (war shield) crossed with an iklwa (stabbing spear) — the game's mark */
function ShieldMark({ palette, size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <ellipse cx="20" cy="21" rx="11" ry="16" fill={palette.copper} stroke={palette.gold} strokeWidth="1.6" />
      <line x1="20" y1="6" x2="20" y2="36" stroke={palette.gold} strokeWidth="1.4" opacity="0.85" />
      <line x1="12" y1="14" x2="28" y2="14" stroke={palette.bg} strokeWidth="1" opacity="0.35" />
      <line x1="10" y1="21" x2="30" y2="21" stroke={palette.bg} strokeWidth="1" opacity="0.35" />
      <line x1="12" y1="28" x2="28" y2="28" stroke={palette.bg} strokeWidth="1" opacity="0.35" />
      <g transform="rotate(28 20 20)">
        <line x1="20" y1="1" x2="20" y2="34" stroke={palette.teal} strokeWidth="2" strokeLinecap="round" />
        <path d="M 20 1 L 16 9 L 24 9 Z" fill={palette.teal} />
      </g>
    </svg>
  );
}

/* Shared pattern defs: a subtle leopard-rosette texture and a beadwork diamond strip */
function PatternDefs({ palette }) {
  const spot = "#2A160C";
  const rosette = (cx, cy, r, key) => (
    <g key={key} opacity="0.55">
      <ellipse cx={cx - r * 0.6} cy={cy - r * 0.3} rx={r * 0.5} ry={r * 0.35} fill={spot} />
      <ellipse cx={cx + r * 0.6} cy={cy - r * 0.2} rx={r * 0.45} ry={r * 0.3} fill={spot} />
      <ellipse cx={cx} cy={cy + r * 0.55} rx={r * 0.55} ry={r * 0.35} fill={spot} />
    </g>
  );
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <pattern id="mlbLeopard" width="52" height="52" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
          <rect width="52" height="52" fill={palette.copper} opacity="0.16" />
          {rosette(14, 14, 9, "a")}
          {rosette(40, 30, 8, "b")}
          {rosette(22, 42, 7, "c")}
        </pattern>
        <pattern id="mlbBeads" width="16" height="16" patternUnits="userSpaceOnUse">
          <polygon points="8,1 15,8 8,15 1,8" fill="none" stroke={palette.gold} strokeWidth="1.4" opacity="0.6" />
        </pattern>
      </defs>
    </svg>
  );
}

function BeadDivider({ height = 7 }) {
  return (
    <svg width="100%" height={height} style={{ display: "block" }}>
      <rect width="100%" height="100%" fill="url(#mlbBeads)" />
    </svg>
  );
}

function LeopardSwatch({ size = 12 }) {
  return (
    <svg width={size} height={size} style={{ borderRadius: 3, flexShrink: 0 }} aria-hidden="true">
      <rect width={size} height={size} rx="3" fill="url(#mlbLeopard)" />
    </svg>
  );
}

function IconBtn({ icon: Icon, label, onClick, active = false, className = "" }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`mlb-focus w-9 h-9 rounded-full flex items-center justify-center transition-all ${
        active ? "opacity-100" : "opacity-70 hover:opacity-100"
      } ${className}`}
      style={{ background: "var(--mlb-surface2)", border: "1px solid var(--mlb-border)", color: "var(--mlb-text)" }}
    >
      <Icon size={16} />
    </button>
  );
}

function Avatar({ name, tone, size = 44 }) {
  const initials = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div
      className="rounded-full flex items-center justify-center font-bold shrink-0 mlb-display"
      style={{
        width: size, height: size, fontSize: size * 0.36,
        background: `linear-gradient(145deg, ${tone}, ${tone}99)`,
        color: "#1a1a1a", boxShadow: `0 0 0 2px var(--mlb-surface), 0 0 0 3px ${tone}`,
      }}
    >
      {initials}
    </div>
  );
}

/* =========================================================================
   BOARD
   ========================================================================= */

const PIECE_STYLE_INFO = {
  isihlangu: { label: "Isihlangu", fillId: "shieldgrad" },
  inkomo: { label: "Inkomo", fillId: "inkomograd" },
  ucu: { label: "Ucu Ball", fillId: "ucugrad" },
  leopard: { label: "Leopard", fillId: null }, // uses the leopard pattern directly
};
const AI_PIECE_STYLES = ["ucu", "leopard"];
const ONLINE_PIECE_STYLES = ["isihlangu", "inkomo", "ucu", "leopard"];

function pieceFill(style, defaultFill) {
  const info = PIECE_STYLE_INFO[style];
  if (!info) return defaultFill;
  if (style === "leopard") return "url(#mlbLeopard)";
  return `url(#${info.fillId})`;
}

function PieceTexture({ style, cx, cy, r }) {
  if (style === "ucu") {
    const colors = ["#D9A64C", "#C6672E", "#2F7566", "#F3ECDD", "#8A5A34"];
    const count = 10;
    return Array.from({ length: count }).map((_, i) => {
      const angle = (i / count) * Math.PI * 2;
      const bx = cx + Math.cos(angle) * r * 0.64;
      const by = cy + Math.sin(angle) * r * 0.64;
      return <circle key={i} cx={bx} cy={by} r={r * 0.16} fill={colors[i % colors.length]} stroke="#00000035" strokeWidth="0.7" />;
    });
  }
  if (style === "isihlangu") {
    return (
      <>
        <line x1={cx} y1={cy - r * 0.8} x2={cx} y2={cy + r * 0.8} stroke="#F3ECDD" strokeWidth={Math.max(1.4, r * 0.09)} opacity="0.8" />
        <line x1={cx - r * 0.55} y1={cy - r * 0.35} x2={cx + r * 0.55} y2={cy - r * 0.35} stroke="#00000040" strokeWidth={Math.max(1, r * 0.06)} />
        <line x1={cx - r * 0.62} y1={cy + r * 0.15} x2={cx + r * 0.62} y2={cy + r * 0.15} stroke="#00000040" strokeWidth={Math.max(1, r * 0.06)} />
        <ellipse cx={cx} cy={cy} rx={r * 0.92} ry={r * 0.92} fill="none" stroke="#F3ECDD" strokeWidth={Math.max(1, r * 0.05)} opacity="0.5" />
      </>
    );
  }
  if (style === "inkomo") {
    return (
      <>
        <path d={`M ${cx - r * 0.55} ${cy - r * 0.35} Q ${cx - r * 0.85} ${cy - r * 0.75} ${cx - r * 0.45} ${cy - r * 0.85}`} fill="none" stroke="#EDE3CE" strokeWidth={Math.max(1.6, r * 0.14)} strokeLinecap="round" />
        <path d={`M ${cx + r * 0.55} ${cy - r * 0.35} Q ${cx + r * 0.85} ${cy - r * 0.75} ${cx + r * 0.45} ${cy - r * 0.85}`} fill="none" stroke="#EDE3CE" strokeWidth={Math.max(1.6, r * 0.14)} strokeLinecap="round" />
        <ellipse cx={cx} cy={cy + r * 0.25} rx={r * 0.34} ry={r * 0.24} fill="#00000030" />
      </>
    );
  }
  return null;
}

function PieceStylePicker({ value, onChange, palette, options }) {
  return (
    <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((id) => {
        const info = PIECE_STYLE_INFO[id];
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className="mlb-focus flex flex-col items-center gap-1.5 rounded-lg py-2.5 transition-all"
            style={{
              background: value === id ? `${palette.gold}22` : "var(--mlb-surface2)",
              border: `1.5px solid ${value === id ? palette.gold : "var(--mlb-border)"}`,
            }}
          >
            <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
              <defs>
                <radialGradient id="pick-ucugrad" cx="35%" cy="30%" r="70%"><stop offset="0%" stopColor="#FFF8EA" /><stop offset="100%" stopColor="#E8D9B8" /></radialGradient>
                <radialGradient id="pick-shieldgrad" cx="35%" cy="30%" r="70%"><stop offset="0%" stopColor="#C99A6B" /><stop offset="100%" stopColor="#8B5A34" /></radialGradient>
                <radialGradient id="pick-inkomograd" cx="35%" cy="30%" r="70%"><stop offset="0%" stopColor="#4A3B32" /><stop offset="100%" stopColor="#1C140F" /></radialGradient>
              </defs>
              <circle cx="20" cy="20" r="17" fill={info.fillId ? `url(#pick-${info.fillId})` : "url(#mlbLeopard)"} stroke="#00000033" strokeWidth="1.2" />
              <PieceTexture style={id} cx={20} cy={20} r={17} />
            </svg>
            <span className="text-[10px] font-bold" style={{ color: "var(--mlb-text)" }}>{info.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Board({
  state, onPointClick, interactive, palette, size = 560, showLegalHints = true, pieceStyle = "classic", myRole = "P1", premium = false,
}) {
  const legalTargets = useMemo(() => {
    if (!interactive) return [];
    if (state.pendingCapture) return getCapturablePoints(state, state.currentPlayer);
    if (state.phase === "placement") return getLegalPlacements(state);
    if (state.selected !== null) return getLegalDestinations(state, state.selected);
    return [];
  }, [state, interactive]);

  const selectablePieces = useMemo(() => {
    if (!interactive || state.phase !== "movement" || state.pendingCapture) return [];
    return getMovablePieces(state, state.currentPlayer);
  }, [state, interactive]);

  const p1Color = palette.copper;
  const p2Color = palette.teal;
  const pr = premium ? 21 : 18; // piece radius

  return (
    <svg viewBox="0 0 600 600" width="100%" height="100%" style={{ maxWidth: size, maxHeight: size }} role="img" aria-label="Mlabalaba board">
      <defs>
        <radialGradient id="mlbWood" cx="50%" cy="35%" r="75%">
          <stop offset="0%" stopColor={palette.woodLight} />
          <stop offset="100%" stopColor={palette.wood} />
        </radialGradient>
        <radialGradient id="p1grad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#F0A46E" />
          <stop offset="100%" stopColor={p1Color} />
        </radialGradient>
        <radialGradient id="p2grad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#6FC9B3" />
          <stop offset="100%" stopColor={p2Color} />
        </radialGradient>
        <radialGradient id="ucugrad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#FFF8EA" /><stop offset="100%" stopColor="#E8D9B8" />
        </radialGradient>
        <radialGradient id="shieldgrad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#C99A6B" /><stop offset="100%" stopColor="#8B5A34" />
        </radialGradient>
        <radialGradient id="inkomograd" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#4A3B32" /><stop offset="100%" stopColor="#1C140F" />
        </radialGradient>
        {premium && (
          <>
            <pattern id="mlbWoodGrain" width="130" height="60" patternUnits="userSpaceOnUse" patternTransform="rotate(1)">
              <path d="M0,10 Q32,3 65,10 T130,10" stroke="#00000030" strokeWidth="2.2" fill="none" />
              <path d="M0,28 Q32,35 65,28 T130,28" stroke="#00000022" strokeWidth="1.6" fill="none" />
              <path d="M0,46 Q32,39 65,46 T130,46" stroke="#00000030" strokeWidth="2.2" fill="none" />
            </pattern>
            <radialGradient id="mlbVignette" cx="50%" cy="50%" r="72%">
              <stop offset="60%" stopColor="#000000" stopOpacity="0" />
              <stop offset="100%" stopColor="#000000" stopOpacity="0.35" />
            </radialGradient>
          </>
        )}
      </defs>

      <rect x="10" y="10" width="580" height="580" rx="26" fill="url(#mlbWood)" opacity={premium ? 0.45 : 0.15} />
      {premium && <rect x="10" y="10" width="580" height="580" rx="26" fill="url(#mlbWoodGrain)" opacity="0.7" />}
      {premium && <rect x="10" y="10" width="580" height="580" rx="26" fill="url(#mlbVignette)" />}
      <rect x="10" y="10" width="580" height="580" rx="26" fill="none" stroke={palette.border} strokeWidth="2" />
      <rect x="2" y="2" width="596" height="596" rx="30" fill="none" stroke="url(#mlbBeads)" strokeWidth="6" opacity="0.5" />

      {premium && ALL_EDGES.map(([a, b], idx) => (
        <line
          key={`groove-${idx}`}
          x1={POINTS[a].x} y1={POINTS[a].y} x2={POINTS[b].x} y2={POINTS[b].y}
          stroke="#00000060" strokeWidth="5.5" strokeLinecap="round"
        />
      ))}
      {ALL_EDGES.map(([a, b], idx) => (
        <line
          key={idx}
          x1={POINTS[a].x} y1={POINTS[a].y} x2={POINTS[b].x} y2={POINTS[b].y}
          stroke={palette.gold} strokeOpacity={premium ? 0.8 : 0.55} strokeWidth={premium ? 2.2 : 3} strokeLinecap="round"
        />
      ))}

      {state.lastMillPoints.length > 0 &&
        MILLS.filter((line) => line.every((i) => state.lastMillPoints.includes(i)) && line.every((i) => state.points[i]))
          .map((line, li) => (
            <polyline
              key={li}
              points={line.map((i) => `${POINTS[i].x},${POINTS[i].y}`).join(" ")}
              fill="none" stroke={palette.gold} strokeWidth="6" strokeLinecap="round" opacity="0.85"
            />
          ))}

      {POINTS.map((pt, i) => {
        const occ = state.points[i];
        const isMine = occ === myRole;
        const isSelected = state.selected === i;
        const isLegal = legalTargets.includes(i);
        const isSelectable = selectablePieces.includes(i);
        const isLastMoved = state.lastMoved && (state.lastMoved.to === i || state.lastMoved.from === i);
        const baseFill = occ === "P1" ? "url(#p1grad)" : "url(#p2grad)";
        return (
          <g key={i}>
            <circle
              cx={pt.x} cy={pt.y} r={pr - 2}
              fill="transparent"
              onClick={() => interactive && onPointClick(i)}
              className={interactive && (isLegal || isSelectable) ? "cursor-pointer" : ""}
              style={{ pointerEvents: interactive ? "all" : "none" }}
            />
            {!occ && (
              <circle cx={pt.x} cy={pt.y} r="7" fill={palette.border} opacity="0.8" pointerEvents="none" />
            )}
            {isLegal && !occ && (
              <circle cx={pt.x} cy={pt.y} r="13" fill={palette.gold} opacity="0.35" className="mlb-pulse" pointerEvents="none" />
            )}
            {isLegal && occ && (
              <circle cx={pt.x} cy={pt.y} r={pr + 4} fill="none" stroke="#E15A3C" strokeWidth="3" className="mlb-pulse" pointerEvents="none" />
            )}
            {occ && (
              <g className={isLastMoved ? "mlb-pop" : ""} pointerEvents="none">
                <circle cx={pt.x} cy={pt.y} r={pr + 1} fill="#00000055" transform="translate(0,2)" />
                <circle
                  cx={pt.x} cy={pt.y} r={pr}
                  fill={isMine ? pieceFill(pieceStyle, baseFill) : baseFill}
                  stroke={isSelected ? palette.gold : "#00000033"}
                  strokeWidth={isSelected ? 4 : 1.5}
                />
                {isMine && <PieceTexture style={pieceStyle} cx={pt.x} cy={pt.y} r={pr} />}
                {isSelectable && (
                  <circle cx={pt.x} cy={pt.y} r={pr + 6} fill="none" stroke={palette.gold} strokeWidth="2.5" className="mlb-ring" />
                )}
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* =========================================================================
   PLAYER CARD
   ========================================================================= */

function PlayerCard({ side, name, avatarTone, isTurn, state, profile, mirrored = false }) {
  const remaining = onBoardCount(state, side) + (PIECES_PER_PLAYER - state.placedCount[side]);
  const captured = state.capturedBy[side];
  return (
    <div
      className={`mlb-fade-in rounded-2xl p-4 flex flex-col gap-3 relative overflow-hidden transition-all ${isTurn ? "mlb-pop" : ""}`}
      style={{
        background: "var(--mlb-surface)",
        border: `1.5px solid ${isTurn ? avatarTone : "var(--mlb-border)"}`,
        boxShadow: isTurn ? `0 0 0 3px ${avatarTone}33` : "none",
      }}
    >
      <div className={`flex items-center gap-3 ${mirrored ? "flex-row-reverse text-right" : ""}`}>
        <Avatar name={name} tone={avatarTone} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2" style={{ flexDirection: mirrored ? "row-reverse" : "row" }}>
            <p className="font-bold truncate" style={{ color: "var(--mlb-text)" }}>{name}</p>
            {isTurn && <span className="text-[10px] px-2 py-0.5 rounded-full font-bold mlb-pulse" style={{ background: avatarTone, color: "#181310" }}>TURN</span>}
          </div>
          <p className="text-xs" style={{ color: "var(--mlb-textDim)" }}>{profile.rank} · Lvl {profile.level}</p>
        </div>
      </div>

      <div className={`grid grid-cols-3 gap-2 text-center`}>
        <Stat label="On board" value={onBoardCount(state, side)} />
        <Stat label="Captured" value={captured.length} />
        <Stat label="Mills" value={state.millsFormed[side]} />
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "var(--mlb-textDim)" }}>Captured pieces</p>
        <div className={`flex flex-wrap gap-1.5 min-h-[22px] ${mirrored ? "justify-end" : ""}`}>
          {captured.length === 0 && <span className="text-xs italic" style={{ color: "var(--mlb-textDim)" }}>None yet</span>}
          {captured.map((c, idx) => (
            <span
              key={idx}
              className="w-4 h-4 rounded-full mlb-pop"
              style={{ background: c === "P1" ? "var(--mlb-copper)" : "var(--mlb-teal)", boxShadow: "0 0 0 1px #00000033" }}
            />
          ))}
        </div>
      </div>

      <div className={`flex justify-between text-xs pt-2 border-t ${mirrored ? "flex-row-reverse" : ""}`} style={{ borderColor: "var(--mlb-border)" }}>
        <span style={{ color: "var(--mlb-textDim)" }}>W {profile.wins} · L {profile.losses}</span>
        <span style={{ color: "var(--mlb-textDim)" }}>{profile.winPct}% win rate</span>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg py-1.5" style={{ background: "var(--mlb-surface2)" }}>
      <p className="font-bold text-lg leading-none" style={{ color: "var(--mlb-text)" }}>{value}</p>
      <p className="text-[10px] mt-1" style={{ color: "var(--mlb-textDim)" }}>{label}</p>
    </div>
  );
}

/* =========================================================================
   MOVE HISTORY
   ========================================================================= */

function MoveHistory({ history }) {
  return (
    <div className="rounded-2xl p-3 flex flex-col" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
      <p className="text-xs font-bold uppercase tracking-wide mb-2 px-1" style={{ color: "var(--mlb-textDim)" }}>Move history</p>
      <div className="flex flex-col gap-1 max-h-40 overflow-y-auto mlb-scroll pr-1">
        {history.length === 0 && <p className="text-xs italic px-1" style={{ color: "var(--mlb-textDim)" }}>No moves yet.</p>}
        {history.map((m) => (
          <div key={m.n} className="text-xs px-2 py-1 rounded-lg flex gap-2" style={{ background: "var(--mlb-surface2)" }}>
            <span className="font-bold w-5 shrink-0" style={{ color: "var(--mlb-textDim)" }}>{m.n}.</span>
            <span style={{ color: "var(--mlb-text)" }}>
              <b style={{ color: m.player === "P1" ? "var(--mlb-copper)" : "var(--mlb-teal)" }}>{m.player === "P1" ? "P1" : "P2"}</b> {m.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   GAME BANNER / STATUS
   ========================================================================= */

function StatusBanner({ state, names }) {
  let text, tone;
  if (state.gameOver) {
    text = `${names[state.gameOver.winner]} wins!`;
    tone = "var(--mlb-gold)";
  } else if (state.pendingCapture) {
    text = `${names[state.currentPlayer]} formed a mill — choose a piece to capture`;
    tone = "#E15A3C";
  } else if (state.phase === "placement") {
    text = `${names[state.currentPlayer]}'s turn — place a piece (${state.placedCount[state.currentPlayer]}/${PIECES_PER_PLAYER})`;
    tone = state.currentPlayer === "P1" ? "var(--mlb-copper)" : "var(--mlb-teal)";
  } else {
    const flying = isFlying(state, state.currentPlayer);
    text = `${names[state.currentPlayer]}'s turn — ${flying ? "fly to any open point" : "move a piece"}`;
    tone = state.currentPlayer === "P1" ? "var(--mlb-copper)" : "var(--mlb-teal)";
  }
  return (
    <div className="mlb-fade-in rounded-xl px-4 py-2.5 text-center font-semibold text-sm" style={{ background: "var(--mlb-surface2)", color: tone, border: `1px solid ${tone}55` }}>
      {text}
    </div>
  );
}

/* =========================================================================
   RESULTS MODAL
   ========================================================================= */

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 40 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 0.6,
    dur: 2 + Math.random() * 1.5,
    color: [ "#D9A64C", "#C6672E", "#2F7566", "#F0A46E" ][i % 4],
    size: 6 + Math.random() * 6,
  })), []);
  return (
    <div className="mlb-confetti absolute inset-0 overflow-hidden pointer-events-none">
      {pieces.map((p, i) => (
        <span key={i} style={{ left: `${p.left}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, width: p.size, height: p.size, background: p.color, borderRadius: 2 }} />
      ))}
    </div>
  );
}

function ResultsModal({ state, names, onRematch, onLobby, matchSeconds }) {
  if (!state.gameOver) return null;
  const winner = state.gameOver.winner;
  const loser = OPP(winner);
  const mins = Math.floor(matchSeconds / 60), secs = matchSeconds % 60;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "#000000aa" }}>
      <div className="relative mlb-pop rounded-3xl p-6 sm:p-8 w-full max-w-md overflow-hidden" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
        <svg className="absolute inset-x-0 top-0" width="100%" height="10" style={{ display: "block" }} aria-hidden="true">
          <rect width="100%" height="100%" fill="url(#mlbLeopard)" />
        </svg>
        <Confetti />
        <div className="relative text-center">
          <Crown className="mx-auto mb-2" size={40} style={{ color: "var(--mlb-gold)" }} />
          <h2 className="mlb-display text-3xl" style={{ color: "var(--mlb-text)" }}>{names[winner]} wins</h2>
          <p className="text-sm mt-1" style={{ color: "var(--mlb-textDim)" }}>
            {state.gameOver.reason === "blocked" ? `${names[loser]} had no legal moves` : `${names[loser]} fell below 3 pieces`}
          </p>
        </div>
        <div className="relative grid grid-cols-2 gap-3 mt-6">
          <ResultCol label={names.P1} color="var(--mlb-copper)" state={state} side="P1" />
          <ResultCol label={names.P2} color="var(--mlb-teal)" state={state} side="P2" />
        </div>
        <div className="relative flex justify-around mt-4 text-xs" style={{ color: "var(--mlb-textDim)" }}>
          <span>Moves: {state.moveHistory.length}</span>
          <span className="flex items-center gap-1"><Clock size={12} /> {mins}:{secs.toString().padStart(2, "0")}</span>
        </div>
        <div className="relative flex gap-3 mt-6">
          <button onClick={onRematch} className="mlb-focus flex-1 rounded-xl py-2.5 font-bold flex items-center justify-center gap-2" style={{ background: "var(--mlb-gold)", color: "#181310" }}>
            <RotateCcw size={16} /> Rematch
          </button>
          <button onClick={onLobby} className="mlb-focus flex-1 rounded-xl py-2.5 font-bold" style={{ background: "var(--mlb-surface2)", color: "var(--mlb-text)", border: "1px solid var(--mlb-border)" }}>
            Lobby
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultCol({ label, color, state, side }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--mlb-surface2)" }}>
      <p className="text-xs font-bold mb-2" style={{ color }}>{label}</p>
      <div className="flex flex-col gap-1 text-xs" style={{ color: "var(--mlb-text)" }}>
        <span>Remaining: {onBoardCount(state, side)}</span>
        <span>Captured: {state.capturedBy[side].length}</span>
        <span>Mills: {state.millsFormed[side]}</span>
      </div>
    </div>
  );
}

/* =========================================================================
   TUTORIAL
   ========================================================================= */

function demoBoard(occupied) {
  const s = createInitialState();
  occupied.forEach(([i, p]) => (s.points[i] = p));
  return s;
}

const TUTORIAL_STEPS = [
  {
    title: "What is Mlabalaba?",
    body: "Mlabalaba is a two-player strategy game of placement, movement, and capture, played on a board of 24 connected points. Each side controls 12 pieces. Your goal: reduce your opponent to fewer than 3 pieces, or trap them so they cannot move.",
    board: () => demoBoard([]),
  },
  {
    title: "The board",
    body: "The board has three nested squares — outer, middle, and inner — joined by connector and diagonal lines. Every line segment is a path a piece can travel along, and every dot where lines meet is a point a piece can occupy.",
    board: () => demoBoard([]),
  },
  {
    title: "Placement phase",
    body: "The game opens with the placement phase. Players alternate placing one piece on any empty point until both sides have placed all 12 pieces. Choose points that give you future mobility and mill potential.",
    board: () => demoBoard([[1, "P1"], [9, "P2"], [17, "P1"]]),
  },
  {
    title: "Movement phase",
    body: "Once all pieces are placed, the movement phase begins. On your turn, slide one piece along a line to an empty neighbouring point. Select a piece to see its legal destinations highlighted in gold.",
    board: () => demoBoard([[1, "P1"], [0, "P1"], [2, "P2"], [9, "P2"]]),
  },
  {
    title: "Forming a mill",
    body: "A mill is three of your pieces in a row along any drawn line. Completing a mill — during placement or movement — immediately earns you a capture. Watch the gold highlight when three fall into line.",
    board: () => demoBoard([[0, "P1"], [1, "P1"], [2, "P1"], [8, "P2"]]),
  },
  {
    title: "Capturing",
    body: "After forming a mill, remove one opposing piece from the board. You cannot take a piece that's part of an opponent's own mill unless every one of their pieces is currently in a mill.",
    board: () => demoBoard([[0, "P1"], [1, "P1"], [2, "P1"], [7, "P2"], [15, "P2"]]),
  },
  {
    title: "Winning the game",
    body: "You win by reducing your opponent to fewer than 3 pieces on the board, or by leaving them with no legal move on their turn. If a player has exactly 3 pieces left, that player may 'fly' — moving to any empty point, not just an adjacent one.",
    board: () => demoBoard([[16, "P1"], [17, "P1"], [18, "P1"], [0, "P2"], [1, "P2"]]),
  },
  {
    title: "Strategy tips",
    body: "Favour points with more connections — cross and corner points touch three or four lines. Avoid completing a mill too early if you can instead threaten two mills at once ('a double mill' or swinging mill), forcing your opponent into a losing trade.",
    board: () => demoBoard([[9, "P1"], [11, "P1"], [13, "P1"], [17, "P1"], [19, "P2"], [21, "P2"]]),
  },
];

function TutorialView({ palette, onBack }) {
  const [step, setStep] = useState(0);
  const t = TUTORIAL_STEPS[step];
  const board = useMemo(() => t.board(), [step]);
  return (
    <div className="mlb-fade-in max-w-4xl mx-auto w-full flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <IconBtn icon={ArrowLeft} label="Back to lobby" onClick={onBack} />
        <h2 className="mlb-display text-2xl" style={{ color: "var(--mlb-text)" }}>Learn Mlabalaba</h2>
      </div>
      <div className="grid sm:grid-cols-2 gap-5 rounded-2xl p-5" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
        <div className="flex items-center justify-center">
          <Board state={board} onPointClick={() => {}} interactive={false} palette={palette} size={320} />
        </div>
        <div className="flex flex-col justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--mlb-gold)" }}>Step {step + 1} of {TUTORIAL_STEPS.length}</p>
            <h3 className="mlb-display text-2xl mt-1" style={{ color: "var(--mlb-text)" }}>{t.title}</h3>
            <p className="text-sm mt-3 leading-relaxed" style={{ color: "var(--mlb-textDim)" }}>{t.body}</p>
          </div>
          <div className="flex gap-2 mt-6">
            <button
              disabled={step === 0}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="mlb-focus flex-1 rounded-xl py-2.5 font-bold flex items-center justify-center gap-1 disabled:opacity-30"
              style={{ background: "var(--mlb-surface2)", color: "var(--mlb-text)", border: "1px solid var(--mlb-border)" }}
            >
              <ChevronLeft size={16} /> Back
            </button>
            <button
              disabled={step === TUTORIAL_STEPS.length - 1}
              onClick={() => setStep((s) => Math.min(TUTORIAL_STEPS.length - 1, s + 1))}
              className="mlb-focus flex-1 rounded-xl py-2.5 font-bold flex items-center justify-center gap-1 disabled:opacity-30"
              style={{ background: "var(--mlb-gold)", color: "#181310" }}
            >
              Next <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
      <div className="flex gap-1.5 justify-center flex-wrap">
        {TUTORIAL_STEPS.map((_, i) => (
          <button key={i} aria-label={`Go to step ${i + 1}`} onClick={() => setStep(i)}
            className="mlb-focus w-2.5 h-2.5 rounded-full transition-all"
            style={{ background: i === step ? "var(--mlb-gold)" : "var(--mlb-border)" }} />
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   ONLINE PANEL (honest placeholder — no fake connection)
   ========================================================================= */

function OnlinePanel({ palette, onBack, onEnterRoom }) {
  const [tab, setTab] = useState("create"); // create | join
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pieceStyle, setPieceStyle] = useState("ucu");

  if (!isSupabaseConfigured) {
    return (
      <div className="mlb-fade-in max-w-2xl mx-auto w-full flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <IconBtn icon={ArrowLeft} label="Back to lobby" onClick={onBack} />
          <h2 className="mlb-display text-2xl" style={{ color: "var(--mlb-text)" }}>Online multiplayer</h2>
        </div>
        <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
          <div className="flex items-center gap-2" style={{ color: "#E15A3C" }}>
            <WifiOff size={18} />
            <p className="font-bold text-sm">No Supabase project connected yet</p>
          </div>
          <p className="text-sm leading-relaxed" style={{ color: "var(--mlb-textDim)" }}>
            The room-creation and syncing code is wired up and ready — it just needs your Supabase project's URL
            and anon key in a <code>.env</code> file (<code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>). See <code>ONLINE_SETUP.md</code> for the exact steps, then restart
            <code> npm run dev</code>.
          </p>
        </div>
      </div>
    );
  }

  const handleCreate = async () => {
    setBusy(true);
    setError("");
    try {
      const code = await createRoom(createInitialState());
      onEnterRoom(code, "P1", pieceStyle);
    } catch (e) {
      setError(e.message || "Could not create a room. Check your Supabase setup.");
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    if (joinCode.trim().length < 4) { setError("Enter the 5-character room code."); return; }
    setBusy(true);
    setError("");
    try {
      await joinRoom(joinCode.trim().toUpperCase());
      onEnterRoom(joinCode.trim().toUpperCase(), "P2", pieceStyle);
    } catch (e) {
      setError(e.message || "Could not join that room.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mlb-fade-in max-w-2xl mx-auto w-full flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <IconBtn icon={ArrowLeft} label="Back to lobby" onClick={onBack} />
        <h2 className="mlb-display text-2xl" style={{ color: "var(--mlb-text)" }}>Online multiplayer</h2>
      </div>
      <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
        <div className="flex items-center gap-2" style={{ color: "var(--mlb-teal)" }}>
          <Wifi size={18} />
          <p className="font-bold text-sm">Connected to your Supabase project</p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--mlb-textDim)" }}>Your piece style</p>
          <PieceStylePicker value={pieceStyle} onChange={setPieceStyle} palette={palette} options={ONLINE_PIECE_STYLES} />
        </div>

        <div className="flex gap-2">
          <button onClick={() => { setTab("create"); setError(""); }} className="mlb-focus flex-1 rounded-xl py-2 font-bold text-sm"
            style={{ background: tab === "create" ? "var(--mlb-gold)" : "var(--mlb-surface2)", color: tab === "create" ? "#181310" : "var(--mlb-text)", border: "1px solid var(--mlb-border)" }}>
            Create game
          </button>
          <button onClick={() => { setTab("join"); setError(""); }} className="mlb-focus flex-1 rounded-xl py-2 font-bold text-sm"
            style={{ background: tab === "join" ? "var(--mlb-gold)" : "var(--mlb-surface2)", color: tab === "join" ? "#181310" : "var(--mlb-text)", border: "1px solid var(--mlb-border)" }}>
            Join with code
          </button>
        </div>

        {tab === "create" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm" style={{ color: "var(--mlb-textDim)" }}>
              You'll play as Player 1. A 5-character room code will be generated — share it with your opponent.
            </p>
            <button onClick={handleCreate} disabled={busy} className="mlb-focus rounded-xl py-2.5 font-bold flex items-center justify-center gap-2" style={{ background: "var(--mlb-gold)", color: "#181310" }}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Users size={16} />} Create room
            </button>
          </div>
        )}

        {tab === "join" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm" style={{ color: "var(--mlb-textDim)" }}>Enter the room code your opponent shared with you.</p>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={5}
              placeholder="e.g. K7QRT"
              className="mlb-focus rounded-xl px-3 py-2.5 font-mono tracking-widest text-lg text-center"
              style={{ background: "var(--mlb-surface2)", border: "1px solid var(--mlb-border)", color: "var(--mlb-text)" }}
            />
            <button onClick={handleJoin} disabled={busy} className="mlb-focus rounded-xl py-2.5 font-bold flex items-center justify-center gap-2" style={{ background: "var(--mlb-gold)", color: "#181310" }}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />} Join room
            </button>
          </div>
        )}

        {error && (
          <p className="text-xs rounded-lg px-3 py-2 mlb-fade-in" style={{ background: "var(--mlb-surface2)", color: "#E15A3C" }}>{error}</p>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   STATS VIEW
   ========================================================================= */

function StatsView({ stats, palette, onBack }) {
  const winPct = stats.gamesPlayed ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100) : 0;
  return (
    <div className="mlb-fade-in max-w-3xl mx-auto w-full flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <IconBtn icon={ArrowLeft} label="Back to lobby" onClick={onBack} />
        <h2 className="mlb-display text-2xl" style={{ color: "var(--mlb-text)" }}>Your statistics</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Games played" value={stats.gamesPlayed} />
        <Stat label="Win rate" value={`${winPct}%`} />
        <Stat label="Pieces captured" value={stats.piecesCaptured} />
        <Stat label="Mills formed" value={stats.millsFormed} />
        <Stat label="Games won" value={stats.gamesWon} />
        <Stat label="Games lost" value={stats.gamesLost} />
        <Stat label="Current streak" value={stats.currentStreak} />
        <Stat label="Best streak" value={stats.bestStreak} />
      </div>
      <div className="rounded-2xl p-4" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
        <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: "var(--mlb-textDim)" }}>Recent matches</p>
        {stats.recent.length === 0 && <p className="text-sm italic" style={{ color: "var(--mlb-textDim)" }}>Play a game to see your history here.</p>}
        <div className="flex flex-col gap-1.5">
          {stats.recent.map((r, i) => (
            <div key={i} className="flex justify-between text-sm rounded-lg px-3 py-2" style={{ background: "var(--mlb-surface2)" }}>
              <span style={{ color: r.result === "Win" ? "var(--mlb-gold)" : "var(--mlb-textDim)" }}>{r.result} vs {r.opponent}</span>
              <span style={{ color: "var(--mlb-textDim)" }}>{r.moves} moves</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   LOBBY
   ========================================================================= */

function ModeCard({ icon: Icon, title, desc, onClick, accent }) {
  return (
    <button
      onClick={onClick}
      className="mlb-focus mlb-fade-in text-left rounded-2xl p-5 flex flex-col gap-3 transition-transform hover:-translate-y-0.5"
      style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}
    >
      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${accent}22`, color: accent }}>
        <Icon size={20} />
      </div>
      <div>
        <p className="font-bold" style={{ color: "var(--mlb-text)" }}>{title}</p>
        <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--mlb-textDim)" }}>{desc}</p>
      </div>
    </button>
  );
}

function Lobby({ palette, stats, onStart, onTutorial, onStats, onOnline }) {
  const [difficulty, setDifficulty] = useState("intermediate");
  const [pieceStyle, setPieceStyle] = useState("ucu");
  const canPickPiece = difficulty === "advanced" || difficulty === "expert";
  const winPct = stats.gamesPlayed ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100) : 0;
  return (
    <div className="mlb-fade-in max-w-5xl mx-auto w-full flex flex-col gap-8">
      <div className="text-center flex flex-col items-center gap-2 pt-4">
        <div className="flex items-center gap-3">
          <ShieldMark palette={palette} size={40} />
          <h1 className="mlb-display text-5xl tracking-wide" style={{ color: "var(--mlb-text)" }}>MLABALABA</h1>
        </div>
        <p className="text-sm" style={{ color: "var(--mlb-textDim)" }}>A modern take on the classic Southern African mill game</p>
      </div>

      <div className="rounded-2xl p-4 flex flex-wrap items-center justify-center gap-6" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
        <div className="flex items-center gap-2"><Avatar name="You" tone={palette.copper} size={36} /><span className="text-sm font-semibold" style={{ color: "var(--mlb-text)" }}>You</span></div>
        <Divider /><span className="text-xs" style={{ color: "var(--mlb-textDim)" }}>Games <b style={{ color: "var(--mlb-text)" }}>{stats.gamesPlayed}</b></span>
        <Divider /><span className="text-xs" style={{ color: "var(--mlb-textDim)" }}>Win rate <b style={{ color: "var(--mlb-text)" }}>{winPct}%</b></span>
        <Divider /><span className="text-xs" style={{ color: "var(--mlb-textDim)" }}>Streak <b style={{ color: "var(--mlb-text)" }}>{stats.currentStreak}</b></span>
        <Divider />
        <button onClick={onStats} className="mlb-focus text-xs font-bold underline" style={{ color: "var(--mlb-gold)" }}>View full stats</button>
      </div>

      <div>
        <p className="text-xs font-bold uppercase tracking-wide mb-3 px-1" style={{ color: "var(--mlb-textDim)" }}>Play</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-2xl p-5 flex flex-col gap-3" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${palette.gold}22`, color: palette.gold }}><Bot size={20} /></div>
            <p className="font-bold" style={{ color: "var(--mlb-text)" }}>Play vs Computer</p>
            <p className="text-xs" style={{ color: "var(--mlb-textDim)" }}>Choose a difficulty, then start.</p>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {["beginner", "intermediate", "advanced", "expert"].map((d) => (
                <button key={d} onClick={() => setDifficulty(d)}
                  className="mlb-focus text-xs font-bold rounded-lg py-2 capitalize transition-all flex items-center justify-center gap-1.5"
                  style={{
                    background: difficulty === d ? palette.gold : "var(--mlb-surface2)",
                    color: difficulty === d ? "#181310" : "var(--mlb-text)",
                    border: "1px solid var(--mlb-border)",
                  }}>
                  {d === "expert" && <LeopardSwatch size={11} />}
                  {d}
                </button>
              ))}
            </div>
            {!canPickPiece && (
              <button onClick={() => onStart("ai", difficulty)} className="mlb-focus mt-1 rounded-xl py-2.5 font-bold flex items-center justify-center gap-2" style={{ background: palette.gold, color: "#181310" }}>
                <Play size={16} /> Start vs {difficulty}
              </button>
            )}
          </div>

          {canPickPiece && (
            <div className="rounded-2xl p-5 flex flex-col gap-3 sm:col-span-2" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
              <p className="font-bold" style={{ color: "var(--mlb-text)" }}>Choose your piece</p>
              <p className="text-xs" style={{ color: "var(--mlb-textDim)" }}>Unlocked on Advanced and Expert — pick the style your pieces play with.</p>
              <PieceStylePicker value={pieceStyle} onChange={setPieceStyle} palette={palette} options={AI_PIECE_STYLES} />
              <button onClick={() => onStart("ai", difficulty, pieceStyle)} className="mlb-focus mt-1 rounded-xl py-2.5 font-bold flex items-center justify-center gap-2" style={{ background: palette.gold, color: "#181310" }}>
                <Play size={16} /> Start vs {difficulty} with {PIECE_STYLE_INFO[pieceStyle].label}
              </button>
            </div>
          )}

          <ModeCard icon={Users} title="Local 2-player" desc="Pass and play on one device with a friend, full rules enforced." accent={palette.teal} onClick={() => onStart("local")} />
          <ModeCard icon={Target} title="Practice mode" desc="Free-form board with no AI opponent — explore placements and mills at your own pace." accent={palette.copper} onClick={() => onStart("practice")} />
          <ModeCard icon={Wifi} title="Online multiplayer" desc="Real-time rooms — requires a backend connection. See what's needed to enable it." accent={palette.gold} onClick={onOnline} />
        </div>
      </div>

      <div>
        <p className="text-xs font-bold uppercase tracking-wide mb-3 px-1" style={{ color: "var(--mlb-textDim)" }}>Learn</p>
        <ModeCard icon={BookOpen} title="Learn Mlabalaba" desc="An interactive, step-by-step guide covering the board, mills, capturing, and strategy." accent={palette.gold} onClick={onTutorial} />
      </div>
    </div>
  );
}

function Divider() { return <span className="h-4 w-px" style={{ background: "var(--mlb-border)" }} />; }

/* =========================================================================
   GAME VIEW
   ========================================================================= */

function GameView({ mode, difficulty, palette, onExit, stats, setStats, soundOn, roomCode, onlineRole, pieceStyle = "classic" }) {
  const [state, setState] = useState(createInitialState);
  const [history, setHistory] = useState([]);
  const [seconds, setSeconds] = useState(0);
  const [opponentJoined, setOpponentJoined] = useState(onlineRole === "P2");
  const beep = useBeeper(soundOn);
  const statsSaved = useRef(false);
  const timerRef = useRef(null);
  const applyingRemote = useRef(false);

  const isOnline = mode === "online";
  const myRole = isOnline ? (onlineRole || "P1") : "P1";
  const isPremium = isOnline || (mode === "ai" && (difficulty === "advanced" || difficulty === "expert"));

  const names = mode === "ai" ? { P1: "You", P2: `AI (${difficulty})` }
    : isOnline ? { P1: onlineRole === "P1" ? "You" : "Opponent", P2: onlineRole === "P2" ? "You" : "Opponent" }
    : { P1: "Player 1", P2: "Player 2" };

  // Online: subscribe to room changes from the opponent
  useEffect(() => {
    if (!isOnline || !roomCode) return;
    const unsubscribe = subscribeToRoom(roomCode, (row) => {
      if (row.guest_present) setOpponentJoined(true);
      if (row.state) {
        applyingRemote.current = true;
        setState(row.state);
      }
    });
    return () => { unsubscribe(); leaveRoom(roomCode, onlineRole); };
  }, [isOnline, roomCode, onlineRole]);

  // Online: push local moves to the room (skip when the update came from remote)
  useEffect(() => {
    if (!isOnline || !roomCode) return;
    if (applyingRemote.current) { applyingRemote.current = false; return; }
    pushRoomState(roomCode, state);
  }, [state, isOnline, roomCode]);
  const p1Profile = { rank: "Challenger", level: 4, wins: stats.gamesWon, losses: stats.gamesLost, winPct: stats.gamesPlayed ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100) : 0 };
  const p2Profile = mode === "ai"
    ? { rank: { beginner: "Novice", intermediate: "Skilled", advanced: "Veteran", expert: "Master" }[difficulty], level: { beginner: 1, intermediate: 3, advanced: 6, expert: 9 }[difficulty], wins: "—", losses: "—", winPct: "—" }
    : { rank: "Challenger", level: 4, wins: "—", losses: "—", winPct: "—" };

  useEffect(() => {
    timerRef.current = setInterval(() => setSeconds((s) => (state.gameOver ? s : s + 1)), 1000);
    return () => clearInterval(timerRef.current);
  }, [state.gameOver]);

  const pushHistory = (prev) => setHistory((h) => [...h, prev]);

  const handlePoint = useCallback((point) => {
    if (state.gameOver) return;
    if (mode === "ai" && state.currentPlayer === "P2") return;
    if (isOnline && state.currentPlayer !== onlineRole) return;
    let next;
    if (state.pendingCapture) {
      if (!getCapturablePoints(state, state.currentPlayer).includes(point)) return;
      pushHistory(state);
      next = applyCapture(state, point);
      beep.capture();
    } else if (state.phase === "placement") {
      if (state.points[point] !== null) return;
      pushHistory(state);
      next = applyPlace(state, point);
      next.pendingCapture ? beep.mill() : beep.place();
    } else {
      const beforeHistLen = state.moveHistory.length;
      const beforeSelected = state.selected;
      next = applySelect(state, point);
      if (next.moveHistory.length > beforeHistLen) {
        pushHistory(state);
        next.pendingCapture ? beep.mill() : beep.move();
      } else if (next.selected !== beforeSelected) {
        beep.click();
      }
    }
    setState(next);
  }, [state, mode, beep]);

  // AI turn
  useEffect(() => {
    if (mode !== "ai" || state.gameOver) return;
    if (state.currentPlayer !== "P2") return;
    const t = setTimeout(() => {
      const action = chooseAiAction(state, "P2", difficulty);
      if (!action) return;
      const next = applyAction(state, action);
      if (action.type === "capture") beep.capture();
      else if (next.pendingCapture) beep.mill();
      else beep.move();
      setState(next);
    }, 550 + Math.random() * 400);
    return () => clearTimeout(t);
  }, [state, mode, difficulty, beep]);

  // stats on game over
  useEffect(() => {
    if (!state.gameOver || statsSaved.current) return;
    statsSaved.current = true;
    beep.win();
    if (mode === "practice") return;
    const myRole = isOnline ? onlineRole : "P1";
    setStats((prev) => {
      const won = state.gameOver.winner === myRole;
      const next = {
        ...prev,
        gamesPlayed: prev.gamesPlayed + 1,
        gamesWon: prev.gamesWon + (won ? 1 : 0),
        gamesLost: prev.gamesLost + (won ? 0 : 1),
        piecesCaptured: prev.piecesCaptured + state.capturedBy[myRole].length,
        millsFormed: prev.millsFormed + state.millsFormed[myRole],
        currentStreak: won ? prev.currentStreak + 1 : 0,
        bestStreak: won ? Math.max(prev.bestStreak, prev.currentStreak + 1) : prev.bestStreak,
        recent: [{ result: won ? "Win" : "Loss", opponent: isOnline ? "Online opponent" : names.P2, moves: state.moveHistory.length }, ...prev.recent].slice(0, 8),
      };
      saveStats(next);
      return next;
    });
  }, [state.gameOver]);

  const handleUndo = () => {
    if (history.length === 0) return;
    const h = [...history];
    const prevState = h.pop();
    setHistory(h);
    setState(prevState);
    statsSaved.current = false;
  };

  const handleRematch = () => {
    setState(createInitialState());
    setHistory([]);
    setSeconds(0);
    statsSaved.current = false;
  };

  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const handleRestartOnline = () => {
    const fresh = createInitialState();
    setState(fresh);
    setHistory([]);
    setSeconds(0);
    statsSaved.current = false;
    setConfirmingRestart(false);
    // the state-change effect above will push `fresh` to the room automatically
  };

  if (isOnline && !opponentJoined) {
    return (
      <div className="mlb-fade-in w-full max-w-lg mx-auto flex flex-col items-center gap-5 text-center py-10">
        <IconBtn icon={ArrowLeft} label="Leave room" onClick={onExit} className="self-start" />
        <Loader2 size={32} className="animate-spin" style={{ color: "var(--mlb-gold)" }} />
        <h2 className="mlb-display text-2xl" style={{ color: "var(--mlb-text)" }}>Waiting for your opponent…</h2>
        <p className="text-sm" style={{ color: "var(--mlb-textDim)" }}>Share this room code with them:</p>
        <div className="flex items-center gap-2 rounded-xl px-5 py-3" style={{ background: "var(--mlb-surface2)", border: "1px solid var(--mlb-border)" }}>
          <span className="font-mono text-2xl tracking-[0.3em]" style={{ color: "var(--mlb-gold)" }}>{roomCode}</span>
          <button
            aria-label="Copy room code"
            onClick={() => navigator.clipboard?.writeText(roomCode)}
            className="mlb-focus w-8 h-8 rounded-full flex items-center justify-center"
            style={{ color: "var(--mlb-text)" }}
          >
            <Copy size={15} />
          </button>
        </div>
        <p className="text-xs" style={{ color: "var(--mlb-textDim)" }}>The board will appear automatically once they join.</p>
      </div>
    );
  }

  return (
    <div className="mlb-fade-in w-full max-w-6xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <IconBtn icon={ArrowLeft} label="Exit to lobby" onClick={onExit} />
        <div className="flex items-center gap-3 text-xs" style={{ color: "var(--mlb-textDim)" }}>
          {isOnline && <span className="flex items-center gap-1"><Wifi size={13} style={{ color: "var(--mlb-teal)" }} /> Room {roomCode}</span>}
          <span className="flex items-center gap-1"><Clock size={14} /> {Math.floor(seconds / 60)}:{(seconds % 60).toString().padStart(2, "0")}</span>
        </div>
        {isOnline ? (
          <button onClick={() => setConfirmingRestart(true)} className="mlb-focus flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full"
            style={{ background: "var(--mlb-surface2)", border: "1px solid var(--mlb-border)", color: "var(--mlb-text)" }}>
            <RotateCcw size={13} /> Restart game
          </button>
        ) : (
          <button onClick={handleUndo} disabled={history.length === 0} className="mlb-focus flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full disabled:opacity-30"
            style={{ background: "var(--mlb-surface2)", border: "1px solid var(--mlb-border)", color: "var(--mlb-text)" }}>
            <RotateCcw size={13} /> Undo
          </button>
        )}
      </div>

      {confirmingRestart && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "#000000aa" }}>
          <div className="mlb-pop rounded-2xl p-6 w-full max-w-sm text-center" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
            <h3 className="mlb-display text-xl mb-2" style={{ color: "var(--mlb-text)" }}>Restart this game?</h3>
            <p className="text-sm mb-5" style={{ color: "var(--mlb-textDim)" }}>
              This clears the board for both players and starts a fresh match in this same room. It can't be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmingRestart(false)} className="mlb-focus flex-1 rounded-xl py-2.5 font-bold" style={{ background: "var(--mlb-surface2)", border: "1px solid var(--mlb-border)", color: "var(--mlb-text)" }}>
                Cancel
              </button>
              <button onClick={handleRestartOnline} className="mlb-focus flex-1 rounded-xl py-2.5 font-bold" style={{ background: "var(--mlb-gold)", color: "#181310" }}>
                Restart
              </button>
            </div>
          </div>
        </div>
      )}

      <StatusBanner state={state} names={names} />

      <div className="grid lg:grid-cols-[220px_1fr_220px] gap-4 items-start">
        <div className="order-2 lg:order-1"><PlayerCard side="P1" name={names.P1} avatarTone={palette.copper} isTurn={state.currentPlayer === "P1" && !state.gameOver} state={state} profile={p1Profile} /></div>
        <div className="order-1 lg:order-2 flex justify-center rounded-2xl p-3 sm:p-6" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
          <Board state={state} onPointClick={handlePoint} interactive={!state.gameOver} palette={palette} pieceStyle={pieceStyle} myRole={myRole} premium={isPremium} />
        </div>
        <div className="order-3 flex flex-col gap-4">
          <PlayerCard side="P2" name={names.P2} avatarTone={palette.teal} isTurn={state.currentPlayer === "P2" && !state.gameOver} state={state} profile={p2Profile} mirrored />
        </div>
      </div>

      <MoveHistory history={state.moveHistory} />

      <ResultsModal state={state} names={names} matchSeconds={seconds} onRematch={handleRematch} onLobby={onExit} />
    </div>
  );
}

/* =========================================================================
   ROOT APP
   ========================================================================= */

export default function App() {
  const [view, setView] = useState("lobby"); // lobby | game | tutorial | stats | online
  const [mode, setMode] = useState("ai");
  const [difficulty, setDifficulty] = useState("intermediate");
  const [dark, setDark] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const [stats, setStats] = useState(defaultStats());
  const [roomCode, setRoomCode] = useState(null);
  const [onlineRole, setOnlineRole] = useState(null);
  const [pieceStyle, setPieceStyle] = useState("classic");
  const gameKey = useRef(0);

  useEffect(() => { loadStats().then(setStats); }, []);

  const palette = dark ? THEME.dark : THEME.light;
  const cssVars = {
    "--mlb-bg": palette.bg, "--mlb-surface": palette.surface, "--mlb-surface2": palette.surface2,
    "--mlb-border": palette.border, "--mlb-text": palette.text, "--mlb-textDim": palette.textDim,
    "--mlb-gold": palette.gold, "--mlb-copper": palette.copper, "--mlb-teal": palette.teal,
    "--mlb-wood": palette.wood, "--mlb-woodLight": palette.woodLight,
  };

  const startGame = (m, d, ps) => {
    gameKey.current += 1;
    setMode(m);
    if (d) setDifficulty(d);
    setPieceStyle(ps || "classic");
    setView("game");
  };

  const enterOnlineRoom = (code, role, ps) => {
    gameKey.current += 1;
    setRoomCode(code);
    setOnlineRole(role);
    setMode("online");
    setPieceStyle(ps || "ucu");
    setView("game");
  };

  return (
    <div className="mlb-root min-h-screen w-full flex flex-col" style={{ ...cssVars, background: "var(--mlb-bg)", minHeight: "100vh" }}>
      <GlobalStyle />
      <PatternDefs palette={palette} />
      <header className="w-full flex items-center justify-between px-4 sm:px-6 py-3 sticky top-0 z-10" style={{ background: `${palette.bg}ee`, backdropFilter: "blur(6px)", borderBottom: `1px solid ${palette.border}` }}>
        <button onClick={() => setView("lobby")} className="mlb-focus flex items-center gap-2">
          <ShieldMark palette={palette} size={26} />
          <span className="mlb-display text-lg" style={{ color: palette.text }}>MLABALABA</span>
        </button>
        <div className="flex items-center gap-2">
          <IconBtn icon={soundOn ? Volume2 : VolumeX} label="Toggle sound" active={soundOn} onClick={() => setSoundOn((s) => !s)} />
          <IconBtn icon={dark ? Sun : Moon} label="Toggle theme" onClick={() => setDark((d) => !d)} />
        </div>
      </header>
      <BeadDivider />

      <main className="flex-1 w-full px-4 sm:px-6 py-6 flex flex-col">
        {view === "lobby" && (
          <Lobby palette={palette} stats={stats} onStart={startGame} onTutorial={() => setView("tutorial")} onStats={() => setView("stats")} onOnline={() => setView("online")} />
        )}
        {view === "game" && (
          <GameView key={gameKey.current} mode={mode} difficulty={difficulty} palette={palette} onExit={() => setView("lobby")} stats={stats} setStats={setStats} soundOn={soundOn} roomCode={roomCode} onlineRole={onlineRole} pieceStyle={pieceStyle} />
        )}
        {view === "tutorial" && <TutorialView palette={palette} onBack={() => setView("lobby")} />}
        {view === "stats" && <StatsView stats={stats} palette={palette} onBack={() => setView("lobby")} />}
        {view === "online" && <OnlinePanel palette={palette} onBack={() => setView("lobby")} onEnterRoom={enterOnlineRoom} />}
      </main>

      <footer className="text-center text-[11px] py-4" style={{ color: palette.textDim }}>
        MLABALABA — a modern strategy game inspired by the traditional Morabaraba mill game.
      </footer>
    </div>
  );
}
