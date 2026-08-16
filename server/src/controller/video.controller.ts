import { randomUUID } from "crypto";
import { asyncHandler } from "../utils/asyncHandler.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import type { Response } from "express"; 
import { AppError } from "../utils/error.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from '../lib/r2.js';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../lib/prisma.js";

export const getPresignedUrl = asyncHandler(async(req:AuthenticatedRequest,res:Response)=>{
  const {title,contentType}= req.body;

  if(!title || !contentType){
    throw new AppError(400,'title and contentType are required');
  }

  const userId = req.user!.userId;
  const key = `uploads/${userId}/${randomUUID()}`;

  const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;  
  if(!R2_BUCKET_NAME){
    throw new Error('BUCKET_NAME is not defined in .env');
  }

  const command = new PutObjectCommand({
    Bucket:R2_BUCKET_NAME,
    Key: key,
    ContentType:contentType,
  });

  const uploadUrl = await getSignedUrl(r2,command,{expiresIn : 300});

  const video = await prisma.video.create({
    data:{
      title,
      originalUrl:key,
      userId,
      status:'PENDING'
    }
  });

  res.status(201).json({uploadUrl,videoId: video.id});
})