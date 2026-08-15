import 'dotenv/config';
// import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaClient } from '@prisma/client/extension';
import { PrismaPg } from '@prisma/adapter-pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set in .env');
}

const adapter = new PrismaPg({ connectionString: databaseUrl });
export const prisma = new PrismaClient({ adapter });