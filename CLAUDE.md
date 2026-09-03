# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This App Is

Iron Ledger is a privacy-first gym tracking PWA. All user data (profile, photos, measurements, logs, meal plans) lives in browser `localStorage` only. The only server component is the optional Crew community board backed by Upstash Redis via a Vercel serverless function.

## Running and Deploying

There is **no build step**. The entire frontend is a single `index.html` file with embedded CSS and JS — no bundler, no transpiler, no framework.

- **Local dev**: Open `index.html` directly in a browser, or use any static file server (`npx serve .`, `python3 -m http.server`, VS Code Live Server, etc.)
- **Deploy**: `npx vercel` (preview) / `npx vercel --prod` (production)
- **Service worker**: Bump `CACHE` version string in `sw.js` to force a refresh on installed PWAs after changes

There are no npm scripts, no tests, and no lint commands — `package.json` exists only to declare `"type": "module"` and the Node ≥20 engine requirement for the serverless function.

## Architecture

The entire app lives in `index.html` (~1600 lines). Structure within that file:

```
<head>  — CSS design tokens, component styles
<body>  — Tab bar + 5 view containers (today, body, plan, fuel, crew)
<script>
  Constants  — DEF defaults, exercise DB (65+ exercises), food DB (50+ foods), meal templates (30+ cuisines)
  State      — Single object S, load()/save() to localStorage
  Routing    — show(view) switches tabs, render() dispatches to view-specific functions
  Views      — renderToday(), renderBody(), renderPlan(), renderFuel(), renderCrew()
  Algorithms — weekShape(), pickExercise(), nutritionTargets(), buildDay(), macro solver
```

**State management**: One global `S` object holds everything. All mutations call `save()` then re-call the current view's render function. No virtual DOM — views are re-rendered via `innerHTML`.

**Key algorithms**:
- `weekShape()` → selects day templates based on profile; `pickExercise()` fills slots avoiding weekly repeats
- `nutritionTargets()` → Mifflin-St Jeor TDEE + goal adjustments; `buildDay()` + 3-pass macro solver (protein → fat → carbs) scales portion weights to hit targets
- Body caliper tool: drag SVG handles on uploaded photo, pixel distances → real widths via height scaling → ratios → V-taper score → training priorities

**Service worker** (`sw.js`): API routes always bypass cache; navigation uses network-first; static assets use cache-first with background refresh.

**Serverless backend** (`api/crew.js`): Reads/writes to Upstash Redis. Rate-limits posts to 1 per IP per minute using Redis SET NX+EX. Sanitizes input. Env vars: `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel integration) or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (direct). Optional `CREW_PASSCODE` gates writes.

## Key Customization Points (from README)

When extending the app, these are the relevant constants inside `index.html`:
- Exercise database: `EXERCISES` array
- Food database: `FOODS` array
- Meal templates: `MEALS` array (also `CUISINES` list)
- Training split templates: `SPLITS` / `WEEK_SHAPES`
- Set targets per experience level: `SETS_BY_EXP`
- Volume targets per muscle: `VOL_TARGETS`
- Research desk entries: `RESEARCH` array

## Planned Feature Area: AI Image Analysis

The user intends to integrate a free vision model to analyze uploaded workout/physique photos. The existing photo upload flow is in `renderBody()` — photos are resized to 620px max and stored as base64 DataURLs in `localStorage`. An AI analysis feature would:
1. Accept the stored DataURL from `S.photos[]`
2. Send to a free vision API (e.g., Google Gemini free tier, Hugging Face Inference API, or a Vercel Edge Function proxying the call)
3. Return structured analysis (muscle visibility, posture, estimated body fat range, form feedback)
4. Display results alongside the existing caliper measurements in the Body tab

New API routes should follow the pattern in `api/crew.js` — plain Node.js fetch-based handlers deployed as Vercel serverless functions.

## Design System

CSS uses custom properties for all colors, spacing, and typography. Key tokens: `--ground`, `--surface`, `--ink`, `--accent`, `--good`, `--warn`, `--bad`. Light/dark modes are automatic via `prefers-color-scheme`. Responsive breakpoint at 620px. Layout utilities: `.wrap` (760px max-width), `.card`, `.stack`, `.row`, `.grid2/.grid3/.grid4`, `.between`. Interactive components: `.chip` (toggle), `.meter` (progress bar), toast via `toast(msg)` function.
