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
 */

const DEFAULT_CHANNEL = "avva-audio-bridge";
const HELLO_INTERVAL_MS = 1200;

type Sdp = { type: RTCSdpType; sdp: string };

type SignalMsg =
  | { kind: "hello"; from: string }
  | { kind: "ready"; from: string }
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

  function send(msg: SignalMsg): void {
    bc.postMessage(msg);
  }

  async function handleHello(listenerId: string): Promise<void> {
    if (!currentStream) return;
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
  }

  bc.onmessage = (ev) => {
    const m = ev.data as SignalMsg;
    if (!m || typeof m !== "object") return;
    if (m.kind === "hello") {
      void handleHello(m.from);
    } else if (m.kind === "answer" && m.to === myId) {
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
      }
    },
    get listenerCount() {
      return peers.size;
    },
    close() {
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
  onState?: (state: "searching" | "connecting" | "connected" | "failed") => void;
}

export function startListener(opts: ListenerOptions): ListenerBridge {
  const channelName = opts.channelName ?? DEFAULT_CHANNEL;
  const myId = _randomId();
  const bc = new BroadcastChannel(channelName);
  let pc: RTCPeerConnection | null = null;
  let broadcasterId: string | null = null;
  let connected = false;
  let helloTimer: ReturnType<typeof setInterval> | null = null;

  function setState(s: "searching" | "connecting" | "connected" | "failed"): void {
    opts.onState?.(s);
  }

  function send(msg: SignalMsg): void {
    bc.postMessage(msg);
  }

  function sayHello(): void {
    if (connected) return;
    send({ kind: "hello", from: myId });
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
    // Reuse the same RTCPeerConnection across renegotiations from the same
    // broadcaster, but recreate if the broadcaster id changed.
    if (pc && broadcasterId !== from) {
      pc.close();
      pc = null;
    }
    broadcasterId = from;
    if (!pc) {
      pc = _makePC();
      pc.ontrack = (ev) => {
        const stream = ev.streams[0];
        if (!stream) return;
        connected = true;
        stopHelloLoop();
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
        if (pc.connectionState === "failed") setState("failed");
        if (pc.connectionState === "disconnected" || pc.connectionState === "closed") {
          connected = false;
          startHelloLoop();
          setState("searching");
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
  }

  bc.onmessage = (ev) => {
    const m = ev.data as SignalMsg;
    if (!m || typeof m !== "object") return;
    if (m.kind === "offer" && m.to === myId) {
      void handleOffer(m.from, m.sdp);
    } else if (m.kind === "ice" && m.to === myId && pc) {
      void pc.addIceCandidate(m.candidate).catch(() => {});
    } else if (m.kind === "ready" && !connected) {
      // Broadcaster announced — kick off a hello immediately.
      sayHello();
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
      stopHelloLoop();
      send({ kind: "bye", from: myId });
      if (pc) pc.close();
      pc = null;
      bc.close();
    },
  };
}
