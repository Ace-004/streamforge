import { prisma } from "./prisma.js";

export async function finalizeVideoStatusIfDone(videoId: string): Promise<void> {
  const allRenditions = await prisma.videoRendition.findMany({ where: { videoId } });

  const anyReady = allRenditions.some((r) => r.status === "READY");
  const allDone = allRenditions.every((r) => r.status === "READY" || r.status === "FAILED");

  if (allDone) {
    await prisma.video.update({
      where: { id: videoId },
      data: { status: anyReady ? "READY" : "FAILED" },
    });
  }
}