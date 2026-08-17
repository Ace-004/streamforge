import { connection } from "./lib/redis.js";
import "./worker.js";

console.log("Worker service started, listening for jobs...");


async function main() {
  const pong = await connection.ping();
  console.log('redis connected : ',pong);
}

main();