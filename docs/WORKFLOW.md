# StreamForge — Full End-to-End Workflow

A single narrative walkthrough of exactly what happens, in order, from a user registering to receiving a "your video is ready" email and watching it play. Use this to narrate the system out loud without losing your place.

---

## 1. Auth

1. User submits register/login form → `server` validates the body with `zod` → password hashed with `bcrypt` (register) or compared with `bcrypt.compare` (login) → on success, a JWT is issued and set as an **httpOnly, `SameSite`-configured cookie** (not returned in the response body — the browser never lets JS touch it).
2. Every subsequent request automatically carries this cookie. `server` verifies the JWT signature on protected routes — no DB lookup needed to confirm identity on every request, only the signature check.
3. Auth routes are rate-limited to blunt brute-force attempts.

## 2. Upload — Getting Bytes Into Storage

1. Frontend calls `POST /videos/presign` with basic file metadata (filename, content type).
2. `server` validates the content type, then asks R2 for a **presigned PUT URL** — a short-lived, HMAC-signed URL that authorizes exactly one PUT to exactly one object key, without `server`'s R2 secret ever leaving the server.
3. Frontend uploads the raw video file **directly to R2** using that presigned URL — `server` never sees these bytes at all.
4. Frontend calls `POST /videos/:id/complete`. `server`:
   - Runs `HeadObjectCommand` against R2 to actually confirm the object exists (doesn't just trust the client's word that the upload succeeded).
   - Runs `ffprobe` against the file to extract duration, resolution, codec info.
   - Decides which target renditions apply (e.g. no upscaling past the source's own resolution).
   - In a single Prisma **transaction**: creates one `VideoRendition` row + one `TranscodingJob` row per applicable resolution.
   - **After the transaction commits**, enqueues one BullMQ job per rendition onto the `transcode` queue.

*(A separate reconciliation sweep runs every 15 minutes in the background, checking any video still stuck `PENDING` against R2 directly — catching the case where a client uploads but never calls `/complete` at all.)*

## 3. Transcoding — Turning the Source Into Playable HLS

For each enqueued job, independently, possibly across multiple `worker` processes in parallel:

1. `worker` claims the job from BullMQ (Redis-backed lock — no two workers can claim the same job).
2. Downloads the source file from R2 into a local `tmp/` directory.
3. Spawns FFmpeg as a child process for **this one target resolution**, producing an HLS output: a `.m3u8` playlist plus a sequence of `.ts` segment files.
4. While FFmpeg runs, `worker` parses its `stderr` for `time=` progress markers, computes `percent = Math.round((elapsed / totalDuration) * 100)`, and calls `job.updateProgress()` — which writes to Redis and fires a pub/sub event.
5. On successful completion, uploads all rendition output files to R2.
6. **Only after the upload succeeds**, updates the `VideoRendition`/`TranscodingJob` rows to `READY` (never marks ready before the files actually exist in storage).
7. Regenerates `master.m3u8` for the video, referencing every currently-`READY` rendition (so playback can start via ABR as soon as *any* rendition is done, not only once all are done).
8. Calls `finalizeVideoStatusIfDone()` — checks whether every rendition for this video has now reached a terminal state (`READY` or `FAILED`); if so, flips `Video.status` accordingly. This is a **separate write**, done here, after each individual rendition's own status write — the source of a real race condition described below.
9. Publishes a `rendition_completed` (or `rendition_failed`) event onto RabbitMQ's durable `video-events` queue.
10. `try/finally` guarantees `tmp/` is cleaned up regardless of success or failure.

If a job fails, BullMQ retries with exponential backoff. Only once BullMQ has **exhausted** all configured retry attempts does the `TranscodingJob` get written to `FAILED` — a mid-attempt failure is not yet a final failure.

## 4. Live Progress — Server to Browser

1. `server` hosts a WebSocket server. On upgrade request, it authenticates using the **same JWT cookie** already used for REST auth — no separate WS auth scheme.
2. Once connected, the client subscribes to a specific `videoId` (ownership verified). `server` tracks this in an in-process `Map<videoId, Set<socket>>`.
3. `server` also runs a BullMQ `QueueEvents` listener, which receives the Redis pub/sub events fired by `job.updateProgress()` (step 3.4 above) and any completed/failed transitions.
4. `server` relays these events to whichever sockets are subscribed to that `videoId` — this is the mechanism behind the live climbing percentage bar in the UI.

*(In the deployed environment specifically, WebSockets are disabled via an env flag and the frontend falls back to HTTP polling of video/rendition status instead — a coarser but functionally equivalent path, kept deliberately separate from the local/dev behavior rather than replacing it.)*

## 5. Notifications & Email

1. `notification-service` independently consumes `rendition_completed`/`rendition_failed` events off the RabbitMQ queue (manual ack — a message is only removed once actually processed, so a crash mid-processing means redelivery, not loss).
2. For each event, writes a per-rendition `Notification` row.
3. Checks — via a Postgres JSON-path query against existing rendition rows, not a new schema column — whether **all** renditions for that video have now reached a terminal state.
4. If so, and only once per video (deduplicated by that same check), sends **one** batched summary email via Resend's HTTP API (chosen specifically because it works over port 443, unlike the Gmail-SMTP path originally used, which Render's free tier blocks at the network level for SMTP ports).
5. A failure email links to `${FRONTEND_URL}/videos/{videoId}` with a **Retry button** — deliberately not a directly clickable mutating link, since a GET request that silently mutates state (triggers a retry) on click/prefetch is a real anti-pattern to avoid.

## 6. Playback

1. Frontend's `VideoDetail` page fetches the video record — `playbackUrl` is served via R2's **public** `r2.dev` subdomain (not presigned — HLS's sub-playlist relative references don't carry a signature, so presigned URLs broke this specific case).
2. `hls.js` fetches `master.m3u8`, then adaptively fetches segment files, switching between available renditions based on measured bandwidth (ABR) — no manual quality selector; this is intentionally the only quality-selection mechanism (see architecture doc §11's frontend note).
3. Playback readiness is gated on `video.status` directly on the frontend — **not** on inspecting individual rendition statuses — specifically because of the race described next.

## 7. A Real Race Condition Worth Narrating End-to-End

Because step 3.8 (`finalizeVideoStatusIfDone()`) writes the video-level status **separately from, and after,** each rendition's own status write, there's a real window where every individual rendition already shows `READY` but the video-level aggregate hasn't been flipped yet. A frontend that (incorrectly) derives "done" from scanning rendition statuses itself can render a "ready to play" state slightly before the backend agrees — this was a real bug (fixed by checking `video.status` directly instead of re-deriving it client-side), and it's a clean, concrete example of an eventual-consistency gotcha in a system with legitimately separate, sequential writes rather than one atomic transaction covering both.

## 8. Retry Path

1. User clicks Retry on a failed rendition → `POST /videos/renditions/:id/retry`.
2. `server` re-enqueues **only that rendition's** BullMQ job — not the whole video — because each rendition is an independent unit of work (architecture doc §3). The other, already-successful renditions are untouched.
3. From here, the flow re-enters step 3 exactly as before for that one job.