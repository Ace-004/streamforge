import { connection } from "./redis.js";
import { QueueEvents } from "bullmq";
import { broadcastToVideo } from "./ws.js";
import { transcodeQueue } from "./queue.js";

export const transcodeQueueEvents = new QueueEvents("transcode", {
  connection,
});

transcodeQueueEvents.on("progress", ({ data }) => {
  const payload = data as {
    videoId: string;
    renditionId: string;
    resolution: number;
    stage: string;
    percent?: number;
  };
  broadcastToVideo(payload.videoId, { type: "progress", ...payload });
});

transcodeQueueEvents.on("completed", ({ returnvalue }) => {
  const result = returnvalue as
    | { videoId: string; renditionId: string; resolution: number }
    | undefined;
    if(!result) return;
    broadcastToVideo(result.videoId,{
      type:"terminal",
      status:"completed",
      renditionId:result.renditionId,
      resolution:result.resolution,
    });
});

transcodeQueueEvents.on("failed", async ({ jobId, failedReason }) => {
  const job = await transcodeQueue.getJob(jobId);
  if (!job) return;
  broadcastToVideo(job.data.videoId, {
    type: "terminal",
    status: "failed",
    renditionId: job.data.renditionId,
    resolution: job.data.resolution,
    error: failedReason,
  });
})
