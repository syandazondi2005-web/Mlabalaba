# Mlabalaba

A modern web version of **Mlabalaba** — a two-player strategy board game in the
Morabaraba family, played on a 24-point board with mills, captures, and flying.

Built with React, TypeScript, Vite, and Tailwind CSS. Play locally against a
friend, against an AI opponent with four difficulty levels, or online in
real time via Supabase.

## Features

- **Full rules engine** — placement, movement, and flying phases; all 20 mill
  lines (including the diagonal lines that distinguish Mlabalaba from
  Nine Men's Morris); capture rules; win by piece count or by blocking.
- **AI opponent** — Beginner, Intermediate, Advanced, and Expert, using a
  heuristic + depth-limited minimax search.
- **Local 2-player** — pass-and-play on one device.
- **Online multiplayer** — create or join a room with a 5-character code;
  moves sync in real time via Supabase.
- **Player profiles** — remaining pieces, captured pieces, mills formed, win
  rate, streaks.
- **Interactive tutorial** — 8 steps covering the board, placement, movement,
  mills, capturing, winning, and strategy, each with a live mini board.
- **Match history, stats, undo, light/dark theme, sound toggle.**
- Fully responsive — desktop, tablet, and mobile.

## Tech stack

- React 18 + TypeScript
- Vite
- Tailwind CSS
- Lucide icons
- Supabase (Postgres + Realtime) for online multiplayer

## Getting started locally

```bash
git clone https://github.com/syandazondi2005-web/Mlabalaba.git
cd Mlabalaba
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

The game runs fully offline (AI and local 2-player) without any further
setup. Online multiplayer requires a Supabase project — see below.

## Enabling online multiplayer

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase SQL Editor, run the contents of `supabase-setup.sql`
   (creates the `rooms` table and turns on realtime for it).
3. Copy `.env.example` to `.env` and fill in your project's URL and anon key
   from **Project Settings → API**:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```
4. Restart `npm run dev`.

Without a configured `.env`, the Online Multiplayer screen explains that
it's not connected rather than pretending it works — every other mode
(AI, local, practice, tutorial) works with no configuration at all.

## Project structure

```
src/
  App.tsx          # engine, AI, and all UI components
  lib/
    supabase.ts    # Supabase client
    rooms.ts       # create/join/sync room helpers
  main.tsx
  index.css
supabase-setup.sql  # run once in Supabase's SQL Editor
```

## Building for production

```bash
npm run build
```

Output goes to `dist/`. Deploy that folder to any static host (Vercel,
Netlify, GitHub Pages, etc.) — just make sure to set the same
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` environment variables on the
host if you want online multiplayer to work in production too.

## License

Personal project — add a license of your choice if you plan to distribute it.
