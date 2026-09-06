import { beforeAll, afterEach, afterAll } from "vitest";
import { prisma } from "../lib/prisma.js";

beforeAll(async () => {
  // Assumes migrations have already been applied to the test DB
  // via: npx prisma migrate deploy (run manually before test suite, see below)
});

afterEach(async () => {
  // Delete in FK-safe order: children before parents
  await prisma.transcodingJob.deleteMany();
  await prisma.videoRendition.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.video.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});