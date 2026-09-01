import amqp from "amqplib";
import { prisma } from "./lib/prisma.js";

type VideoEvent = {
  type: "rendition_completed" | "rendition_failed";
  videoId: string;
  renditionId: string;
  resolution: number;
  error?: string;
  timestamp: string;
};

export async function startConsumer(){
  const RABBITMQ_URL= process.env.RABBITMQ_URL;
  if(!RABBITMQ_URL){
    throw new Error('RABBITMQ_URL is not set in .env');
  }

  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertQueue("video-events",{durable:true});
  
  console.log("Notification service listening for video events...");

  channel.consume("video-events",async (msg)=>{
    if(!msg)return;

    try {
      const event:VideoEvent = JSON.parse(msg.content.toString());
      await handleEvent(event);
      channel.ack(msg);
    } catch (error) {
      console.error("Failed to process event:",error);
      channel.nack(msg,false,false);
    }
  });
}

async function handleEvent(event: VideoEvent){
  const video = await prisma.video.findUnique({
    where:{id: event.videoId}
  });

  if(!video){
    console.warn(`Video ${event.videoId} not found, skipping notification`);
    return;
  }

  const type = event.type ==="rendition_completed" ? "rendition_ready" : "rendition_failed";

  await prisma.notification.create({
    data:{
      userId: video.userId,
      type,
      channel:"in_app",
      payload:{
        videoId: event.videoId,
        renditionId:event.renditionId,
        resolution: event.resolution,
        ...(event.error ? {error: event.error} : {}),
      },
    },
  });
  console.log(`Notification created for user ${video.userId}: ${type} ${event.resolution}p`);
}


