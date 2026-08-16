import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from 'cors';
import { errorHandler } from "./middleware/error.middleware.js";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.routes.js";
import videoRoutes from "./routes/video.routes.js";

console.log('authRoutes:', authRoutes);
const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL, // e.g. "http://localhost:5173"
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/videos',videoRoutes);


app.use("/health", async (req, res) => {
  res.json({ status: "ok" });
});

app.use(errorHandler);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`server is running on port ${PORT}`);
});
