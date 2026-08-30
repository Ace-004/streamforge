import amqp from "amqplib";

let channel: amqp.Channel | null =null;

export async function getRabbitChannel(): Promise<amqp.Channel>{
  if(channel)return channel;

  const RABBITMQ_URL = process.env.RABBITMQ_URL;
  if(!RABBITMQ_URL){
    throw new Error('RABBITMQ_URL is not set in .env');
  }

  const connection = await amqp.connect(RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.assertQueue("video-events",{durable:true});

  return channel;
}

export async function publishVideoEvent(event : Record<string,unknown>): Promise<void>{
  const ch = await getRabbitChannel();
  ch.sendToQueue("video-events",Buffer.from(JSON.stringify(event)),{persistent:true});
}