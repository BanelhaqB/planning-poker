# Project context — Poker Sizing

> Handover note so an agent (or a new dev) can take over development with full
> context. Last updated: 2026-07-22.

## What this is

A lightweight, real-time **poker sizing** app (à la planningpokeronline.com),
built to run entirely on **Cloudflare Workers**. Teams create/join rooms, vote on
estimates with a configurable scale, reveal cards together, and keep a history.
The product is branded "Poker Sizing" (was renamed from "Planning Poker").

Repo: `BanelhaqB/planning-poker` (GitHub, public). Note: the repo slug, Worker
name and D1 database name are still `planning-poker` (deploy identifiers, left
unchanged on purpose); only user-facing branding is "Poker Sizing".

## Tech decisions (and why)

- **TypeScript on Cloudflare Workers** — Workers run JS/TS natively; no separate
  backend to host. Chosen for a light, cheap, easy-to-deploy stack.
- **Durable Objects for room state** — one DO instance per room
  (`ROOM.idFromName(roomId)`) holds the live game state and every participant's
  WebSocket, so all clients in a room share one authoritative state.
- **WebSocket Hibernation API** — the DO costs nothing while idle (no billed
  wall-clock time when nobody is sending messages).
- **D1 (SQLite) for history** — free, native to Workers, real SQL for querying
  past rounds/votes. Google Sheets was considered and rejected (quotas, latency,
  not a real DB).
- **Single-file vanilla frontend** — the app is `public/app.html` and the SEO
  landing is `public/index.html` (both HTML+CSS+JS, no framework, no build step),
  served as static assets by the Worker.

## Architecture

```
Browser ──WebSocket─►  Worker (src/index.ts)  ──►  Room Durable Object (src/room.ts)
                                                     • live room state
                                                     • all participant sockets
                                                     • broadcasts state on change
                                                     • writes finished rounds to D1
public/index.html   ← SEO landing (served at /)
public/app.html     ← the app (served at /app and /room/<id>)
D1 (SQLite)         ← rooms / rounds / votes; read via /api/room/:id/history
```

### Routes (Worker)
- `GET /api/room/:id/ws` → upgrade to WebSocket, handed to the Room DO.
- `GET /api/room/:id/history` → reads past rounds + votes from D1, returns JSON.
- `/app` and `/room/<id>` → serve `public/app.html` (the app).
- `/` and everything else → static assets; `/` is the **SEO landing**
  (`public/index.html`). Unknown paths fall back to the landing.

### WebSocket protocol (client → server)
`join {name, spectator}`, `vote {value}`, `reveal`, `reset`,
`set_scale {scale[]}`, `set_topic {topic}`, `set_spectator {spectator}`,
`rename {name}`.
Server → client: a single `state` snapshot after every change. **Vote values are
only included in the snapshot once `revealed` is true** (no cheating over the wire).

## Files

```
wrangler.toml        Worker + Durable Object + D1 bindings
schema.sql           D1 tables (rooms, rounds, votes)
src/index.ts         Worker entry: routing (WS, history, app, static)
src/room.ts          Room Durable Object: state, voting, broadcast, D1 writes
public/index.html    SEO landing page (served at /)
public/app.html      The app (served at /app and /room/<id>)
public/robots.txt, sitemap.xml, og-image.png, favicon.svg   SEO assets
.github/workflows/deploy.yml   GitHub Actions auto-deploy (see "Pending setup")
README.md            User-facing setup/run/deploy docs
```

## Features implemented

- Rooms by code, shareable `/room/<id>` links, Invite button (copies link).
- Invite links open a focused "Join room" screen (room known from URL, name only).
- Voters and spectators; toggle between the two from the top bar.
- Configurable voting scale with presets. **Default scale is "Fibonacci Lite"
  `1,3,5,8,13`** (set in `DEFAULT_SCALE` in `src/room.ts` and as the first preset
  in `app.html`). Other presets: Fibonacci, Modified Fib, T-shirt, Powers of 2,
  Yes/No. Custom scales via the Scale modal.
- Live vote status ("x / y voted"), reveal, new round / reset.
- **3-2-1 reveal countdown** on every reveal — client-side, in
  `startRevealCountdown()` in `app.html`. Full-screen overlay with a popping
  number; cards stay face-down during the count, then flip in. It is
  **unconditional** (always runs on reveal), NOT gated on consensus.
- **Confetti + "Unanimité" banner ONLY on unanimity** — `celebrate()` in
  `app.html`, fired at the end of the countdown when `stats.consensus` is true.
- **Unanimity definition** (server, `computeStats` in `src/room.ts`): at least 2
  voters, everyone has voted, all the same value.
- Average is computed from numeric votes only (non-numeric like `?`/`☕` ignored).
- **History**: on each reveal the DO writes a `rounds` row + one `votes` row per
  voter to D1; the History button in the top bar fetches
  `/api/room/:id/history` and lists past rounds (topic, time, average/unanimity,
  per-voter chips).
- **SEO landing** at `/`: full marketing content, meta + Open Graph + Twitter
  tags, JSON-LD (WebApplication + FAQPage), robots.txt, sitemap.xml, og-image.png.

## Current state / pending setup

The code is complete and typechecks clean. Manual setup steps remain before the
deployed app fully works:

1. **D1 database id** — `wrangler.toml` still has the placeholder
   `database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"`. Must run
   `wrangler d1 create planning-poker` (or `wrangler d1 list` if it already
   exists), paste the real UUID into `wrangler.toml`, then apply the schema:
   ```bash
   wrangler d1 execute planning-poker --local  --file=./schema.sql
   wrangler d1 execute planning-poker --remote --file=./schema.sql
   ```
   Until the real id is in place, `wrangler deploy` and remote `d1 execute` fail
   with "Invalid uuid".

2. **Auto-deploy secrets** — `.github/workflows/deploy.yml` deploys on push to
   `main` but needs repo secrets `CLOUDFLARE_API_TOKEN` (template: "Edit
   Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`. The remote D1 schema (step 1)
   should be applied before/with the first deploy.

3. **SEO domain placeholder** — the landing (`public/index.html`),
   `sitemap.xml` and `robots.txt` use `https://your-domain.com`. Replace with the
   real domain once chosen so canonical/OG/sitemap URLs are correct.

Note: the GitHub token in use lacks the `workflow` scope, so the workflow file
had to be added manually rather than pushed via the API. git push over HTTPS with
that token also returns 403 (write not granted for the git protocol); commits in
this project were made via the GitHub API instead. Binary files (og-image.png)
can't be pushed via the API tool and must be uploaded manually.

## Sensible next steps / ideas (not yet built)

- Per-round timer.
- Reaction emojis.
- Server-driven countdown (current countdown is client-side, so it's near- but
  not perfectly synchronized across clients).
- A rooms list / dashboard reading the `rooms` table.
- Deploy-time remote D1 migration step in the CI workflow.
- Blog/content pages for SEO.
- Consider `wrangler@4` upgrade (currently pinned to v3; CLI warns it's
  out-of-date).

## Local dev

```bash
npm install
npm run dev        # wrangler dev, http://localhost:8787
npm run typecheck  # tsc --noEmit
```
Open two browser windows on the same room code to see live sync.
