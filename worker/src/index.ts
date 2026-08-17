import { connection } from "./lib/redis.js";


async function main() {
  const pong = await connection.ping();
  console.log('redis connected : ',pong);
}

main();