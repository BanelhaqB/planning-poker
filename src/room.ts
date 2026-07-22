/**
 * Room Durable Object.
 *
 * One instance per room. Holds the live game state and every participant's
 * WebSocket. Uses the WebSocket Hibernation API so the DO costs nothing while
 * idle (no billed wall-clock time when nobody is sending messages).
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
  private room!: RoomState;
  private loaded = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.state.storage.get<RoomState>("room");
    this.room = stored ?? { scale: DEFAULT_SCALE, revealed: false, topic: "" };
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

  // ---- Helpers --------------------------------------------------------------

  private clearAllVotes(): void {
    for (const ws of this.state.getWebSockets()) {
      const m = ws.deserializeAttachment() as Member | null;
      if (m) {
        m.vote = null;
        ws.serializeAttachment(m);
      }
    }
  }

  private broadcastState(): void {
    const sockets = this.state.getWebSockets();
    const members: Member[] = [];
    for (const ws of sockets) {
      const m = ws.deserializeAttachment() as Member | null;
      if (m && m.name) members.push(m);
    }

    const revealed = this.room.revealed;
    const voters = members.filter((m) => !m.spectator);
    const votesIn = voters.filter((m) => m.vote !== null).length;

    // Consensus / average is only computed once revealed.
    let stats: { average: string | null; consensus: boolean } = {
      average: null,
      consensus: false,
    };
    if (revealed) {
      const numeric = voters
        .map((m) => Number(m.vote))
        .filter((n) => Number.isFinite(n));
      if (numeric.length > 0) {
        const avg = numeric.reduce((a, b) => a + b, 0) / numeric.length;
        stats.average = avg.toFixed(1);
      }
      const cast = voters.filter((m) => m.vote !== null).map((m) => m.vote);
      stats.consensus = cast.length > 1 && new Set(cast).size === 1;
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
