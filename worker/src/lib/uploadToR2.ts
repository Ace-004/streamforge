import { PutObjectCommand } from "@aws-sdk/client-s3";
import { readFile, readdir } from "fs/promises";
import path from "path";
import { r2 } from "./r2.js";


const R2_BUCKET_NAME= process.env.R2_BUCKET_NAME;
if(!R2_BUCKET_NAME){
  throw new Error('R2_BUCKET_NAME is not set in .env');
}

function contentTypeFor(filename: string) : string{
  if( filename.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if(filename.endsWith(".ts")) return "video/mp2t"
  return "application/octet-stream";
}

export async function uploadFolderToR2(localDir: string, r2Prefix: string): Promise<void>{
  const files = await readdir(localDir);

  for(const filename of files){
    const localPath = path.join(localDir,filename);
    const body = await readFile(localPath);

    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: `${r2Prefix}/${filename}`,
        Body: body,
        ContentType: contentTypeFor(filename),
      }),
    );
  }
}