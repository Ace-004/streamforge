import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { getPresignedUrl } from "../controller/video.controller.js";

const router= Router();

router.post('/presign',requireAuth, getPresignedUrl);

export default router;