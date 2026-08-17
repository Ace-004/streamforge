// worker/src/test-enqueue.ts
import { Queue } from "bullmq";
import { connection } from "./lib/redis.js";

const queue = new Queue("transcode", { connection });

await queue.add("transcode", {
  videoId: "eba10dc5-8a81-4219-aa0e-f01641e2c82c",
  renditionId: "ad647528-e440-4c9f-a602-b251173ae053",
  resolution: 360,
  inputPath: "uploads/d821e48d-07ff-40ad-b392-835149bed350/29510a95-ea73-419a-9a53-5a6f7aa687c4",
});

console.log("job added");