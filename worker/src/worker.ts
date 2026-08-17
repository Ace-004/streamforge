import { Worker } from "bullmq";
import { spawn } from "child_process";
import { connection } from "./lib/redis.js";
import {prisma} from './lib/prisma.js';
import { downloadFromR2 } from "./lib/downloadFromR2.js";

type TranscodeJobData = {
  videoId: string,
  renditionId: string,
  resolution: number, // e.g 360,480, 720
  inputPath: string, // R2 key or local path, depending on how you fetdh it
};

const worker = new Worker<TranscodeJobData>("transcode",async(job)=>{
  const {videoId,renditionId,resolution, inputPath}= job.data;
  const jobTmpdDir = `./tmp/${renditionId}`;
  const localInputPath = `${jobTmpdDir}/input.mp4`
  const outputPath = `${jobTmpdDir}/output-${renditionId}-${resolution}.mp4`;

  await downloadFromR2(inputPath,localInputPath);

  await prisma.videoRendition.update({
    where:{
      id:renditionId,
    },
    data: {
      status: "PROCESSING",
    }
  });

  await new Promise<void>((resolve,reject)=>{
    const ffmpeg = spawn("ffmpeg",[
      "-i", localInputPath,
        "-vf", `scale=-2:${resolution}`,
        "-c:v", "libx264",
        "-c:a", "aac",
        outputPath,
    ]);

    ffmpeg.stderr.on("data",(data)=>{
      console.log(`[job ${job.id}] ${data}`);
    });

    ffmpeg.on("close",(code)=>{
      if(code===0)resolve();
      else reject(new Error(`FFmppeg exited with code ${code}`));
    });

  });

  await prisma.videoRendition.update({
    where:{
      id: renditionId
    },
    data: {status:"READY"}
  });

  return { outputPath};

},
{connection});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});