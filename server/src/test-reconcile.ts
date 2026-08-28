import { reconcileQueue } from "./lib/reconcileQueue.js";

await reconcileQueue.add("reconcile", {});
console.log("Reconcile job manually triggered");
