import { Queue } from "bullmq";
import { connection } from "./redis.js";

export const transcodeQueue = new Queue("transcode", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});
