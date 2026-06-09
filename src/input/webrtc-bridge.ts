/**
 * src/input/webrtc-bridge.ts
 *
 * Same-origin WebRTC loopback between two browser tabs. Uses BroadcastChannel
 * for signaling (offer / answer / ICE) so no server is required.
 *
 * Two roles:
 *   - Broadcaster: holds a MediaStream and accepts incoming "hello" pings
 *     from listeners. On each hello, creates a fresh RTCPeerConnection,
 *     attaches the stream's tracks, and ships the offer back addressed to
 *     that listener's id. Supports multiple simultaneous listeners.
 *   - Listener: pings periodically until a broadcaster replies, then
 *     resolves with the received MediaStream.
 *
 * Channel name defaults to "avva-audio-bridge" — distinct from the store's
 * "avva-store" channel so signaling traffic doesn't collide.
 *
 * DEBUGGING: set BRIDGE_DEBUG = true (default) and open DevTools in BOTH the
 * source (?view=va) and LISTEN (?view=av) tabs. You'll see, per tab:
 *   listener  → hello #N         (the LISTEN tab is pinging)
 *   broadcaster ← hello from …   (the source tab is hearing the pings)
 *   broadcaster → offer / idle   (the source tab is replying)
 *   listener  ← offer / idle     (the LISTEN tab is hearing the reply)
 * If the LISTEN tab logs hellos but the source tab never logs "← hello",
 * the two tabs are NOT on the same BroadcastChannel (different browser
 * profile / Incognito / origin) — no code change can bridge that.
 */

const DEFAULT_CHANNEL = "avva-audio-bridge";
const HELLO_INTERVAL_MS = 1200;

// Flip to false to silence the connection trace.
const BRIDGE_DEBUG = true;
function blog(role: string, ...args: unknown[]): void {
  if (BRIDGE_DEBUG) {
    console.log(
      `%c[avva-bridge ${role}]`,
      "color:#5cf;font-weight:bold",
      ...args,
    );
  }
}

type Sdp = { type: RTCSdpType; sdp: string };

type SignalMsg =
  | { kind: "hello"; from: string }
  | { kind: "ready"; from: string }
  | { kind: "idle"; from: string; to: string }
  | { kind: "offer"; from: string; to: string; sdp: Sdp }
  | { kind: "answer"; from: string; to: string; sdp: Sdp }
  | { kind: "ice"; from: string; to: string; candidate: RTCIceCandidateInit }
  | { kind: "bye"; from: string };

function _randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function _makePC(): RTCPeerConnection {
  // Empty iceServers is fine for same-machine loopback. Add STUN/TURN here
  // later if these tabs ever need to negotiate across NAT.
  return new RTCPeerConnection({ iceServers: [] });
}

// ── Broadcaster ───────────────────────────────────────────────────────────────

export interface BroadcasterBridge {
  /** Replace (or set) the stream that future listeners will receive. */
  setStream(stream: MediaStream | null): void;
  /** Number of currently connected listeners. */
  readonly listenerCount: number;
  /** Stop signaling and tear down every peer. */
  close(): void;
}

export function startBroadcaster(
  channelName: string = DEFAULT_CHANNEL,
): BroadcasterBridge {
  const myId = _randomId();
  const bc = new BroadcastChannel(channelName);
  const peers = new Map<string, RTCPeerConnection>();
  let currentStream: MediaStream | null = null;

  blog("broadcaster", "START id=" + myId, "channel=" + channelName);

  function send(msg: SignalMsg): void {
    bc.postMessage(msg);
  }

  async function handleHello(listenerId: string): Promise<void> {
    blog("broadcaster", "← hello from " + listenerId, "hasStream=" + !!currentStream);
    if (!currentStream) {
      // We're here but have nothing to send yet (e.g. the synth is off). Tell
      // the listener so it can show an accurate status rather than looking like
      // no broadcaster exists at all.
      send({ kind: "idle", from: myId, to: listenerId });
      blog("broadcaster", "→ idle to " + listenerId, "(no stream yet — is the synth ON?)");
      return;
    }
    // Tear down any previous peer for this listener so we always negotiate fresh.
    const prev = peers.get(listenerId);
    if (prev) {
      prev.close();
      peers.delete(listenerId);
    }
    const pc = _makePC();
    peers.set(listenerId, pc);

    for (const track of currentStream.getTracks()) {
      pc.addTrack(track, currentStream);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send({
          kind: "ice",
          from: myId,
          to: listenerId,
          candidate: ev.candidate.toJSON(),
        });
      }
    };
    pc.onconnectionstatechange = () => {
      blog("broadcaster", "pc[" + listenerId + "] " + pc.connectionState);
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed" ||
        pc.connectionState === "disconnected"
      ) {
        peers.delete(listenerId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({
      kind: "offer",
      from: myId,
      to: listenerId,
      sdp: { type: offer.type, sdp: offer.sdp ?? "" },
    });
    blog("broadcaster", "→ offer to " + listenerId);
  }

  bc.onmessage = (ev) => {
    const m = ev.data as SignalMsg;
    if (!m || typeof m !== "object") return;
    if (m.kind === "hello") {
      void handleHello(m.from);
    } else if (m.kind === "answer" && m.to === myId) {
      blog("broadcaster", "← answer from " + m.from);
      const pc = peers.get(m.from);
      if (!pc) return;
      void pc.setRemoteDescription(m.sdp);
    } else if (m.kind === "ice" && m.to === myId) {
      const pc = peers.get(m.from);
      if (!pc) return;
      void pc.addIceCandidate(m.candidate).catch(() => {});
    } else if (m.kind === "bye") {
      const pc = peers.get(m.from);
      if (pc) {
        pc.close();
        peers.delete(m.from);
      }
    }
  };

  return {
    setStream(stream: MediaStream | null) {
      currentStream = stream;
      if (stream) {
        // Announce to any listeners already waiting that we have a stream now.
        send({ kind: "ready", from: myId });
        blog("broadcaster", "setStream tracks=" + stream.getTracks().length, "→ ready");
      } else {
        blog("broadcaster", "setStream(null) — no longer publishing");
      }
    },
    get listenerCount() {
      return peers.size;
    },
    close() {
      blog("broadcaster", "close id=" + myId);
      send({ kind: "bye", from: myId });
      for (const pc of peers.values()) pc.close();
      peers.clear();
      bc.close();
    },
  };
}

// ── Listener ──────────────────────────────────────────────────────────────────

export interface ListenerBridge {
  /** True once a remote track has been received. */
  readonly connected: boolean;
  /** Stop pinging, tear down the peer, close the channel. */
  close(): void;
}

export interface ListenerOptions {
  channelName?: string;
  /** Called with the first received MediaStream. */
  onStream: (stream: MediaStream) => void;
  /** Called when the peer connection state changes (connecting/connected/failed). */
  onState?: (
    state: "searching" | "idle" | "connecting" | "connected" | "failed",
  ) => void;
}

export function startListener(opts: ListenerOptions): ListenerBridge {
  const channelName = opts.channelName ?? DEFAULT_CHANNEL;
  const myId = _randomId();
  const bc = new BroadcastChannel(channelName);
  let pc: RTCPeerConnection | null = null;
  let broadcasterId: string | null = null;
  let connected = false;
  let helloTimer: ReturnType<typeof setInterval> | null = null;
  let helloCount = 0;

  blog("listener", "START id=" + myId, "channel=" + channelName);

  function setState(
    s: "searching" | "idle" | "connecting" | "connected" | "failed",
  ): void {
    blog("listener", "state=" + s);
    opts.onState?.(s);
  }

  function send(msg: SignalMsg): void {
    bc.postMessage(msg);
  }

  function sayHello(): void {
    if (connected) return;
    helloCount++;
    send({ kind: "hello", from: myId });
    blog("listener", "→ hello #" + helloCount + " (waiting for a broadcaster to reply)");
  }

  function startHelloLoop(): void {
    if (helloTimer) return;
    sayHello();
    helloTimer = setInterval(sayHello, HELLO_INTERVAL_MS);
  }

  function stopHelloLoop(): void {
    if (helloTimer) {
      clearInterval(helloTimer);
      helloTimer = null;
    }
  }

  async function handleOffer(from: string, sdp: Sdp): Promise<void> {
    // Lock onto the first broadcaster that offers. If other broadcasters offer
    // (multiple source tabs open), ignore them while our chosen one is alive —
    // switching peers mid-handshake makes us thrash and never connect. We reuse
    // the same RTCPeerConnection for renegotiations from the same broadcaster.
    if (broadcasterId && broadcasterId !== from) {
      blog("listener", "ignoring offer from " + from + " (already locked to " + broadcasterId + ")");
      return;
    }
    broadcasterId = from;
    if (!pc) {
      pc = _makePC();
      pc.ontrack = (ev) => {
        const stream = ev.streams[0];
        if (!stream) return;
        connected = true;
        stopHelloLoop();
        blog("listener", "✓ STREAM received, tracks=" + stream.getTracks().length);
        setState("connected");
        opts.onStream(stream);
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate && broadcasterId) {
          send({
            kind: "ice",
            from: myId,
            to: broadcasterId,
            candidate: ev.candidate.toJSON(),
          });
        }
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        const st = pc.connectionState;
        blog("listener", "pc " + st);
        if (st === "failed" || st === "disconnected" || st === "closed") {
          connected = false;
          broadcasterId = null; // release the lock so we can re-select a broadcaster
          try { pc.close(); } catch { /* already gone */ }
          pc = null;
          setState(st === "failed" ? "failed" : "searching");
          startHelloLoop();
        }
      };
    }
    setState("connecting");
    await pc.setRemoteDescription(sdp);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    send({
      kind: "answer",
      from: myId,
      to: from,
      sdp: { type: ans.type, sdp: ans.sdp ?? "" },
    });
    blog("listener", "→ answer to " + from);
  }

  bc.onmessage = (ev) => {
    const m = ev.data as SignalMsg;
    if (!m || typeof m !== "object") return;
    // Trace every inbound signal so it's obvious whether the broadcaster's
    // replies are reaching us at all. (We never receive our own messages.)
    const to = "to" in m ? m.to : "";
    blog("listener", "← " + m.kind + (to ? " to:" + to : "") + " from:" + ("from" in m ? m.from : "?"));
    if (m.kind === "offer" && m.to === myId) {
      void handleOffer(m.from, m.sdp);
    } else if (m.kind === "ice" && m.to === myId && pc) {
      void pc.addIceCandidate(m.candidate).catch(() => {});
    } else if (m.kind === "ready" && !connected) {
      // Broadcaster announced — kick off a hello immediately.
      sayHello();
    } else if (m.kind === "idle" && m.to === myId && !connected) {
      // A broadcaster exists but isn't publishing audio yet (synth off).
      setState("idle");
    } else if (m.kind === "bye" && m.from === broadcasterId) {
      if (pc) {
        pc.close();
        pc = null;
      }
      broadcasterId = null;
      connected = false;
      startHelloLoop();
      setState("searching");
    }
  };

  setState("searching");
  startHelloLoop();

  return {
    get connected() {
      return connected;
    },
    close() {
      blog("listener", "close id=" + myId);
      stopHelloLoop();
      send({ kind: "bye", from: myId });
      if (pc) pc.close();
      pc = null;
      bc.close();
    },
  };
}
