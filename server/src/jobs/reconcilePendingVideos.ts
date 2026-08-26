import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { Worker } from "bullmq";
import { prisma } from "../lib/prisma.js";
import { r2 } from "../lib/r2.js";
import { connection } from "../lib/redis.js";

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

async function reconcilePendingVideos(): Promise<void> {
  if (!R2_BUCKET_NAME) throw new Error("R2_BUCKET_NAME is not set in .env");

  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const staleVideos = await prisma.video.findMany({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
  });

  for (const video of staleVideos) {
    try {
      await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: video.originalUrl }));
      console.log(`[reconcile] Video ${video.id} has a file in R2 but was never completed — left for manual review`);
    } catch {
      console.log(`[reconcile] Video ${video.id} has no file in R2 — deleting orphaned row`);
      await prisma.video.delete({ where: { id: video.id } });
    }
  }
}

export function startReconcileWorker() {
  new Worker(
    "reconcile-pending-videos",
    async () => {
      await reconcilePendingVideos();
    },
    { connection },
  );
}