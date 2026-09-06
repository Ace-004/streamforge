import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { parseCookie } from "cookie";
import { verifyToken } from "../utils/jwt.js";
import { prisma } from "./prisma.js";

type AuthedSocket = WebSocket & { userId?: string };

const subscriptions = new Map<string, Set<AuthedSocket>>(); // videoId -> sockets watching it

export function setupWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const cookies = parseCookie(req.headers.cookie ?? "");
    const token = cookies.token;

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let userId: string;
    try {
      userId = verifyToken(token).userId;
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: AuthedSocket) => {
      ws.userId = userId;
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: AuthedSocket) => {
    const mySubscriptions = new Set<string>();

    ws.on("message", async (raw) => {
      let msg: { type?: string; videoId?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (msg.type === "subscribe" && typeof msg.videoId === "string") {
        const video = await prisma.video.findUnique({ where: { id: msg.videoId } });
        if (!video || video.userId !== ws.userId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authorized for this video" }));
          return;
        }
        if (!subscriptions.has(msg.videoId)) subscriptions.set(msg.videoId, new Set());
        subscriptions.get(msg.videoId)!.add(ws);
        mySubscriptions.add(msg.videoId);
        ws.send(JSON.stringify({ type: "subscribed", videoId: msg.videoId }));
      }
    });

    ws.on("close", () => {
      for (const videoId of mySubscriptions) {
        const set = subscriptions.get(videoId);
        set?.delete(ws);
        if (set && set.size === 0) subscriptions.delete(videoId);
      }
    });
  });
}

export function broadcastToVideo(videoId: string, payload: unknown) {
  const sockets = subscriptions.get(videoId);
  if (!sockets) return;
  const message = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}