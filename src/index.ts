/**
 * Worker entry point.
 *
 *  - /api/room/:id/ws       -> upgrade to WebSocket and hand off to the Room DO
 *  - /api/room/:id/history  -> read past rounds + votes for a room from D1
 *  - /app and /room/:id      -> serve the poker app (app.html)
 *  - everything else         -> serve static assets (SEO landing at /)
 */

export { Room } from "./room";

interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  DB: D1Database;
}

const ROOM_ID = "[A-Za-z0-9_-]{1,64}";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket -> Room Durable Object
    const wsMatch = url.pathname.match(new RegExp(`^/api/room/(${ROOM_ID})/ws$`));
    if (wsMatch) {
      const id = env.ROOM.idFromName(wsMatch[1]);
      return env.ROOM.get(id).fetch(request);
    }

    // History -> D1
    const histMatch = url.pathname.match(new RegExp(`^/api/room/(${ROOM_ID})/history$`));
    if (histMatch) {
      return history(histMatch[1], env);
    }

    // The poker app itself lives at /app and /room/<id>; both serve app.html.
    const isAppRoute =
      url.pathname === "/app" ||
      new RegExp(`^/room/(${ROOM_ID})$`).test(url.pathname);
    if (isAppRoute) {
      return env.ASSETS.fetch(new Request(new URL("/app", url), request));
    }

    // Everything else -> static assets (SEO landing at /, robots, sitemap, …).
    // Unknown paths fall back to the landing page.
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return res;
  },
};

interface RoundRow {
  id: string;
  topic: string | null;
  scale: string | null;
  average: number | null;
  consensus: number;
  voter_count: number;
  created_at: number;
}

interface VoteRow {
  round_id: string;
  voter_name: string;
  value: string;
}

async function history(roomId: string, env: Env): Promise<Response> {
  try {
    const rounds = await env.DB.prepare(
      `SELECT id, topic, scale, average, consensus, voter_count, created_at
       FROM rounds WHERE room_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(roomId)
      .all<RoundRow>();

    const roundIds = (rounds.results ?? []).map((r) => r.id);
    let votesByRound: Record<string, { name: string; value: string }[]> = {};

    if (roundIds.length > 0) {
      const placeholders = roundIds.map(() => "?").join(",");
      const votes = await env.DB.prepare(
        `SELECT round_id, voter_name, value FROM votes WHERE round_id IN (${placeholders})`,
      )
        .bind(...roundIds)
        .all<VoteRow>();

      for (const v of votes.results ?? []) {
        (votesByRound[v.round_id] ??= []).push({ name: v.voter_name, value: v.value });
      }
    }

    const payload = {
      roomId,
      rounds: (rounds.results ?? []).map((r) => ({
        id: r.id,
        topic: r.topic,
        scale: r.scale ? JSON.parse(r.scale) : [],
        average: r.average,
        consensus: r.consensus === 1,
        voterCount: r.voter_count,
        createdAt: r.created_at,
        votes: votesByRound[r.id] ?? [],
      })),
    };

    return Response.json(payload);
  } catch (e) {
    return Response.json({ roomId, rounds: [], error: String(e) }, { status: 200 });
  }
}
