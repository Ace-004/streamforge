import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import { prisma } from "../lib/prisma.js";

async function registerAndGetCookie(email: string) {
  const res = await request(app)
    .post("/auth/register")
    .send({ email, password: "password123" });

  const cookie = res.headers["set-cookie"]?.[0];
  if (!cookie) {
    throw new Error(`Register did not return a Set-Cookie header (status ${res.status}, body: ${JSON.stringify(res.body)})`);
  }

  const userId = res.body.user.id as string;
  return { cookie, userId };
}

async function seedFailedRendition(userId: string) {
  const video = await prisma.video.create({
    data: {
      userId,
      title: "test video",
      status: "PROCESSING",
      originalUrl: `uploads/${userId}/fake-key`,
      duration: 15,
    },
  });

  const rendition = await prisma.videoRendition.create({
    data: {
      videoId: video.id,
      resolution: "360",
      status: "FAILED",
    },
  });

  await prisma.transcodingJob.create({
    data: {
      renditionId: rendition.id,
      status: "FAILED",
      error: "ffmpeg exited with code 1",
    },
  });

  return { video, rendition };
}

describe("POST /videos/renditions/:id/retry", () => {
  it("requeues a FAILED rendition owned by the requester", async () => {
    const { cookie, userId } = await registerAndGetCookie("retryowner@test.com");
    const { rendition } = await seedFailedRendition(userId);

    const res = await request(app)
      .post(`/videos/renditions/${rendition.id}/retry`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.renditionId).toBe(rendition.id);

    const updated = await prisma.videoRendition.findUnique({ where: { id: rendition.id } });
    expect(updated?.status).toBe("QUEUED");

    const job = await prisma.transcodingJob.findUnique({ where: { renditionId: rendition.id } });
    expect(job?.status).toBe("QUEUED");
    expect(job?.error).toBeNull();
  });

  it("rejects retrying a rendition owned by a different user", async () => {
    const { userId: ownerId } = await registerAndGetCookie("realowner@test.com");
    const { cookie: attackerCookie } = await registerAndGetCookie("attacker@test.com");
    const { rendition } = await seedFailedRendition(ownerId);

    const res = await request(app)
      .post(`/videos/renditions/${rendition.id}/retry`)
      .set("Cookie", attackerCookie);

    expect(res.status).toBe(403);

    const unchanged = await prisma.videoRendition.findUnique({ where: { id: rendition.id } });
    expect(unchanged?.status).toBe("FAILED"); // confirms the attacker's request had no side effect
  });

  it("rejects retrying a rendition that isn't FAILED", async () => {
    const { cookie, userId } = await registerAndGetCookie("wrongstatus@test.com");
    const { rendition } = await seedFailedRendition(userId);

    await prisma.videoRendition.update({
      where: { id: rendition.id },
      data: { status: "READY" },
    });

    const res = await request(app)
      .post(`/videos/renditions/${rendition.id}/retry`)
      .set("Cookie", cookie);

    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent rendition id", async () => {
    const { cookie } = await registerAndGetCookie("nonexistent@test.com");

    const res = await request(app)
      .post(`/videos/renditions/00000000-0000-0000-0000-000000000000/retry`)
      .set("Cookie", cookie);

    expect(res.status).toBe(404);
  });
});