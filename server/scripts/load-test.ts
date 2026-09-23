// server/scripts/load-test.ts
//
// Usage:
//   npx tsx scripts/load-test.ts <baseUrl> <videoFilePath> <count>
//
// Example (local Compose):
//   npx tsx scripts/load-test.ts http://localhost:3000 ./sample.mp4 6
//
// Example (production — mind the 30 req/15min uploadLimiter, so keep count <= 15):
//   npx tsx scripts/load-test.ts https://streamforge.ayushrana.me ./sample.mp4 10
//
// What it does, honestly: fires `count` uploads back-to-back (not staggered —
// this is the actual "burst" scenario worth measuring), waits for every
// resulting rendition to reach a terminal state, then prints the batch
// window (first job created -> last job completed) so you know the exact
// time range to hand to metrics.ts.

import { readFileSync } from "fs";

const [, , baseUrlArg, videoPathArg, countArg] = process.argv;

if (!baseUrlArg || !videoPathArg || !countArg) {
  console.error(
    "Usage: npx tsx scripts/load-test.ts <baseUrl> <videoFilePath> <count>",
  );
  process.exit(1);
}

const baseUrl = baseUrlArg.replace(/\/$/, "");
const videoPath = videoPathArg;
const count = parseInt(countArg, 10);

const TEST_EMAIL = `loadtest+${Date.now()}@example.com`;
const TEST_PASSWORD = "loadtest-password-123";

let cookie = "";

// at the top of main()

function extractCookie(res: Response): string {
  // Node's fetch exposes multiple Set-Cookie headers via getSetCookie()
  const raw = (res.headers as any).getSetCookie?.() as string[] | undefined;
  if (raw && raw.length > 0) {
    return raw.map((c) => c.split(";")[0]).join("; ");
  }
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function registerAndLogin() {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`register failed: ${res.status} ${await res.text()}`);
  }
  cookie = extractCookie(res);
  console.log(`Registered load-test user: ${TEST_EMAIL}`);
}

async function uploadOne(index: number, fileBuffer: Uint8Array): Promise<string> {
  const presignRes = await fetch(`${baseUrl}/videos/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      title: `load-test-${index}`,
      contentType: "video/mp4",
    }),
  });
  if (!presignRes.ok) {
    throw new Error(
      `presign #${index} failed: ${presignRes.status} ${await presignRes.text()}`,
    );
  }
  const { uploadUrl, videoId } = await presignRes.json();

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: fileBuffer as BodyInit,
  });
  if (!putRes.ok) {
    throw new Error(`R2 PUT #${index} failed: ${putRes.status}`);
  }

  const completeRes = await fetch(`${baseUrl}/videos/${videoId}/complete`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  if (!completeRes.ok) {
    throw new Error(
      `complete #${index} failed: ${completeRes.status} ${await completeRes.text()}`,
    );
  }

  console.log(`  [${index}] uploaded, videoId=${videoId}`);
  return videoId;
}

async function pollUntilTerminal(
  videoIds: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(videoIds);

  while (pending.size > 0) {
    if (Date.now() > deadline) {
      console.warn(
        `Timed out waiting for ${pending.size} video(s) to finish: ${[...pending].join(", ")}`,
      );
      return;
    }
    for (const id of [...pending]) {
      const res = await fetch(`${baseUrl}/videos/${id}`, {
        headers: { Cookie: cookie },
      });
      if (!res.ok) continue;
      const { video } = await res.json();
      if (video.status === "READY" || video.status === "FAILED") {
        console.log(`  ${id} -> ${video.status}`);
        pending.delete(id);
      }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 4000));
  }
}

async function main() {
  const fileBuffer = readFileSync(videoPath);
  const batchStart = new Date();

  await registerAndLogin();

  console.log(`Firing ${count} uploads at ${baseUrl} ...`);
  const videoIds = await Promise.all(
    Array.from({ length: count }, (_, i) => uploadOne(i, fileBuffer)),
  );

  console.log(`All ${count} uploads accepted. Polling for completion...`);
  await pollUntilTerminal(videoIds, 15 * 60 * 1000); // 15 min ceiling

  const batchEnd = new Date();
  console.log("\n--- Batch window (feed these into metrics.ts) ---");
  console.log(`from: ${batchStart.toISOString()}`);
  console.log(`to:   ${batchEnd.toISOString()}`);
  console.log(`videoIds: ${JSON.stringify(videoIds)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});