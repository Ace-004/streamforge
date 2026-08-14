import { AppError } from "../utils/error.js";
import { verifyToken, type jwtPayload } from "../utils/jwt.js";
import type { Request, Response, NextFunction } from "express";


export interface AuthenticatedRequest extends Request {
  user?:jwtPayload
};

export function requireAuth(req:AuthenticatedRequest,res:Response,next:NextFunction) : void{
  const token = req.cookies?.token;

  if(!token){
    throw new AppError(400,'Not Authenticated');
  }
  try {
    req.user=verifyToken(token);
    next();

  } catch {
    throw new AppError(401,'Invalid or expired token');
  }
}