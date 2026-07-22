# Planning Poker

A lightweight planning poker app on **Cloudflare Workers + Durable Objects**.
No database, no build step — one Worker, one Durable Object per room, WebSockets
for real-time sync.

## Features

- Create / join rooms by code (shareable `/room/<id>` links)
- Voters and spectators
- Custom voting scales (Fibonacci, T-shirt, powers of 2… or your own)
- Live vote status, reveal cards, average + consensus detection
- New round / reset
- Sober, single-file UI (no framework, no dependencies)

## Architecture

```
Browser ──WebSocket─►  Worker (src/index.ts)  ──►  Room Durable Object (src/room.ts)
                                                     • holds live room state
                                                     • holds every participant socket
                                                     • broadcasts state on every change
public/index.html  ← served as a static asset by the Worker
```

One room = one Durable Object instance (`idFromName(roomId)`), so all
participants of a room share the same in-memory state. The WebSocket
**Hibernation API** means the room costs nothing while idle.

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

Durable Objects are included in the Workers **Free** plan (SQLite-backed
classes), so this deploys and runs at no cost for small teams.

## Project layout

```
wrangler.toml        Worker + Durable Object config
src/index.ts         Worker entry: WS routing + static assets
src/room.ts          Room Durable Object (state, voting, broadcast)
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
