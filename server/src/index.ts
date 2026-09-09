import { app } from "./app.js";
import { reconcileQueue } from "./lib/reconcileQueue.js";
import { startReconcileWorker } from "./jobs/reconcilePendingVideos.js";
import { setupWebSocketServer } from "./lib/ws.js";

const PORT = process.env.PORT || 4000;
const ENABLE_WEBSOCKETS = process.env.ENABLE_WEBSOCKETS !== "false";

const httpServer = app.listen(PORT, async () => {
  console.log(`server is running on port ${PORT}`);
  await reconcileQueue.upsertJobScheduler(
    "reconcile-pending-videos-schedule",
    { every: 15 * 60 * 1000 },
    { name: "reconcile" },
  );
  startReconcileWorker();
});

if (ENABLE_WEBSOCKETS) {
  setupWebSocketServer(httpServer);
  await import("./lib/queueEvents.js");
  console.log("WebSocket live progress enabled");
} else {
  console.log("WebSocket live progress disabled (ENABLE_WEBSOCKETS=false)");
}