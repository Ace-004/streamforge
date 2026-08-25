import { Worker } from "bullmq";
import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import { connection } from "./lib/redis.js";
import { prisma } from "./lib/prisma.js";
import { downloadFromR2 } from "./lib/downloadFromR2.js";
import { uploadFolderToR2 } from "./lib/uploadToR2.js";
import { regenerateMasterPlaylist } from "./lib/masterPlaylist.js";
import { finalizeVideoStatusIfDone } from "./lib/finalizeVideoStatus.js";
import { rm } from "fs/promises";

type TranscodeJobData = {
  videoId: string;
  renditionId: string;
  resolution: number;
  inputPath: string;
};

const worker = new Worker<TranscodeJobData>(
  "transcode",
  async (job) => {
    const { videoId, renditionId, resolution, inputPath } = job.data;
    const jobTmpDir = `./tmp/${renditionId}`;
    const localInputPath = `${jobTmpDir}/input.mp4`;
    const renditionDir = `${jobTmpDir}/${resolution}p`;
    const playlistPath = `${renditionDir}/playlist.m3u8`;

    try {
      await prisma.videoRendition.update({
        where: { id: renditionId },
        data: { status: "PROCESSING" },
      });

      await prisma.transcodingJob.update({
        where: { renditionId },
        data: { status: "PROCESSING", startedAt: new Date() },
      });

      await downloadFromR2(inputPath, localInputPath);
      await mkdir(renditionDir, { recursive: true });

      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
          "-i",
          localInputPath,
          "-vf",
          `scale=-2:${resolution}`,
          "-c:v",
          "libx264",
          "-c:a",
          "aac",
          "-f",
          "hls",
          "-hls_time",
          "10",
          "-hls_playlist_type",
          "vod",
          "-hls_segment_filename",
          `${renditionDir}/segment_%03d.ts`,
          playlistPath,
        ]);

        ffmpeg.stderr.on("data", (data) => {
          console.log(`[job ${job.id}] ${data}`);
        });

        ffmpeg.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });
      });

      const r2Prefix = `processed/${videoId}/${resolution}p`;
      await uploadFolderToR2(renditionDir, r2Prefix);

      await prisma.videoRendition.update({
        where: { id: renditionId },
        data: { status: "READY", hlsPath: `${r2Prefix}/playlist.m3u8` },
      });

      await prisma.transcodingJob.update({
        where: { renditionId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });

      await regenerateMasterPlaylist(videoId);
      await finalizeVideoStatusIfDone(videoId);
    } finally {
      await rm(jobTmpDir, { recursive: true, force: true });
    }
  },
  { connection },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", async (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);

  if (!job) return;

  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!isFinalAttempt) return;

  await prisma.videoRendition.update({
    where: { id: job.data.renditionId },
    data: { status: "FAILED" },
  });

  await prisma.transcodingJob.update({
    where: { renditionId: job.data.renditionId },
    data: {
      status: "FAILED",
      error: err.message,
      attempts: job.attemptsMade,
      completedAt: new Date(),
    },
  });

  await finalizeVideoStatusIfDone(job.data.videoId);
});
