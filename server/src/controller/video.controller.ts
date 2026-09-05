import { randomUUID } from "crypto";
import { asyncHandler } from "../utils/asyncHandler.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import type { Response } from "express";
import { AppError } from "../utils/error.js";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "../lib/r2.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../lib/prisma.js";
import { downloadFromR2 } from "../lib/downloadFromR2.js";
import { getVideoInfo } from "../lib/ffprobe.js";
import { transcodeQueue } from "../lib/queue.js";
import { rm } from "fs/promises";

export const getPresignedUrl = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { title, contentType } = req.body;

    if (!title || !contentType) {
      throw new AppError(400, "title and contentType are required");
    }

    const userId = req.user!.userId;
    const key = `uploads/${userId}/${randomUUID()}`;

    const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
    if (!R2_BUCKET_NAME) {
      throw new Error("BUCKET_NAME is not defined in .env");
    }

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 300 });

    const video = await prisma.video.create({
      data: {
        title,
        originalUrl: key,
        userId,
        status: "PENDING",
      },
    });

    res.status(201).json({ uploadUrl, videoId: video.id });
  },
);

const ALL_RESOLUTIONS = [360, 480, 720, 1080];

export const completeUpload = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.userId;

    if (!id || typeof id !== "string") {
      throw new AppError(400, "Invalid video id");
    }

    const video = await prisma.video.findUnique({ where: { id } });

    if (!video) {
      throw new AppError(404, "video not found");
    }

    if (video.userId !== userId) {
      throw new AppError(403, "not authorized to modify this video");
    }

    if (video.status !== "PENDING") {
      throw new AppError(400, `video is already ${video.status}`);
    }

    const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
    if (!R2_BUCKET_NAME) {
      throw new Error("R2_BUCKET_NAME is not defined in .env");
    }

    try {
      await r2.send(
        new HeadObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: video.originalUrl,
        }),
      );
    } catch {
      throw new AppError(
        400,
        "File not found in storage — upload may have failed",
      );
    }

    // download locally just to probe resolution

    const localpath = `./tmp/${video.id}/probe-input.mp4`;
    let sourceHeight: number;
    let duration: number;
    try {
      await downloadFromR2(video.originalUrl, localpath);
      ({ height: sourceHeight, duration } = await getVideoInfo(localpath));
    } finally {
      await rm(`./tmp/${video.id}`, { recursive: true, force: true });
    }

    const applicableResolutions = ALL_RESOLUTIONS.filter(
      (r) => r <= sourceHeight,
    );
    if (applicableResolutions.length === 0) {
      applicableResolutions.push(ALL_RESOLUTIONS[0] as number);
    }

    // all or nothing  DB writed : rendition + job creation for every resolution.

    const created = await prisma.$transaction(async (tx) => {
      const rows = [];

      for (const resolution of applicableResolutions) {
        const rendition = await tx.videoRendition.create({
          data: { videoId: video.id, resolution: String(resolution) },
        });

        await tx.transcodingJob.create({
          data: { renditionId: rendition.id },
        });
        rows.push({ renditionId: rendition.id, resolution });
      }
      return rows;
    });

    // only enqueue once every rendition/ job row is confirmed commited/

    for (const { renditionId, resolution } of created) {
      await transcodeQueue.add("transcode", {
        videoId: video.id,
        renditionId,
        resolution,
        inputPath: video.originalUrl,
      });
    }

    const updated = await prisma.video.update({
      where: { id },
      data: { status: "PROCESSING", duration },
    });

    res
      .status(200)
      .json({ video: updated, renditionQueued: applicableResolutions });
  },
);

export const listVideos = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;

    const videos = await prisma.video.findMany({
      where: { userId },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.status(200).json({ videos });
  },
);

export const getVideoUrl = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    const userId = req.user!.userId;

    if (!id || typeof id !== "string") {
      throw new AppError(400, "invalid video id");
    }

    const video = await prisma.video.findUnique({
      where: { id },
      include: { renditions: true },
    });

    if (!video) {
      throw new AppError(404, "video not found");
    }

    if (video.userId !== userId) {
      throw new AppError(403, "not authorised to view this video");
    }

    const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
    if (!R2_PUBLIC_URL) {
      throw new Error("R2_PUBLIC_URL is not set in .env");
    }

    const playbackUrl =
      video.status === "READY"
        ? `${R2_PUBLIC_URL}/processed/${video.id}/master.m3u8`
        : null;

    res.status(200).json({ video, playbackUrl });
  },
);

export const retryRenditon = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.userId;

    if (!id || typeof id !== "string") {
      throw new AppError(400, "Invalid rendition id");
    }

    const rendition = await prisma.videoRendition.findUnique({
      where: { id },
      include: { video: true },
    });

    if (!rendition) {
      throw new AppError(404, "rendition not found");
    }

    if (rendition.video.userId !== userId) {
      throw new AppError(403, "not authorized to retry this rendition");
    }

    if (rendition.status !== "FAILED") {
      throw new AppError(
        400,
        `Only FAILED renditions can be retried (current status : ${rendition.status})`,
      );
    }

    await prisma.videoRendition.update({
      where: { id },
      data: { status: "QUEUED" },
    });

    await prisma.transcodingJob.update({
      where: { renditionId: id },
      data: { status: "QUEUED", error: null, completedAt: null },
    });

    await transcodeQueue.add("transcode", {
      videoId: rendition.videoId,
      renditionId: rendition.id,
      resolution: Number(rendition.resolution),
      inputPath: rendition.video.originalUrl,
    });

    res
      .status(200)
      .json({ message: "Retry Queued", renditionId: rendition.id });
  },
);
