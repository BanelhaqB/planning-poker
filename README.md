# Poker Sizing

A lightweight, real-time **poker sizing** app on **Cloudflare Workers +
Durable Objects**, with a free **D1** database for history and an SEO landing
page. No build step, no framework.

## Features

- Free, no sign-up, no ads, no tracking, open-source
- Create / join rooms by code (shareable `/room/<id>` links)
- Voters and spectators
- Custom voting scales (default **Fibonacci Lite** `1 3 5 8 13`, plus Fibonacci,
  T-shirt, powers of two… or your own)
- Live vote status, 3-2-1 reveal countdown, average + unanimity detection with confetti
- New round / reset
- Persistent history (rooms, rounds, votes) in Cloudflare D1, browsable per room
- SEO landing page with meta/OG tags, JSON-LD and FAQ

## Architecture

```
Browser ──WebSocket─►  Worker (src/index.ts)  ──►  Room Durable Object (src/room.ts)
                                                     • live room state
                                                     • all participant sockets
                                                     • broadcasts state on change
                                                     • writes finished rounds to D1
public/index.html  ← SEO landing (served at /)
public/app.html    ← the app (served at /app and /room/<id>)
D1 (SQLite)        ← rooms / rounds / votes, read via /api/room/:id/history
```

One room = one Durable Object instance (`idFromName(roomId)`), so all
participants share the same in-memory state. The WebSocket **Hibernation API**
means a room costs nothing while idle.

## Pages & routes

- `/` → **SEO landing page** (`public/index.html`) — indexed by search engines.
- `/app` and `/room/<id>` → **the app** (`public/app.html`).
- `/api/room/:id/ws` → WebSocket to the Room DO.
- `/api/room/:id/history` → round/vote history from D1.

> **Before going live**, replace `https://your-domain.com` with your real domain
> in `public/index.html`, `public/sitemap.xml` and `public/robots.txt`.

## Persistence (Cloudflare D1)

History is stored in a free D1 (SQLite) database. One-time setup:

```bash
# 1. Create the database, then paste the returned database_id into wrangler.toml
wrangler d1 create planning-poker

# 2. Apply the schema (local dev DB)
wrangler d1 execute planning-poker --local --file=./schema.sql

# 3. Apply the schema to the remote DB (before first deploy)
wrangler d1 execute planning-poker --remote --file=./schema.sql
```

At each reveal the Room DO writes a `rounds` row plus one `votes` row per voter.
The frontend reads them back via `GET /api/room/:id/history` (the **History** button).

## Run locally

```bash
npm install
npm run dev        # wrangler dev — opens http://localhost:8787
npm run typecheck  # tsc --noEmit
```

Open two browser windows on the same room code to see live sync.

## Deploy

```bash
npx wrangler login   # once
npm run deploy
```

Durable Objects and D1 are included in the Workers **Free** plan, so this deploys
and runs at no cost for small teams. Auto-deploy on push to `main` is configured
in `.github/workflows/deploy.yml` (needs the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repo secrets).

## Project layout

```
wrangler.toml        Worker + Durable Object + D1 config
schema.sql           D1 tables (rooms, rounds, votes)
src/index.ts         Worker entry: routing (WS, history, app, static)
src/room.ts          Room Durable Object (state, voting, broadcast, D1 writes)
public/index.html    SEO landing page
public/app.html      The app (HTML + CSS + JS, single file)
public/robots.txt    Crawler directives + sitemap link
public/sitemap.xml   Sitemap
public/og-image.png  Social share image (1200x630)
public/favicon.svg   Favicon
```

## WebSocket protocol

Client → server:

| type            | payload                    |
|-----------------|----------------------------|
| `join`          | `{ name, spectator }`      |
| `vote`          | `{ value }`                |
| `reveal`        | —                          |
| `reset`         | —                          |
| `set_scale`     | `{ scale: string[] }`      |
| `set_topic`     | `{ topic }`                |
| `set_spectator` | `{ spectator }`            |
| `rename`        | `{ name }`                 |

Server → client: a single `state` message (full snapshot) after every change.
Individual vote values are only included once `revealed` is `true`.
