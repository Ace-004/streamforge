import 'dotenv/config';
import jwt  from "jsonwebtoken";

const secretKey= process.env.JWT_SECRET_KEY as string;

if(!secretKey){
  throw new Error('JWT SECRET is not set in .env')
}

export interface jwtPayload {
  userId: string,
  email:string
}

export function signToken(payload : jwtPayload) : string {
  return jwt.sign(payload,secretKey,{expiresIn:'7d'})
}
export function verifyToken(token : string ): jwtPayload{
  return jwt.verify(token,secretKey)as jwtPayload;
}
