-- AlterTable
ALTER TABLE "transcoding_jobs" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
