/**
 * Room Durable Object.
 *
 * One instance per room. Holds the live game state and every participant's
 * WebSocket. Uses the WebSocket Hibernation API so the DO costs nothing while
 * idle (no billed wall-clock time when nobody is sending messages).
 *
 * Live state lives in the DO; permanent history (rooms / rounds / votes) is
 * written to D1 (env.DB) at each reveal so it can be queried later.
 *
 * State shape (persisted in DO storage so a room survives hibernation/eviction):
 *   {
 *     scale:    string[]      // the voting scale, e.g. ["1","2","3","5","8","?"]
 *     revealed: boolean       // are votes currently shown?
 *     topic:    string        // optional story/ticket label
 *   }
 *
 * Per-connection state lives on the socket via serializeAttachment:
 *   { id, name, spectator, vote }
 */

export interface RoomEnv {
  DB: D1Database;
}

interface Member {
  id: string;
  name: string;
  spectator: boolean;
  vote: string | null;
}

interface RoomState {
  scale: string[];
  revealed: boolean;
  topic: string;
}

// "Fibonacci Lite" — the essential Fibonacci steps, no extremes.
const DEFAULT_SCALE = ["1", "3", "5", "8", "13"];

// Messages the client can send.
type ClientMsg =
  | { type: "join"; name: string; spectator: boolean }
  | { type: "vote"; value: string }
  | { type: "reveal" }
  | { type: "reset" }
  | { type: "set_scale"; scale: string[] }
  | { type: "set_topic"; topic: string }
  | { type: "set_spectator"; spectator: boolean }
  | { type: "rename"; name: string };

export class Room implements DurableObject {
  private state: DurableObjectState;
  private env: RoomEnv;
  private room!: RoomState;
  private roomId = "";
  private loaded = false;

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.state.storage.get<RoomState>("room");
    this.room = stored ?? { scale: DEFAULT_SCALE, revealed: false, topic: "" };
    const savedId = await this.state.storage.get<string>("roomId");
    if (savedId) this.roomId = savedId;
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.state.storage.put("room", this.room);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    await this.load();

    // Capture the room name from the URL so the DO can tag its D1 rows.
    const m = new URL(request.url).pathname.match(/\/api\/room\/([^/]+)\/ws$/);
    if (m && !this.roomId) {
      this.roomId = decodeURIComponent(m[1]);
      await this.state.storage.put("roomId", this.roomId);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept with hibernation support.
    this.state.acceptWebSocket(server);

    // Give the socket a provisional identity until the client sends "join".
    const member: Member = {
      id: crypto.randomUUID(),
      name: "",
      spectator: false,
      vote: null,
    };
    server.serializeAttachment(member);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Hibernation event handlers -------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.load();
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    const me = ws.deserializeAttachment() as Member;

    switch (msg.type) {
      case "join":
        me.name = (msg.name || "Anon").slice(0, 40);
        me.spectator = !!msg.spectator;
        me.vote = null;
        ws.serializeAttachment(me);
        this.touchRoom();
        break;

      case "rename":
        me.name = (msg.name || me.name).slice(0, 40);
        ws.serializeAttachment(me);
        break;

      case "set_spectator":
        me.spectator = !!msg.spectator;
        if (me.spectator) me.vote = null;
        ws.serializeAttachment(me);
        break;

      case "vote":
        if (!me.spectator && this.room.scale.includes(msg.value)) {
          me.vote = msg.value;
          ws.serializeAttachment(me);
        }
        break;

      case "reveal":
        this.room.revealed = true;
        await this.save();
        await this.persistRound();
        break;

      case "reset":
        this.room.revealed = false;
        this.clearAllVotes();
        await this.save();
        break;

      case "set_scale":
        if (Array.isArray(msg.scale) && msg.scale.length > 0) {
          this.room.scale = msg.scale.map((s) => String(s).slice(0, 8)).slice(0, 24);
          this.room.revealed = false;
          this.clearAllVotes();
          await this.save();
        }
        break;

      case "set_topic":
        this.room.topic = String(msg.topic || "").slice(0, 120);
        await this.save();
        break;
    }

    this.broadcastState();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    await this.load();
    this.broadcastState();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.load();
    this.broadcastState();
  }

  // ---- Members / stats ------------------------------------------------------

  private members(): Member[] {
    const list: Member[] = [];
    for (const ws of this.state.getWebSockets()) {
      const m = ws.deserializeAttachment() as Member | null;
      if (m && m.name) list.push(m);
    }
    return list;
  }

  private computeStats(
    voters: Member[],
  ): { average: number | null; consensus: boolean; distribution: { value: string; count: number }[] } {
    const votesIn = voters.filter((m) => m.vote !== null).length;
    const numeric = voters.map((m) => Number(m.vote)).filter((n) => Number.isFinite(n));
    const average =
      numeric.length > 0 ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null;
    const cast = voters.filter((m) => m.vote !== null).map((m) => m.vote as string);
    // True unanimity: at least 2 voters, everyone voted, all the same value.
    const consensus = voters.length > 1 && votesIn === voters.length && new Set(cast).size === 1;
    const distribution = this.tallyVotes(cast, this.room.scale);
    return { average, consensus, distribution };
  }

  /** Count occurrences per scale value, sorted by count desc, ties broken by scale order. */
  private tallyVotes(cast: string[], scale: string[]): { value: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const v of cast) counts.set(v, (counts.get(v) ?? 0) + 1);
    const scaleIndex = new Map(scale.map((v, i) => [v, i]));
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (scaleIndex.get(a.value) ?? 0) - (scaleIndex.get(b.value) ?? 0));
  }

  private clearAllVotes(): void {
    for (const ws of this.state.getWebSockets()) {
      const m = ws.deserializeAttachment() as Member | null;
      if (m) {
        m.vote = null;
        ws.serializeAttachment(m);
      }
    }
  }

  // ---- D1 persistence -------------------------------------------------------

  /** Upsert the room row (created_at once, last_active refreshed). */
  private touchRoom(): void {
    if (!this.roomId) return;
    const now = Date.now();
    this.state.waitUntil(
      this.env.DB.prepare(
        `INSERT INTO rooms (id, created_at, last_active) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_active = excluded.last_active`,
      )
        .bind(this.roomId, now, now)
        .run()
        .catch((e) => console.error("touchRoom failed", e)),
    );
  }

  /** Write a finished round (topic, stats) and its votes to D1. */
  private async persistRound(): Promise<void> {
    if (!this.roomId) return;
    const voters = this.members().filter((m) => !m.spectator);
    const cast = voters.filter((m) => m.vote !== null);
    if (cast.length === 0) return; // nothing to record

    const { average, consensus } = this.computeStats(voters);
    const roundId = crypto.randomUUID();
    const now = Date.now();

    const statements = [
      this.env.DB.prepare(
        `INSERT INTO rooms (id, created_at, last_active) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_active = excluded.last_active`,
      ).bind(this.roomId, now, now),
      this.env.DB.prepare(
        `INSERT INTO rounds (id, room_id, topic, scale, average, consensus, voter_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        roundId,
        this.roomId,
        this.room.topic || null,
        JSON.stringify(this.room.scale),
        average,
        consensus ? 1 : 0,
        voters.length,
        now,
      ),
      ...cast.map((m) =>
        this.env.DB.prepare(
          `INSERT INTO votes (round_id, voter_name, value) VALUES (?, ?, ?)`,
        ).bind(roundId, m.name, m.vote as string),
      ),
    ];

    try {
      await this.env.DB.batch(statements);
    } catch (e) {
      console.error("persistRound failed", e);
    }
  }

  // ---- Broadcast ------------------------------------------------------------

  private broadcastState(): void {
    const sockets = this.state.getWebSockets();
    const members = this.members();

    const revealed = this.room.revealed;
    const voters = members.filter((m) => !m.spectator);
    const votesIn = voters.filter((m) => m.vote !== null).length;

    let stats: {
      average: string | null;
      consensus: boolean;
      distribution: { value: string; count: number }[];
    } = {
      average: null,
      consensus: false,
      distribution: [],
    };
    if (revealed) {
      const { average, consensus, distribution } = this.computeStats(voters);
      stats = { average: average !== null ? average.toFixed(1) : null, consensus, distribution };
    }

    const payload = JSON.stringify({
      type: "state",
      scale: this.room.scale,
      topic: this.room.topic,
      revealed,
      votesIn,
      voterCount: voters.length,
      stats,
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        spectator: m.spectator,
        hasVoted: m.vote !== null,
        // Only leak the actual value when revealed.
        vote: revealed ? m.vote : null,
      })),
    });

    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        /* dead socket, will be cleaned up on close */
      }
    }
  }
}
