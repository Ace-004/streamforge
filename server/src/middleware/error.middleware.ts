import type { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/error.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });

    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
}
