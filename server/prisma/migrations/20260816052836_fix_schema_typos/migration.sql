/*
  Warnings:

  - The values [PROCSSING] on the enum `JobStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `completed_a` on the `transcoding_jobs` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "JobStatus_new" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');
ALTER TABLE "public"."transcoding_jobs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "transcoding_jobs" ALTER COLUMN "status" TYPE "JobStatus_new" USING ("status"::text::"JobStatus_new");
ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";
ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";
DROP TYPE "public"."JobStatus_old";
ALTER TABLE "transcoding_jobs" ALTER COLUMN "status" SET DEFAULT 'QUEUED';
COMMIT;

-- AlterTable
ALTER TABLE "transcoding_jobs" DROP COLUMN "completed_a",
ADD COLUMN     "completed_at" TIMESTAMP(3);
