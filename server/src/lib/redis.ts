import 'dotenv/config';
import { Redis} from "ioredis";

const redisUrl = process.env.REDIS_URL;
if(!redisUrl){
  throw new Error("REDIS_URL is not set in .env");
}

export const connection = new Redis(redisUrl,{
  maxRetriesPerRequest: null,
});

