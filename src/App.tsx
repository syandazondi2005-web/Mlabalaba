"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Users, Bot, BookOpen, Trophy, Volume2, VolumeX, Moon, Sun, RotateCcw,
  Play, X, ChevronRight, ChevronLeft, Crown, Info, Wifi, WifiOff,
  Swords, Target, Shield, Sparkles, ArrowLeft, Check, Copy, Clock, Loader2, Globe, Cpu
} from "lucide-react";
import { isSupabaseConfigured } from "./lib/supabase";
import { createRoom, joinRoom, pushRoomState, leaveRoom, subscribeToRoom, sendMessage } from "./lib/rooms";

/* =========================================================================
   BOARD IMAGE CONSTANT
   ========================================================================= */
const BOARD_IMAGE_URL = "/Board.jpg";

/* =========================================================================
   ENGINE — pure, UI-independent Mlabalaba (Morabaraba-family) rules
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
const OPP = (p: string) => (p === "P1" ? "P2" : "P1");

function createInitialState() {
  return {
    points: Array(24).fill(null),
    phase: "placement",
    placedCount: { P1: 0, P2: 0 },
    capturedCount: { P1: 0, P2: 0 },
    capturedBy: { P1: [], P2: [] },
    millsFormed: { P1: 0, P2: 0 },
    currentPlayer: "P1",
    selected: null as number | null,
    pendingCapture: false,
    lastMillPoints: [] as number[],
    lastMoved: null as { from?: number; to: number } | null,
    moveHistory: [] as { n: number; text: string; player: string }[],
    gameOver: null as { winner: string; reason: string } | null,
    moveCount: 0,
  };
}

function totalOwned(state: any, player: string) {
  return PIECES_PER_PLAYER - state.capturedCount[player];
}

function onBoardCount(state: any, player: string) {
  return state.points.filter((p: string | null) => p === player).length;
}

function millPointsFor(points: (string | null)[], player: string) {
  const set = new Set<number>();
  MILLS.forEach((line) => {
    if (line.every((i) => points[i] === player)) line.forEach((i) => set.add(i));
  });
  return set;
}

function isFlying(state: any, player: string) {
  return state.phase === "movement" && onBoardCount(state, player) === 3;
}

function getLegalPlacements(state: any) {
  if (state.phase !== "placement") return [];
  return state.points.map((v: string | null, i: number) => (v === null ? i : -1)).filter((i: number) => i >= 0);
}

function getLegalDestinations(state: any, from: number) {
  const player = state.points[from];
  if (!player) return [];
  if (isFlying(state, player)) {
    return state.points.map((v: string | null, i: number) => (v === null ? i : -1)).filter((i: number) => i >= 0);
  }
  return [...ADJACENCY[from]].filter((i) => state.points[i] === null);
}

function getMovablePieces(state: any, player: string) {
  return state.points
    .map((v: string | null, i: number) => (v === player ? i : -1))
    .filter((i: number) => i >= 0 && getLegalDestinations(state, i).length > 0);
}

function newMillsFrom(points: (string | null)[], player: string, touchedPoint: number) {
  return MILLS.filter(
    (line) => line.includes(touchedPoint) && line.every((i) => points[i] === player)
  );
}

function getCapturablePoints(state: any, capturingPlayer: string) {
  const opponent = OPP(capturingPlayer);
  const oppPoints = state.points
    .map((v: string | null, i: number) => (v === opponent ? i : -1))
    .filter((i: number) => i >= 0);
  const millSet = millPointsFor(state.points, opponent);
  const free = oppPoints.filter((i: number) => !millSet.has(i));
  return free.length > 0 ? free : oppPoints;
}

function checkWinner(state: any) {
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

function logMove(state: any, text: string) {
  state.moveHistory = [
    ...state.moveHistory,
    { n: state.moveHistory.length + 1, text, player: state.currentPlayer },
  ];
}

function finishTurnOrCapture(state: any, millLines: number[][]) {
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

function advanceTurn(state: any) {
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

function applyPlace(prev: any, point: number) {
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

function applySelect(prev: any, point: number) {
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

function applyMove(prev: any, from: number, to: number) {
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

function applyCapture(prev: any, point: number) {
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

function structuredCloneState(state: any) {
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
   AI — heuristic + depth-limited minimax
   ========================================================================= */

function enumerateActions(state: any, player: string) {
  const actions: any[] = [];
  if (state.pendingCapture) {
    getCapturablePoints(state, player).forEach((point: number) => actions.push({ type: "capture", point }));
    return actions;
  }
  if (state.phase === "placement") {
    getLegalPlacements(state).forEach((point: number) => actions.push({ type: "place", point }));
  } else {
    getMovablePieces(state, player).forEach((from: number) => {
      getLegalDestinations(state, from).forEach((to: number) => actions.push({ type: "move", from, to }));
    });
  }
  return actions;
}

function applyAction(state: any, action: any) {
  if (action.type === "place") return applyPlace(state, action.point);
  if (action.type === "move") return applyMove(state, action.from, action.to);
  if (action.type === "capture") return applyCapture(state, action.point);
  return state;
}

function countPotentialMills(state: any, player: string) {
  let count = 0;
  for (const line of MILLS) {
    const vals = line.map((i) => state.points[i]);
    const mine = vals.filter((v) => v === player).length;
    const empty = vals.filter((v) => v === null).length;
    if (mine === 2 && empty === 1) count += 1;
  }
  return count;
}

function evaluate(state: any, player: string) {
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

function bestCaptureFor(state: any, player: string) {
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

function minimax(state: any, player: string, depth: number, alpha: number, beta: number, maximizing: boolean, rootPlayer: string): number {
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

function chooseAiAction(state: any, player: string, difficulty: string) {
  const actions = enumerateActions(state, player);
  if (actions.length === 0) return null;

  if (state.pendingCapture) {
    if (difficulty === "beginner" || difficulty === "easy") {
      return { type: "capture", point: actions[Math.floor(Math.random() * actions.length)].point };
    }
    return { type: "capture", point: bestCaptureFor(state, player) };
  }

  if (difficulty === "beginner" || difficulty === "easy") {
    const millMakers = actions.filter((a) => {
      const next = applyAction(state, a);
      return next.pendingCapture;
    });
    if (millMakers.length > 0 && Math.random() < 0.6) {
      return millMakers[Math.floor(Math.random() * millMakers.length)];
    }
    return actions[Math.floor(Math.random() * actions.length)];
  }

  const depth = { intermediate: 1, medium: 2, advanced: 3, expert: 4 }[difficulty] || 1;
  const epsilon = { intermediate: 0.15, medium: 0.1, advanced: 0.03, expert: 0 }[difficulty] ?? 0.1;

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
   PERSISTENCE & STATS
   ========================================================================= */

const STATS_KEY = "mlabalaba:stats:v1";
const defaultStats = () => ({
  gamesPlayed: 0, gamesWon: 0, gamesLost: 0,
  piecesCaptured: 0, millsFormed: 0,
  bestStreak: 0, currentStreak: 0,
  recent: [],
});

async function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw ? JSON.parse(raw) : defaultStats();
  } catch { return defaultStats(); }
}

/* =========================================================================
   SOUND
   ========================================================================= */

function useBeeper(enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const play = useCallback((freqs = [440], dur = 0.09, type: OscillatorType = "sine") => {
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

const THEME: Record<string, any> = {
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
      .mlb-scroll::-webkit-scrollbar { width: 6px; }
      .mlb-scroll::-webkit-scrollbar-thumb { background: var(--mlb-border); border-radius: 4px; }
      .mlb-focus:focus-visible { outline: 2px solid var(--mlb-gold); outline-offset: 2px; }
    `}</style>
  );
}

function ShieldMark({ palette, size = 40 }: { palette: any; size?: number }) {
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

function PatternDefs({ palette }: { palette: any }) {
  const spot = "#2A160C";
  const rosette = (cx: number, cy: number, r: number, key: string) => (
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

function IconBtn({ icon: Icon, label, onClick, active = false, className = "" }: any) {
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

function Avatar({ name, tone, size = 44 }: { name: string; tone: string; size?: number }) {
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
   BOARD & PIECES
   ========================================================================= */

const PIECE_STYLE_INFO: Record<string, { label: string; fillId: string | null }> = {
  isihlangu: { label: "Isihlangu", fillId: "shieldgrad" },
  inkomo: { label: "Inkomo", fillId: "inkomograd" },
  ucu: { label: "Ucu Ball", fillId: "ucugrad" },
  leopard: { label: "Leopard", fillId: null },
};
const ONLINE_PIECE_STYLES = ["isihlangu", "inkomo", "ucu", "leopard"];

function pieceFill(style: string, defaultFill: string) {
  const info = PIECE_STYLE_INFO[style];
  if (!info) return defaultFill;
  if (style === "leopard") return "url(#mlbLeopard)";
  return `url(#${info.fillId})`;
}

function PieceTexture({ style, cx, cy, r }: { style: string; cx: number; cy: number; r: number }) {
  if (style === "ucu") {
    const colors = ["#D9A64C", "#C6672E", "#2F7566", "#F3ECDD", "#8A5A34"];
    const count = 10;
    return (
      <g>
        {Array.from({ length: count }).map((_, i) => {
          const angle = (i / count) * Math.PI * 2;
          const bx = cx + Math.cos(angle) * r * 0.64;
          const by = cy + Math.sin(angle) * r * 0.64;
          return <circle key={i} cx={bx} cy={by} r={r * 0.16} fill={colors[i % colors.length]} stroke="#00000035" strokeWidth="0.7" />;
        })}
      </g>
    );
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

function PieceStylePicker({ value, onChange, palette, options }: any) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((id: string) => {
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
  state, onPointClick, interactive, palette, size = 560, showLegalHints = true, pieceStyle = "classic", myRole = "P1", opponentPieceStyle = null, shouldUseCustomBoard = false,
}: any) {
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

  const pr = 18;

  return (
    <svg viewBox="0 0 600 600" width="100%" height="100%" style={{ maxWidth: size, maxHeight: size }} role="img" aria-label="Mlabalaba board">
      <defs>
        <clipPath id="boardClip">
          <rect x="10" y="10" width="580" height="580" rx="26" />
        </clipPath>
        <radialGradient id="p1grad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#F0A46E" />
          <stop offset="100%" stopColor={palette.copper} />
        </radialGradient>
        <radialGradient id="p2grad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#6FC9B3" />
          <stop offset="100%" stopColor={palette.teal} />
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
      </defs>

      {/* Conditional Playing Board Surface: Custom image ONLY for Online or Expert AI */}
      {shouldUseCustomBoard ? (
        <image
          href={BOARD_IMAGE_URL}
          x="10"
          y="10"
          width="580"
          height="580"
          preserveAspectRatio="xMidYMid slice"
          clipPath="url(#boardClip)"
        />
      ) : (
        <rect x="10" y="10" width="580" height="580" rx="26" fill={palette.surface2} />
      )}

      {/* Outer Playing Board Frame Border */}
      <rect x="10" y="10" width="580" height="580" rx="26" fill="none" stroke={palette.gold} strokeWidth="3" opacity="0.8" />

      {/* Board Grid Lines */}
      {ALL_EDGES.map(([a, b], idx) => (
        <line
          key={idx}
          x1={POINTS[a].x} y1={POINTS[a].y}
          x2={POINTS[b].x} y2={POINTS[b].y}
          stroke={palette.gold}
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.85"
        />
      ))}

      {/* Highlight Active Mill */}
      {state.lastMillPoints.length > 0 && (
        <circle
          cx={POINTS[state.lastMillPoints[0]]?.x || 300}
          cy={POINTS[state.lastMillPoints[0]]?.y || 300}
          r="22"
          fill="none"
          stroke={palette.gold}
          strokeWidth="3"
          className="mlb-ring"
        />
      )}

      {/* Board Points and Pieces */}
      {POINTS.map((pt, i) => {
        const piece = state.points[i];
        const isLegal = showLegalHints && legalTargets.includes(i);
        const isSelected = state.selected === i;
        const isSelectable = showLegalHints && selectablePieces.includes(i);
        const isLastMoved = state.lastMoved?.to === i || state.lastMoved?.from === i;

        const effectiveStyle = (p: string) => {
          if (p === myRole) return pieceStyle;
          return opponentPieceStyle || pieceStyle;
        };

        return (
          <g
            key={i}
            onClick={() => interactive && onPointClick(i)}
            style={{ cursor: interactive && (isLegal || isSelectable || piece) ? "pointer" : "default" }}
            tabIndex={interactive ? 0 : -1}
            role="button"
            aria-label={`Point ${i + 1}${piece ? `, occupied by ${piece}` : ""}`}
            onKeyDown={(e) => {
              if (interactive && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onPointClick(i);
              }
            }}
          >
            <circle cx={pt.x} cy={pt.y} r="10" fill={palette.border} opacity="0.75" />

            {isLegal && (
              <circle
                cx={pt.x} cy={pt.y} r={pr + 4}
                fill={state.pendingCapture ? palette.copper : palette.gold}
                opacity={state.pendingCapture ? 0.45 : 0.5}
                className="mlb-pulse"
              />
            )}

            {piece && (
              <g className="mlb-pop">
                <circle cx={pt.x} cy={pt.y + 3} r={pr} fill="#000000" opacity="0.45" />
                <circle
                  cx={pt.x} cy={pt.y} r={pr}
                  fill={pieceFill(effectiveStyle(piece), piece === "P1" ? "url(#p1grad)" : "url(#p2grad)")}
                  stroke={isSelected ? palette.gold : "#00000077"}
                  strokeWidth={isSelected ? "3.5" : "1.5"}
                />
                <PieceTexture style={effectiveStyle(piece)} cx={pt.x} cy={pt.y} r={pr} />
              </g>
            )}

            {isSelectable && !isSelected && (
              <circle cx={pt.x} cy={pt.y} r={pr + 3} fill="none" stroke={palette.gold} strokeWidth="2" strokeDasharray="3 3" />
            )}

            {isLastMoved && !piece && (
              <circle cx={pt.x} cy={pt.y} r="6" fill={palette.gold} opacity="0.7" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* =========================================================================
   COMPONENTS
   ========================================================================= */

function PlayerCard({ name, role, active, state, palette, pieceStyle }: any) {
  const unplaced = PIECES_PER_PLAYER - state.placedCount[role];
  const onBoard = onBoardCount(state, role);

  return (
    <div
      className={`rounded-2xl p-4 transition-all border ${active ? "scale-[1.02]" : "opacity-80"}`}
      style={{
        background: active ? "var(--mlb-surface)" : "var(--mlb-surface2)",
        borderColor: active ? (role === "P1" ? palette.copper : palette.teal) : "var(--mlb-border)",
        boxShadow: active ? `0 4px 20px ${role === "P1" ? palette.copper : palette.teal}22` : "none",
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        <Avatar name={name} tone={role === "P1" ? palette.copper : palette.teal} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-sm truncate" style={{ color: "var(--mlb-text)" }}>{name}</h3>
            {active && <span className="w-2 h-2 rounded-full mlb-pulse" style={{ background: role === "P1" ? palette.copper : palette.teal }} />}
          </div>
          <p className="text-xs font-semibold opacity-70" style={{ color: "var(--mlb-textDim)" }}>
            {state.phase === "placement" ? `${unplaced} to place` : `${onBoard} on board`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-center text-xs">
        <div className="rounded-xl p-2" style={{ background: "var(--mlb-bg)" }}>
          <span className="block text-[10px] uppercase font-bold opacity-60" style={{ color: "var(--mlb-textDim)" }}>Lost</span>
          <span className="font-extrabold text-sm" style={{ color: "var(--mlb-text)" }}>{state.capturedCount[role]}</span>
        </div>
        <div className="rounded-xl p-2" style={{ background: "var(--mlb-bg)" }}>
          <span className="block text-[10px] uppercase font-bold opacity-60" style={{ color: "var(--mlb-textDim)" }}>Mills</span>
          <span className="font-extrabold text-sm" style={{ color: palette.gold }}>{state.millsFormed[role]}</span>
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ state, palette, myRole }: any) {
  if (state.gameOver) {
    return (
      <div className="rounded-xl p-3 text-center font-bold text-sm mlb-pop" style={{ background: palette.gold, color: "#1a1a1a" }}>
        🏆 Game Over! {state.gameOver.winner === "P1" ? "Player 1" : "Player 2"} wins by {state.gameOver.reason}!
      </div>
    );
  }

  if (state.pendingCapture) {
    const isMe = state.currentPlayer === myRole;
    return (
      <div className="rounded-xl p-3 text-center font-bold text-sm mlb-pulse" style={{ background: palette.copper, color: "#ffffff" }}>
        ⚡ {isMe ? "You formed a mill! Select an opponent's piece to capture." : "Opponent formed a mill and is capturing!"}
      </div>
    );
  }

  const isMyTurn = state.currentPlayer === myRole;
  return (
    <div className="rounded-xl p-3 text-center font-bold text-sm" style={{ background: "var(--mlb-surface2)", color: "var(--mlb-text)", border: "1px solid var(--mlb-border)" }}>
      {isMyTurn ? (
        state.phase === "placement" ? "Your turn: Place a piece on any open point" : "Your turn: Select a piece to move"
      ) : (
        "Waiting for opponent..."
      )}
    </div>
  );
}

function MoveHistory({ history, palette }: any) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [history]);

  return (
    <div className="rounded-2xl p-4 flex flex-col h-48 border" style={{ background: "var(--mlb-surface)", borderColor: "var(--mlb-border)" }}>
      <h4 className="font-bold text-xs uppercase tracking-wider mb-2 opacity-70" style={{ color: "var(--mlb-textDim)" }}>Move History</h4>
      <div className="flex-1 overflow-y-auto mlb-scroll space-y-1.5 pr-1">
        {history.length === 0 ? (
          <p className="text-xs italic opacity-50" style={{ color: "var(--mlb-textDim)" }}>No moves yet</p>
        ) : (
          history.map((m: any, idx: number) => (
            <div key={idx} className="text-xs flex items-center justify-between py-1 border-b opacity-90" style={{ borderColor: "var(--mlb-border)" }}>
              <span className="font-semibold opacity-60">#{m.n}</span>
              <span className="font-medium" style={{ color: m.player === "P1" ? palette.copper : palette.teal }}>
                {m.player}: {m.text}
              </span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function RulesModal({ onClose, palette }: any) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 mlb-fade-in">
      <div className="rounded-3xl max-w-lg w-full p-6 max-h-[85vh] overflow-y-auto mlb-scroll border relative" style={{ background: "var(--mlb-surface)", borderColor: "var(--mlb-border)", color: "var(--mlb-text)" }}>
        <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full hover:bg-black/10"><X size={20} /></button>
        <div className="flex items-center gap-3 mb-4">
          <ShieldMark palette={palette} size={36} />
          <h2 className="text-2xl font-bold mlb-display">How to Play Mlabalaba</h2>
        </div>
        <div className="space-y-4 text-sm leading-relaxed opacity-90">
          <div>
            <h3 className="font-bold text-base mb-1" style={{ color: palette.gold }}>1. Placement Phase</h3>
            <p>Players take turns placing their 12 pieces on open intersections. Forming 3 pieces in a straight line creates a <strong>Mill</strong>, allowing you to capture an opponent's piece.</p>
          </div>
          <div>
            <h3 className="font-bold text-base mb-1" style={{ color: palette.gold }}>2. Movement Phase</h3>
            <p>Once all pieces are placed, take turns moving pieces along lines to adjacent open spots. Forming new mills allows further captures.</p>
          </div>
          <div>
            <h3 className="font-bold text-base mb-1" style={{ color: palette.gold }}>3. Flying Phase</h3>
            <p>When reduced to just 3 pieces, a player gains the ability to "fly" to <em>any</em> open point on the board!</p>
          </div>
          <div>
            <h3 className="font-bold text-base mb-1" style={{ color: palette.gold }}>Winning</h3>
            <p>Reduce your opponent to fewer than 3 pieces or block all their possible legal moves to claim victory!</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   MAIN APP
   ========================================================================= */

export default function App() {
  const [theme, setTheme] = useState("dark");
  const [sound, setSound] = useState(true);
  const [mode, setMode] = useState<"menu" | "local" | "ai" | "online">("menu");
  const [difficulty, setDifficulty] = useState<"beginner" | "easy" | "medium" | "intermediate" | "advanced" | "expert">("expert");
  const [pieceStyle, setPieceStyle] = useState("isihlangu");
  const [gameState, setGameState] = useState(createInitialState);
  const [stats, setStats] = useState(defaultStats);
  const [showRules, setShowRules] = useState(false);

  // Online Multiplayer State
  const [roomCode, setRoomCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [myRole, setMyRole] = useState("P1");
  const [oppStyle, setOppStyle] = useState("ucu");
  const [loadingRoom, setLoadingRoom] = useState(false);
  const [onlineError, setOnlineError] = useState("");

  const palette = THEME[theme];
  const audio = useBeeper(sound);

  // Condition: Use custom board ONLY for Online matches or Expert AI matches
  const shouldUseCustomBoard = mode === "online" || (mode === "ai" && difficulty === "expert");

  useEffect(() => { loadStats().then(setStats); }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--mlb-bg", palette.bg);
    document.documentElement.style.setProperty("--mlb-surface", palette.surface);
    document.documentElement.style.setProperty("--mlb-surface2", palette.surface2);
    document.documentElement.style.setProperty("--mlb-border", palette.border);
    document.documentElement.style.setProperty("--mlb-text", palette.text);
    document.documentElement.style.setProperty("--mlb-textDim", palette.textDim);
    document.documentElement.style.setProperty("--mlb-gold", palette.gold);
  }, [palette]);

  // Handle Online Subscriptions
  useEffect(() => {
    if (mode !== "online" || !roomCode) return;
    const unsubscribe = subscribeToRoom(roomCode, (roomData: any) => {
      if (roomData?.state) {
        setGameState(roomData.state);
        if (roomData.p1_style && myRole === "P2") setOppStyle(roomData.p1_style);
        if (roomData.p2_style && myRole === "P1") setOppStyle(roomData.p2_style);
      }
    });
    return () => { unsubscribe(); };
  }, [mode, roomCode, myRole]);

  // Sound triggers
  const prevMoveCount = useRef(0);
  useEffect(() => {
    if (gameState.moveCount > prevMoveCount.current) {
      if (gameState.gameOver) audio.win();
      else if (gameState.pendingCapture) audio.mill();
      else audio.move();
      prevMoveCount.current = gameState.moveCount;
    }
  }, [gameState, audio]);

  // AI Turn trigger
  useEffect(() => {
    if (mode === "ai" && gameState.currentPlayer === "P2" && !gameState.gameOver) {
      const timer = setTimeout(() => {
        const action = chooseAiAction(gameState, "P2", difficulty);
        if (action) {
          setGameState((prev) => applyAction(prev, action));
        }
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [gameState, mode, difficulty]);

  // Handle Board Clicks
  const handlePointClick = (pointIndex: number) => {
    if (mode === "online" && gameState.currentPlayer !== myRole) return;

    let nextState = gameState;
    if (gameState.pendingCapture) {
      nextState = applyCapture(gameState, pointIndex);
    } else if (gameState.phase === "placement") {
      nextState = applyPlace(gameState, pointIndex);
    } else {
      nextState = applySelect(gameState, pointIndex);
    }

    if (nextState !== gameState) {
      setGameState(nextState);
      if (mode === "online" && roomCode) {
        pushRoomState(roomCode, nextState);
      }
    }
  };

  const startNewGame = (newMode: "local" | "ai" | "online") => {
    audio.click();
    setGameState(createInitialState());
    setMode(newMode);
    if (newMode === "ai") setMyRole("P1");
  };

  const handleCreateRoom = async () => {
    setLoadingRoom(true);
    setOnlineError("");
    try {
      const code = await createRoom(pieceStyle);
      setRoomCode(code);
      setMyRole("P1");
      setGameState(createInitialState());
      setMode("online");
    } catch (err) {
      setOnlineError("Failed to create room. Ensure Supabase is configured.");
    } finally {
      setLoadingRoom(false);
    }
  };

  const handleJoinRoom = async () => {
    if (!inputCode) return;
    setLoadingRoom(true);
    setOnlineError("");
    try {
      const room = await joinRoom(inputCode.toUpperCase(), pieceStyle);
      setRoomCode(room.code);
      setMyRole("P2");
      setOppStyle(room.p1_style || "isihlangu");
      if (room.state) setGameState(room.state);
      setMode("online");
    } catch (err) {
      setOnlineError("Room not found or full.");
    } finally {
      setLoadingRoom(false);
    }
  };

  return (
    <div className="mlb-root min-h-screen flex flex-col" style={{ background: "var(--mlb-bg)", color: "var(--mlb-text)" }}>
      <GlobalStyle />
      <PatternDefs palette={palette} />

      {/* Header */}
      <header className="px-6 py-4 flex items-center justify-between border-b" style={{ borderColor: "var(--mlb-border)", background: "var(--mlb-surface)" }}>
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setMode("menu")}>
          <ShieldMark palette={palette} size={32} />
          <h1 className="text-xl font-extrabold tracking-wide mlb-display" style={{ color: palette.gold }}>MLABALABA</h1>
        </div>
        <div className="flex items-center gap-2">
          <IconBtn icon={sound ? Volume2 : VolumeX} label="Toggle Sound" onClick={() => setSound(!sound)} />
          <IconBtn icon={theme === "dark" ? Sun : Moon} label="Toggle Theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
          <IconBtn icon={BookOpen} label="How to Play" onClick={() => setShowRules(true)} />
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 max-w-5xl mx-auto w-full">
        {mode === "menu" && (
          <div className="w-full max-w-md space-y-6 text-center mlb-fade-in">
            <div className="space-y-2">
              <h2 className="text-3xl font-extrabold mlb-display">The Ancient Game of Strategy</h2>
              <p className="text-sm opacity-70">A traditional African board game of skill, capture, and mills.</p>
            </div>

            <div className="p-4 rounded-2xl border space-y-3" style={{ background: "var(--mlb-surface)", borderColor: "var(--mlb-border)" }}>
              <span className="text-xs font-bold uppercase tracking-wider block opacity-70">Choose Piece Style</span>
              <PieceStylePicker value={pieceStyle} onChange={setPieceStyle} palette={palette} options={ONLINE_PIECE_STYLES} />
            </div>

            <div className="space-y-3">
              <button onClick={() => startNewGame("ai")} className="w-full py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-all hover:opacity-90" style={{ background: palette.gold, color: "#1a1a1a" }}>
                <Bot size={20} /> Play vs Computer
              </button>
              <button onClick={() => startNewGame("local")} className="w-full py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-all border hover:bg-black/5" style={{ borderColor: "var(--mlb-border)" }}>
                <Users size={20} /> Local Pass & Play
              </button>

              <div className="pt-2 border-t space-y-2" style={{ borderColor: "var(--mlb-border)" }}>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="ENTER ROOM CODE"
                    value={inputCode}
                    onChange={(e) => setInputCode(e.target.value)}
                    className="flex-1 rounded-xl px-4 text-sm font-mono tracking-wider uppercase border focus:outline-none"
                    style={{ background: "var(--mlb-surface2)", borderColor: "var(--mlb-border)" }}
                  />
                  <button onClick={handleJoinRoom} disabled={loadingRoom} className="px-4 py-2.5 rounded-xl font-bold text-sm" style={{ background: palette.teal, color: "#fff" }}>
                    Join
                  </button>
                </div>
                <button onClick={handleCreateRoom} disabled={loadingRoom} className="w-full py-2.5 rounded-xl font-bold text-sm border hover:bg-black/5 flex items-center justify-center gap-2" style={{ borderColor: "var(--mlb-border)" }}>
                  {loadingRoom ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />} Create Online Room
                </button>
                {onlineError && <p className="text-xs text-red-500">{onlineError}</p>}
              </div>
            </div>
          </div>
        )}

        {mode !== "menu" && (
          <div className="w-full grid md:grid-cols-12 gap-6 items-start">
            {/* Left Sidebar */}
            <div className="md:col-span-3 space-y-4">
              <button onClick={() => setMode("menu")} className="flex items-center gap-2 text-xs font-bold opacity-70 hover:opacity-100">
                <ArrowLeft size={16} /> Main Menu
              </button>

              {mode === "ai" && (
                <div className="p-3 rounded-xl border space-y-2" style={{ background: "var(--mlb-surface2)", borderColor: "var(--mlb-border)" }}>
                  <span className="text-[10px] font-bold uppercase opacity-60 block">AI Difficulty</span>
                  <div className="grid grid-cols-3 gap-1">
                    {(["easy", "intermediate", "expert"] as const).map((lvl) => (
                      <button
                        key={lvl}
                        onClick={() => setDifficulty(lvl)}
                        className={`py-1 text-[11px] font-bold capitalize rounded transition ${
                          difficulty === lvl ? "bg-amber-500 text-black" : "opacity-60 hover:opacity-100"
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {mode === "online" && (
                <div className="p-3 rounded-xl border text-center space-y-1" style={{ background: "var(--mlb-surface2)", borderColor: "var(--mlb-border)" }}>
                  <span className="text-[10px] font-bold uppercase opacity-60">Room Code</span>
                  <div className="font-mono font-bold text-lg tracking-widest text-emerald-500">{roomCode}</div>
                </div>
              )}

              <PlayerCard
                name={mode === "ai" ? "Player 1 (You)" : mode === "online" ? (myRole === "P1" ? "You (P1)" : "Opponent (P1)") : "Player 1"}
                role="P1"
                active={gameState.currentPlayer === "P1"}
                state={gameState}
                palette={palette}
                pieceStyle={myRole === "P1" ? pieceStyle : oppStyle}
              />

              <PlayerCard
                name={mode === "ai" ? `Bot (${difficulty})` : mode === "online" ? (myRole === "P2" ? "You (P2)" : "Opponent (P2)") : "Player 2"}
                role="P2"
                active={gameState.currentPlayer === "P2"}
                state={gameState}
                palette={palette}
                pieceStyle={myRole === "P2" ? pieceStyle : oppStyle}
              />
            </div>

            {/* Board Area */}
            <div className="md:col-span-6 flex flex-col items-center gap-4">
              <StatusBanner state={gameState} palette={palette} myRole={myRole} />
              <div className="w-full flex items-center justify-center p-2 rounded-3xl" style={{ background: "var(--mlb-surface)", border: "1px solid var(--mlb-border)" }}>
                <Board
                  state={gameState}
                  onPointClick={handlePointClick}
                  interactive={!gameState.gameOver}
                  palette={palette}
                  myRole={myRole}
                  pieceStyle={pieceStyle}
                  opponentPieceStyle={oppStyle}
                  shouldUseCustomBoard={shouldUseCustomBoard}
                />
              </div>
            </div>

            {/* Right Sidebar */}
            <div className="md:col-span-3 space-y-4">
              <MoveHistory history={gameState.moveHistory} palette={palette} />
              <button
                onClick={() => setGameState(createInitialState())}
                className="w-full py-2.5 rounded-xl font-bold text-xs border flex items-center justify-center gap-2 hover:bg-black/5"
                style={{ borderColor: "var(--mlb-border)" }}
              >
                <RotateCcw size={14} /> Restart Game
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Rules Modal */}
      {showRules && <RulesModal onClose={() => setShowRules(false)} palette={palette} />}
    </div>
  );
}