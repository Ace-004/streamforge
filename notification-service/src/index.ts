import { startConsumer } from "./consumer.js";

startConsumer().catch((err)=>{
  console.error("Failed to start notification consumer : ", err);
  process.exit(1);
});