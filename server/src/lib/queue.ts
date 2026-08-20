import { Queue } from "bullmq";
import { connection } from "./redis.js";

export const transcodeQueue = new Queue("transcode",{connection});