import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from 'cors';
import { errorHandler } from "./middleware/error.middleware.js";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.routes.js";
import videoRoutes from "./routes/video.routes.js";
import { reconcileQueue } from "./lib/reconcileQueue.js";
import { startReconcileWorker } from "./jobs/reconcilePendingVideos.js";

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/videos', videoRoutes);

app.use("/health", async (req, res) => {
  res.json({ status: "ok" });
});

app.use(errorHandler);

const PORT = process.env.PORT || 4000;

app.listen(PORT, async () => {
  console.log(`server is running on port ${PORT}`);

  await reconcileQueue.upsertJobScheduler(
    "reconcile-pending-videos-schedule",
    { every: 15 * 60 * 1000 },
    { name: "reconcile" },
  );

  startReconcileWorker();
});