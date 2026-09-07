import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from 'cors';
import { errorHandler } from "./middleware/error.middleware.js";
import cookieParser from "cookie-parser";
import helmet from "helmet";

import authRoutes from "./routes/auth.routes.js";
import videoRoutes from "./routes/video.routes.js";
import notificationRoutes from "./routes/notification.routes.js";

export const app = express();
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/videos', videoRoutes);
app.use('/notifications', notificationRoutes);

app.use("/health", async (req, res) => {
  res.json({ status: "ok" });
});

app.use(errorHandler);