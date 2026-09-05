import { uploadLimiter } from '../middleware/ratelimit.middleware.js';
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { completeUpload, getPresignedUrl, getVideoUrl, listVideos, retryRenditon } from "../controller/video.controller.js";

const router = Router();

router.post("/presign", requireAuth,uploadLimiter , getPresignedUrl);

router.post('/:id/complete',requireAuth,uploadLimiter ,completeUpload);
router.get('/',requireAuth,listVideos);
router.get('/:id',requireAuth,getVideoUrl);
router.post("/renditions/:id/retry",requireAuth, retryRenditon);

export default router;
