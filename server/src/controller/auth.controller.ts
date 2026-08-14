import type { Request, Response, NextFunction } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { AppError, ConflictError } from "../utils/error.js";
import { prisma } from "../lib/prisma.js";
import bcrypt from "bcrypt";
import { signToken } from "../utils/jwt.js";

interface RegisterBody {
  email: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
}

const SALT_ROUNDS = 10;

export const register = asyncHandler(async (req, res) => {
  console.log('1: request received');
  const { email, password } = req.body as RegisterBody;
  console.log('2: body parsed', email);

  if (!email || !password) {
    throw new AppError(400, "email and password are required");
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  console.log('3: db query done');
  if (existingUser) {
    throw new ConflictError("User already exists");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({ data: { email, passwordHash } });
  const token = signToken({ userId: user.id, email: user.email });

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days , in ms
  });

  res.status(201).json({ token });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body as LoginBody;

  if (!email || !password) {
    throw new AppError(400, "email and password are required");
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(401, "Invalid credentials");
  }

  const passMatches = await bcrypt.compare(password, user.passwordHash);

  if(!passMatches){
    throw new AppError(401,'Invalid credentials')
  }

  const token = signToken({ userId: user.id, email: user.email });

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days , in ms
  });

  res.status(200).json({ token });
});

export const logout = asyncHandler(async (req, res) => {
  res.clearCookie("token");
  res.status(200).json({ message: "Logged Out" });
});
