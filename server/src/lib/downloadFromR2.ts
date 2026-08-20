import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { pipeline } from "stream/promises";
import path from "path";
import { r2 } from "./r2.js";

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
if (!R2_BUCKET_NAME) throw new Error("R2_BUCKET_NAME is not set in .env");

export async function downloadFromR2(key: string, localPath: string): Promise<void> {
  await mkdir(path.dirname(localPath), { recursive: true });
  const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key });
  const response = await r2.send(command);
  if (!response.Body) throw new Error(`No body returned for R2 object: ${key}`);
  await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(localPath));
}