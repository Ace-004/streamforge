import { Queue } from "bullmq";
import { connection } from "./redis.js";

export const transcodeQueue = new Queue("transcode", {
  connection,
  streams: { events: { maxLen: 1000 } },   // default is ~10,000
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: true,   // delete the job as soon as it succeeds
    removeOnFail: true,       // delete after the final failed attempt
  },
});
