# Planning Poker

A lightweight planning poker app on **Cloudflare Workers + Durable Objects**.
No build step — one Worker, one Durable Object per room, WebSockets for real-time
sync, and a free D1 database for history.

## Features

- Create / join rooms by code (shareable `/room/<id>` links)
- Voters and spectators
- Custom voting scales (Fibonacci, T-shirt, powers of 2… or your own)
- Live vote status, 3-2-1 reveal countdown, average + unanimity detection with confetti
- New round / reset
- Persistent history (rooms, rounds, votes) in Cloudflare D1, browsable per room
- Sober, single-file UI (no framework, no dependencies)

## Architecture

```
Browser ──WebSocket─►  Worker (src/index.ts)  ──►  Room Durable Object (src/room.ts)
                                                     • holds live room state
                                                     • holds every participant socket
                                                     • broadcasts state on every change
                                                     • writes finished rounds to D1
public/index.html  ← served as a static asset by the Worker
D1 (SQLite)        ← rooms / rounds / votes history, read via /api/room/:id/history
```

One room = one Durable Object instance (`idFromName(roomId)`), so all
participants of a room share the same in-memory state. The WebSocket
**Hibernation API** means the room costs nothing while idle.

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
```

Open two browser windows on the same room code to see live sync.

## Deploy

```bash
npx wrangler login   # once
npm run deploy
```

Durable Objects and D1 are included in the Workers **Free** plan, so this deploys
and runs at no cost for small teams.

## Project layout

```
wrangler.toml        Worker + Durable Object + D1 config
schema.sql           D1 tables (rooms, rounds, votes)
src/index.ts         Worker entry: WS routing, history API, static assets
src/room.ts          Room Durable Object (state, voting, broadcast, D1 writes)
public/index.html    Frontend (HTML + CSS + JS, single file)
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
