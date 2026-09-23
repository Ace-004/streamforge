// server/scripts/metrics.ts
//
// Usage:
//   npx tsx scripts/metrics.ts <fromISO> <toISO>
//
// Example (paste the window load-test.ts printed):
//   npx tsx scripts/metrics.ts 2026-09-13T10:00:00.000Z 2026-09-13T10:14:00.000Z
//
// Every number here is derived from TranscodingJob.createdAt/startedAt/completedAt
// — the same columns the worker already writes in production. Nothing here
// is simulated; if a job never reached a terminal state in the window, it's
// excluded from the relevant stat and you'll see it in the "still open" count.

import { prisma } from "../src/lib/prisma.js";

const [, , fromArg, toArg] = process.argv;
if (!fromArg || !toArg) {
  console.error("Usage: npx tsx scripts/metrics.ts <fromISO> <toISO>");
  process.exit(1);
}
const from = new Date(fromArg);
const to = new Date(toArg);

async function main() {
  // 1. Processing time (completedAt - startedAt), per resolution.
  //    This is real FFmpeg wall-clock time, already captured with zero code changes.
  const processingByResolution: {
    resolution: string;
    n: bigint;
    p50_ms: number;
    p95_ms: number;
    avg_ms: number;
  }[] = await prisma.$queryRaw`
    SELECT
      vr.resolution,
      COUNT(*)::bigint AS n,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (tj.completed_at - tj.started_at)) * 1000
      ) AS p50_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (tj.completed_at - tj.started_at)) * 1000
      ) AS p95_ms,
      AVG(EXTRACT(EPOCH FROM (tj.completed_at - tj.started_at)) * 1000) AS avg_ms
    FROM transcoding_jobs tj
    JOIN video_renditions vr ON vr.id = tj.rendition_id
    WHERE tj.created_at BETWEEN ${from} AND ${to}
      AND tj.status = 'COMPLETED'
      AND tj.started_at IS NOT NULL
      AND tj.completed_at IS NOT NULL
    GROUP BY vr.resolution
    ORDER BY vr.resolution::int;
  `;

  // 2. Queue wait time (startedAt - createdAt).
  //    Note: createdAt is written at DB-transaction-commit time, which happens
  //    a few ms before the BullMQ .add() call in the same request — so this
  //    number is a conservative (very slightly inflated) upper bound on true
  //    queue wait, not an undercount. Worth stating as-is in interviews.
  const queueWait: { n: bigint; p50_ms: number; p95_ms: number; avg_ms: number }[] =
    await prisma.$queryRaw`
    SELECT
      COUNT(*)::bigint AS n,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (tj.started_at - tj.created_at)) * 1000
      ) AS p50_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (tj.started_at - tj.created_at)) * 1000
      ) AS p95_ms,
      AVG(EXTRACT(EPOCH FROM (tj.started_at - tj.created_at)) * 1000) AS avg_ms
    FROM transcoding_jobs tj
    WHERE tj.created_at BETWEEN ${from} AND ${to}
      AND tj.started_at IS NOT NULL;
  `;

  // 3. Max concurrent PROCESSING jobs actually observed, derived purely from
  //    timestamps (no live polling needed): treat each startedAt as a +1
  //    event and each completedAt as a -1 event, sort chronologically, and
  //    take the running max of the cumulative sum. This is exact, not sampled.
  const concurrency: { max_concurrent: bigint }[] = await prisma.$queryRaw`
    WITH events AS (
      SELECT started_at AS ts, 1 AS delta
      FROM transcoding_jobs
      WHERE created_at BETWEEN ${from} AND ${to} AND started_at IS NOT NULL
      UNION ALL
      SELECT completed_at AS ts, -1 AS delta
      FROM transcoding_jobs
      WHERE created_at BETWEEN ${from} AND ${to} AND completed_at IS NOT NULL
    ),
    running AS (
      SELECT ts, SUM(delta) OVER (ORDER BY ts, delta DESC) AS running_count
      FROM events
    )
    SELECT COALESCE(MAX(running_count), 0)::bigint AS max_concurrent FROM running;
  `;

  // 4. Batch wall-clock: first job created -> last job completed, and
  //    whether anything in the window is still non-terminal.
  const wallClock: {
    earliest_created: Date | null;
    latest_completed: Date | null;
    still_open: bigint;
  }[] = await prisma.$queryRaw`
    SELECT
      MIN(created_at) AS earliest_created,
      MAX(completed_at) AS latest_completed,
      COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED', 'FAILED'))::bigint AS still_open
    FROM transcoding_jobs
    WHERE created_at BETWEEN ${from} AND ${to};
  `;

  console.log("\n=== Processing time by resolution (completedAt - startedAt) ===");
  console.table(
    processingByResolution.map((r) => ({
      resolution: r.resolution,
      n: Number(r.n),
      p50_ms: Math.round(r.p50_ms),
      p95_ms: Math.round(r.p95_ms),
      avg_ms: Math.round(r.avg_ms),
    })),
  );

  console.log("\n=== Queue wait time (startedAt - createdAt) ===");
  console.table(
    queueWait.map((r) => ({
      n: Number(r.n),
      p50_ms: Math.round(r.p50_ms ?? 0),
      p95_ms: Math.round(r.p95_ms ?? 0),
      avg_ms: Math.round(r.avg_ms ?? 0),
    })),
  );

  console.log("\n=== Max concurrent transcode jobs observed ===");
  console.log(Number(concurrency[0]?.max_concurrent ?? 0));

  console.log("\n=== Batch wall-clock ===");
  const w = wallClock[0];
  if (w?.earliest_created && w?.latest_completed) {
    const totalMs =
      new Date(w.latest_completed).getTime() -
      new Date(w.earliest_created).getTime();
    console.log(`earliest job created: ${w.earliest_created}`);
    console.log(`latest job completed: ${w.latest_completed}`);
    console.log(`total batch wall-clock: ${totalMs} ms`);
  }
  console.log(`still open (not terminal): ${Number(w?.still_open ?? 0)}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});