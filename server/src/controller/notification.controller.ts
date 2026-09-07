import { asyncHandler } from "../utils/asyncHandler.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import type { Response } from "express";
import { prisma } from "../lib/prisma.js";

export const listNotifications = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.userId;

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.status(200).json({ notifications });
  },
);