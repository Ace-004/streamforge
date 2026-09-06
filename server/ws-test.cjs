const WebSocket = require("ws");
const { execSync } = require("child_process");

// Reads your existing cookies.txt (curl format) and extracts the token cookie
const fs = require("fs");
const cookiesRaw = fs.readFileSync("C:/Users/ayush/cookies.txt", "utf8");
const match = cookiesRaw.match(/token\s+([^\s]+)\s*$/m);
if (!match) {
  console.error("Could not find token cookie in cookies.txt");
  process.exit(1);
}
const token = match[1];

const videoId = process.argv[2];
if (!videoId) {
  console.error("Usage: node ws-test.js <videoId>");
  process.exit(1);
}

const ws = new WebSocket("ws://localhost:4000", {
  headers: { Cookie: `token=${token}` },
});

ws.on("open", () => {
  console.log("Connected. Subscribing to", videoId);
  ws.send(JSON.stringify({ type: "subscribe", videoId }));
});

ws.on("message", (data) => {
  console.log("MESSAGE:", data.toString());
});

ws.on("close", () => console.log("Connection closed"));
ws.on("error", (err) => console.error("WS error:", err.message));