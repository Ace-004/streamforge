import { S3Client } from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID= process.env.R2_ACCOUONT_ID;
if(!R2_ACCOUNT_ID){
  throw new Error('R2_ACCOUONT_ID is not mentioned in .env')
}

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
if(!R2_ACCESS_KEY_ID){
  throw new Error('R2_ACCESS_KEY_ID is not defined in .env');
}

const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;

export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:R2_ACCESS_KEY_ID,
    secretAccessKey:R2_SECRET_ACCESS_KEY,
  },
});
