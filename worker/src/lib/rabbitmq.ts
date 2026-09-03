import amqp from "amqplib";

let channel: amqp.Channel | null = null;
let connectingPromise: Promise<amqp.Channel> | null = null;

const MAX_RETRY_DELAY_MS = 30000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(): Promise<amqp.Channel> {
  const RABBITMQ_URL = process.env.RABBITMQ_URL;
  if (!RABBITMQ_URL) {
    throw new Error("RABBITMQ_URL is not set in .env");
  }

  let attempt = 0;
  while (true) {
    try {
      const connection = await amqp.connect(RABBITMQ_URL);
      const ch = await connection.createChannel();
      await ch.assertQueue("video-events", { durable: true });

      connection.on("error", (err) => {
        console.error("RabbitMQ connection error:", err.message);
      });
      connection.on("close", () => {
        console.warn("RabbitMQ connection closed, will reconnect on next publish");
        channel = null;
        connectingPromise = null;
      });

      console.log("Connected to RabbitMQ");
      return ch;
    } catch (err) {
      attempt++;
      const backoff = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
      console.error(
        `RabbitMQ connect attempt ${attempt} failed: ${(err as Error).message}. Retrying in ${backoff}ms`,
      );
      await delay(backoff);
    }
  }
}

export async function getRabbitChannel(): Promise<amqp.Channel> {
  if (channel) return channel;
  if (!connectingPromise) {
    connectingPromise = connectWithRetry().then((ch) => {
      channel = ch;
      return ch;
    });
  }
  return connectingPromise;
}

export async function publishVideoEvent(event: Record<string, unknown>): Promise<void> {
  const ch = await getRabbitChannel();
  ch.sendToQueue("video-events", Buffer.from(JSON.stringify(event)), { persistent: true });
}