var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "LuXync Signalling Server",
          version: "2.0.0",
          phase: 2
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Upgrade, Connection"
        }
      });
    }
    if (url.pathname === "/signal") {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") {
        return new Response(
          "WebSocket upgrade required",
          { status: 426 }
        );
      }
      const syncId = url.searchParams.get("sync_id");
      if (!syncId) {
        return new Response("Missing sync_id", { status: 400 });
      }
      if (!/^lx_[a-zA-Z0-9]{16}$/.test(syncId)) {
        return new Response(
          "Invalid sync_id format. Must be lx_ followed by 16 alphanumeric characters.",
          { status: 400 }
        );
      }
      const role = url.searchParams.get("role");
      if (!role || !["master", "slave"].includes(role)) {
        return new Response(
          "Invalid role. Must be master or slave.",
          { status: 400 }
        );
      }
      const doId = env.LUXYNC_SESSION.idFromName(syncId);
      const doStub = env.LUXYNC_SESSION.get(doId);
      return doStub.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
var LuXyncSession = class {
  static {
    __name(this, "LuXyncSession");
  }
  constructor(state, env) {
    this.state = state;
    this.master = null;
    this.peers = /* @__PURE__ */ new Map();
    this.peerCounter = 0;
  }
  /**
   * Handle an incoming WebSocket connection.
   * Called for every request forwarded from the main Worker.
   * Creates the peer record, sends welcome, registers handlers.
   */
  async fetch(request) {
    const [client, server] = Object.values(
      new WebSocketPair()
    );
    server.accept();
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    this.peerCounter++;
    const peerId = `${role}_${Date.now()}_${this.peerCounter}`;
    const peer = {
      socket: server,
      role,
      peer_id: peerId,
      version: 0,
      // document version this peer currently has
      pieces: {}
      // piece_id -> version number
    };
    this.peers.set(peerId, peer);
    if (role === "master") {
      if (this.master !== null) {
        server.send(JSON.stringify({
          type: "error",
          code: "MASTER_EXISTS",
          message: "A master is already registered for this sync_id"
        }));
        server.close(1008, "Master already connected");
        this.peers.delete(peerId);
        return new Response(null, {
          status: 101,
          webSocket: client
        });
      }
      this.master = server;
    }
    server.send(JSON.stringify({
      type: "welcome",
      peer_id: peerId,
      role,
      session: {
        master_online: this.master !== null,
        peer_count: this.peers.size,
        // List of all other peers with their current inventory.
        // New peer uses this to initiate WebRTC connections.
        peers: Array.from(this.peers.values()).filter((p) => p.peer_id !== peerId).map((p) => ({
          peer_id: p.peer_id,
          role: p.role,
          version: p.version,
          // Include piece inventory so new peer knows
          // who has what pieces at what version
          pieces: p.pieces
        }))
      }
    }));
    this._broadcast(
      {
        type: "peer_joined",
        peer: {
          peer_id: peerId,
          role,
          version: 0,
          pieces: {}
        }
      },
      peerId
      // exclude the new peer — it already has its welcome
    );
    server.addEventListener("message", (event) => {
      this._handleMessage(peerId, event.data);
    });
    server.addEventListener("close", () => {
      this._handleDisconnect(peerId);
    });
    server.addEventListener("error", () => {
      this._handleDisconnect(peerId);
    });
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
  /**
   * Handle a message from a peer.
   * All messages are JSON with a 'type' field.
   * Routes to the correct handler based on type.
   *
   * MESSAGE TYPES:
   *
   * update_inventory — peer reports its current piece versions.
   *   {
   *     type: 'update_inventory',
   *     version: 8,
   *     pieces: { index_html: 8, styles_css: 7, script_js: 8 }
   *   }
   *
   * signal — WebRTC signalling message for a specific peer.
   *   {
   *     type: 'signal',
   *     to: 'slave_1234_1',
   *     signal_type: 'offer' | 'answer' | 'ice_candidate',
   *     data: { ... }   <- WebRTC data, Worker never reads this
   *   }
   *
   * query_peers — ask which peers have specific pieces.
   *   {
   *     type: 'query_peers',
   *     pieces: ['index_html', 'styles_css']
   *   }
   */
  _handleMessage(fromPeerId, rawData) {
    const peer = this.peers.get(fromPeerId);
    if (!peer) return;
    let message;
    try {
      message = JSON.parse(rawData);
    } catch (e) {
      console.error(
        `LuXync: malformed message from ${fromPeerId}`
      );
      return;
    }
    switch (message.type) {
      /**
       * Peer reports its current document version and
       * piece inventory. Broadcast to all other peers so
       * they know this peer has newer data available.
       */
      case "update_inventory":
        peer.version = message.version || 0;
        peer.pieces = message.pieces || {};
        this._broadcast(
          {
            type: "peer_updated",
            peer_id: fromPeerId,
            version: peer.version,
            pieces: peer.pieces
          },
          fromPeerId
          // don't send back to the sender
        );
        break;
      /**
       * WebRTC signalling message to be forwarded to a
       * specific peer. The Worker routes it without reading
       * the signal data. Used for offer, answer, and
       * ICE candidate exchange during WebRTC setup.
       */
      case "signal":
        this._forwardSignal(fromPeerId, message);
        break;
      /**
       * Slave asks which peers have specific pieces.
       * Worker responds with matching peers and their
       * piece versions so the slave can pick who to
       * connect to for each piece.
       */
      case "query_peers":
        this._handlePeerQuery(fromPeerId, message.pieces);
        break;
      default:
        console.warn(
          `LuXync: unknown message type '${message.type}' from ${fromPeerId}`
        );
    }
  }
  /**
   * Forward a WebRTC signalling message from one peer to another.
   * The Worker never interprets the signal data — it just routes
   * the envelope to the correct peer socket.
   *
   * @param {string} fromPeerId - Sender peer_id
   * @param {Object} message    - Parsed message from sender
   */
  _forwardSignal(fromPeerId, message) {
    const targetPeer = this.peers.get(message.to);
    if (!targetPeer) {
      const fromPeer = this.peers.get(fromPeerId);
      if (fromPeer) {
        fromPeer.socket.send(JSON.stringify({
          type: "error",
          code: "PEER_NOT_FOUND",
          message: `Peer ${message.to} not found or disconnected`
        }));
      }
      return;
    }
    targetPeer.socket.send(JSON.stringify({
      type: "signal",
      from: fromPeerId,
      signal_type: message.signal_type,
      data: message.data
      // forwarded unchanged
    }));
  }
  /**
   * Handle a peer query for who has specific pieces.
   * Searches all connected peers' piece inventories and
   * returns those that have any of the requested pieces.
   *
   * The querying peer uses this to decide who to connect
   * to via WebRTC to fetch specific pieces.
   *
   * @param {string}   fromPeerId       - Peer making the query
   * @param {string[]} requestedPieces  - List of piece IDs wanted
   */
  _handlePeerQuery(fromPeerId, requestedPieces) {
    if (!requestedPieces || !Array.isArray(requestedPieces)) {
      return;
    }
    const matchingPeers = Array.from(this.peers.values()).filter((p) => {
      if (p.peer_id === fromPeerId) return false;
      return requestedPieces.some(
        (pieceId) => p.pieces[pieceId] !== void 0
      );
    }).map((p) => ({
      peer_id: p.peer_id,
      role: p.role,
      version: p.version,
      // Only include the relevant pieces in the response —
      // no need to send the full inventory
      pieces: Object.fromEntries(
        requestedPieces.filter((id) => p.pieces[id] !== void 0).map((id) => [id, p.pieces[id]])
      )
    }));
    const fromPeer = this.peers.get(fromPeerId);
    if (fromPeer) {
      fromPeer.socket.send(JSON.stringify({
        type: "peer_query_result",
        requested_pieces: requestedPieces,
        peers: matchingPeers
      }));
    }
  }
  /**
   * Handle a peer disconnecting.
   * Cleans up state and notifies all remaining peers.
   *
   * @param {string} peerId - The disconnecting peer's ID
   */
  _handleDisconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.role === "master") {
      this.master = null;
    }
    this.peers.delete(peerId);
    this._broadcast({
      type: "peer_left",
      peer_id: peerId,
      role: peer.role
    });
    console.log(
      `LuXync: peer ${peerId} (${peer.role}) disconnected. ${this.peers.size} peers remaining.`
    );
  }
  /**
   * Broadcast a message to all connected peers except one.
   * Used to fan out events like peer_joined and peer_left.
   *
   * @param {Object} message       - Message object to send
   * @param {string} excludePeerId - Peer to skip (or null to send to all)
   */
  _broadcast(message, excludePeerId) {
    const json = JSON.stringify(message);
    for (const [peerId, peer] of this.peers) {
      if (peerId !== excludePeerId) {
        try {
          peer.socket.send(json);
        } catch (e) {
          console.warn(
            `LuXync: failed to send to ${peerId}:`,
            e
          );
        }
      }
    }
  }
};
export {
  LuXyncSession,
  index_default as default
};
//# sourceMappingURL=index.js.map
