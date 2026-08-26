import type { Request, Response, NextFunction } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { AppError, ConflictError } from "../utils/error.js";
import { prisma } from "../lib/prisma.js";
import bcrypt from "bcrypt";
import { signToken } from "../utils/jwt.js";
import z from "zod";

interface RegisterBody {
  email: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
}

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8,"Password must be at least 8 characters"),
});

const SALT_ROUNDS = 10;

function setAuthCookie(res: Response, token: string){
  res.cookie("token",token,{
    httpOnly:true,
    secure: process.env.NODE_ENV==="production",
    sameSite:"lax",
    maxAge:7*24*60*60*1000,// 7 days, in ms
  });
}

export const register = asyncHandler(async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if(!parsed.success){
    throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const {email, password}= parsed.data;

  if (!email || !password) {
    throw new AppError(400, "email and password are required");
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new ConflictError("User already exists");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({ data: { email, passwordHash } });
  const token = signToken({ userId: user.id, email: user.email });

  setAuthCookie(res,token);

  res.status(201).json({ user:{id:user.id, email: user.email} });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(401, "Invalid credentials");
  }

  const passMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passMatches) {
    throw new AppError(401, "Invalid credentials");
  }

  const token = signToken({ userId: user.id, email: user.email });

  setAuthCookie(res, token);
  res.status(200).json({ user: { id: user.id, email: user.email } });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  res.clearCookie("token");
  res.status(200).json({ message: "Logged Out" });
});