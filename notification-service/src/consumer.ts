import amqp from "amqplib";
import { prisma } from "./lib/prisma.js";
import { sendVideoSummaryEmail } from "./email/sendVideoEmail.js";

type VideoEvent = {
  type: "rendition_completed" | "rendition_failed";
  videoId: string;
  renditionId: string;
  resolution: number;
  error?: string;
  timestamp: string;
};

export async function startConsumer() {
  const RABBITMQ_URL = process.env.RABBITMQ_URL;
  if (!RABBITMQ_URL) {
    throw new Error("RABBITMQ_URL is not set in .env");
  }

  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertQueue("video-events", { durable: true });

  console.log("Notification service listening for video events...");

  channel.consume("video-events", async (msg) => {
    if (!msg) return;

    try {
      const event: VideoEvent = JSON.parse(msg.content.toString());
      await handleEvent(event);
      channel.ack(msg);
    } catch (error) {
      console.error("Failed to process event:", error);
      channel.nack(msg, false, false);
    }
  });
}

async function handleEvent(event: VideoEvent) {
  const video = await prisma.video.findUnique({
    where: { id: event.videoId },
    include: { user: { select: { email: true } } },
  });

  if (!video) {
    console.warn(`Video ${event.videoId} not found, skipping notification`);
    return;
  }

  const type =
    event.type === "rendition_completed"
      ? "rendition_ready"
      : "rendition_failed";

  await prisma.notification.create({
    data: {
      userId: video.userId,
      type,
      channel: "in_app",
      payload: {
        videoId: event.videoId,
        renditionId: event.renditionId,
        resolution: event.resolution,
        ...(event.error ? { error: event.error } : {}),
      },
    },
  });
  console.log(
    `Notification created for user ${video.userId}: ${type} ${event.resolution}p`,
  );

  await maybeSendSummaryEmail(event.videoId, video.userId, video.user.email);
}

async function maybeSendSummaryEmail(
  videoId: string,
  userId: string,
  userEmail: string,
) {
  const renditions = await prisma.videoRendition.findMany({
    where: { videoId },
    select: { resolution: true, status: true },
  });

  const allTerminal = renditions.every(
    (r) => r.status === "READY" || r.status === "FAILED",
  );
  if (!allTerminal) return;

  // dedupe guard : has a summary email already been sent  for this video?
  const alreadySent = await prisma.notification.findFirst({
    where: {
      type: "video_summary",
      payload: { path: ["videoId"], equals: videoId },
    },
  });
  if (alreadySent) return;

  const ready = renditions
    .filter((r) => r.status === "READY")
    .map((r) => r.resolution);
  const failed = renditions
    .filter((r) => r.status === "FAILED")
    .map((r) => r.resolution);

  const notification = await prisma.notification.create({
    data: {
      userId,
      type: "video_summary",
      channel: "in_app",
      payload: { videoId, ready, failed },
    },
  });

  try {
    await sendVideoSummaryEmail({ to: userEmail, videoId, ready, failed });
    await prisma.notification.update({
      where: {
        id: notification.userId,
      },
      data: { status: "SENT" },
    });
    console.log(`summary email sent to ${userEmail} for video${videoId}`);
  } catch (error) {
    await prisma.notification.update({
      where: {
        id: notification.userId,
      },
      data: { status: "FAILED" },
    });
    console.error("Failed to send summary email (non-fatal):", error);
  }
}
