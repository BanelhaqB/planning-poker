/**
 * Worker entry point.
 *
 * Responsibilities:
 *  - /api/room/:id/ws  -> upgrade to WebSocket and hand off to the Room DO
 *  - everything else    -> serve static assets (the frontend in ./public)
 */

export { Room } from "./room";

interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/room\/([A-Za-z0-9_-]{1,64})\/ws$/);

    if (match) {
      const roomId = match[1];
      // idFromName gives every room name its own single, consistent DO instance.
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // Fallback: static frontend. Unknown deep links resolve to index.html so
    // /room/<id> works as a client-side route.
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return res;
  },
};
