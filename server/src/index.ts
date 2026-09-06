import { app } from "./app.js";
import { reconcileQueue } from "./lib/reconcileQueue.js";
import { startReconcileWorker } from "./jobs/reconcilePendingVideos.js";
import { setupWebSocketServer } from "./lib/ws.js";
import "./lib/queueEvents.js";

const PORT = process.env.PORT || 4000;

const httpServer = app.listen(PORT, async () => {
  console.log(`server is running on port ${PORT}`);
  await reconcileQueue.upsertJobScheduler(
    "reconcile-pending-videos-schedule",
    { every: 15 * 60 * 1000 },
    { name: "reconcile" },
  );
  startReconcileWorker();
});

setupWebSocketServer(httpServer);