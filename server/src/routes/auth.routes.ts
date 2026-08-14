import {Router} from 'express';
import { login, logout, register } from './../controller/auth.controller.js';
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.middleware.js";
import type { Response } from "express";

const router= Router();

router.post('/register', register);
router.post('/login',login);
router.post('/logout',logout);
router.get("/me", requireAuth, (req: AuthenticatedRequest, res : Response) => {
  res.json({ user: req.user });
});

export default router;