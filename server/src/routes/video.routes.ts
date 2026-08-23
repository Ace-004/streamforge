import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { completeUpload, getPresignedUrl, getVideoUrl, listVideos } from "../controller/video.controller.js";

const router = Router();

router.post("/presign", requireAuth, getPresignedUrl);

router.post('/:id/complete',requireAuth,completeUpload);
router.post('/',requireAuth,listVideos);
router.post('/:id',requireAuth,getVideoUrl);

export default router;
