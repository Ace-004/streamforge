import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { completeUpload, getPresignedUrl } from "../controller/video.controller.js";

const router = Router();

router.post("/presign", requireAuth, getPresignedUrl);

router.post('/:id/complete',requireAuth,completeUpload);

export default router;
