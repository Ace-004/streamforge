import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { listNotifications } from "../controller/notification.controller.js";

const router = Router();

router.get("/", requireAuth, listNotifications);

export default router;