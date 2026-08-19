import { writeFile,mkdir } from "fs/promises";
import { prisma } from "./prisma.js";
import { r2 } from "./r2.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";


const R2_BUCKET_NAME= process.env.R2_BUCKET_NAME;

if(!R2_BUCKET_NAME){
  throw new Error('R2_BUCKET_NAME is not set in .env');
}

const BANDWIDTH_MAP : Record<string,number> = {
  "360":800000,
  "480": 1400000,
  "720": 2800000,
};

const RESOLUTION_LABEL : Record<string,string> = {
  "360": "640x360",
  "480": "854x480",
  "720": "1280x720",
};

export async function regenerateMasterPlaylist(videoId: string): Promise<void>{
  const readyRenditions = await prisma.videoRendition.findMany({
    where: {videoId, status:"READY"},
  });

  if(readyRenditions.length===0) return;

  const lines = ["#EXTM3U"];
  for(const r of readyRenditions){
    const bandwidth = BANDWIDTH_MAP[r.resolution] ?? 1000000;
    const label = RESOLUTION_LABEL[r.resolution] ?? `${r.resolution}p`;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${label}`);
    lines.push(`${r.resolution}p/playlist.m3u8`);
  }

  const localDir = `./tmp/${videoId}`;
  const localPath = `${localDir}/master.m3u8`;
  await mkdir(localDir, { recursive: true});
  await writeFile(localPath, lines.join("\n"));

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: `processed/${videoId}/master.m3u8`,
      Body: lines.join("\n"),
      ContentType: "application/vnd.apple.mpegurl",
    }),
  );
}
