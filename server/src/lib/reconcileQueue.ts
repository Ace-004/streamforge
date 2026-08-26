import { Queue } from "bullmq";
import { connection } from "./redis.js";

export const reconcileQueue = new Queue("reconcile-pending-videos", { connection });
