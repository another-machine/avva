/// <reference types="node" />
/**
 * server/relay.ts  —  WebSocket broadcast relay for avva.
 *
 * Every connected client receives every message sent by any other client.
 * Used to sync the store across machines (phone controller ↔ desktop main window).
 *
 * Usage:
 *   npm run relay                   # default port 3001
 *   PORT=9000 npm run relay
 *
 * Then open the controller at:
 *   http://<your-lan-ip>:5173/controller/?relay=ws://<your-lan-ip>:3001
 *
 * The relay is intentionally minimal — no authentication, no rooms, no
 * persistence. It is a LAN-local dev tool, not a public service. Do not
 * expose it to the internet without adding auth.
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createServer } from "node:http";

const PORT = Number(process.env["PORT"] ?? 3001);
const HOST = process.env["HOST"] ?? "0.0.0.0";

// ── HTTP health-check alongside the WS server ─────────────────────────────────

const http = createServer((_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(`avva-relay ok  clients=${wss.clients.size}\n`);
});

const wss = new WebSocketServer({ server: http });

// ── Connection handling ───────────────────────────────────────────────────────

wss.on("connection", (socket: WebSocket, req) => {
  const addr = req.socket.remoteAddress ?? "?";
  log(`+ ${addr}  (${wss.clients.size} connected)`);

  socket.on("message", (data: RawData) => {
    // Forward store patches (have a `key` field) and telemetry frames (have a `t` field).
    // Drop anything that doesn't match either shape to avoid amplifying garbage.
    const text = data.toString();
    try {
      const p = JSON.parse(text) as unknown;
      if (!p || typeof p !== "object") return;
      const obj = p as Record<string, unknown>;
      const isPatch = "key" in obj;
      const isTelemetry = !isPatch && "t" in obj && typeof obj["t"] === "number";
      if (!isPatch && !isTelemetry) return;
    } catch {
      return; // drop non-JSON
    }

    for (const client of wss.clients) {
      if (client !== socket && client.readyState === WebSocket.OPEN) {
        client.send(text);
      }
    }
  });

  socket.on("close", () => {
    log(`- ${addr}  (${wss.clients.size} connected)`);
  });

  socket.on("error", (err: Error) => {
    console.error(`[avva-relay] error from ${addr}:`, err.message);
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

http.listen(PORT, HOST, () => {
  const iface = HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : HOST;
  log(`listening on ws://${iface}:${PORT}`);
  log(`health check: http://localhost:${PORT}/`);
});

process.on("SIGTERM", () => {
  log("SIGTERM received — shutting down");
  wss.close(() => http.close(() => process.exit(0)));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[avva-relay ${ts}] ${msg}`);
}
