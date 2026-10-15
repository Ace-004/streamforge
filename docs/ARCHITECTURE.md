# StreamForge — Architecture & Trade-offs

A decision-by-decision technical record of *why* the system is built the way it is. Each section states the choice, the alternatives that were on the table, and the trade-off explicitly accepted.

---

## 1. High-Level System Shape

StreamForge is a distributed, asynchronous video transcoding platform — architecturally similar in shape to how large video platforms separate the "fast path" (user-facing upload/API) from the "slow path" (CPU-heavy transcoding), connected by a durable queue rather than a direct function call.

**Services:**
- `server` — HTTP API, auth, presigned-upload orchestration, WebSocket server, enqueues jobs.
- `worker` — pulls jobs from the queue, runs FFmpeg, uploads renditions, updates DB, publishes events.
- `notification-service` — consumes events from RabbitMQ, writes notifications, sends batched emails.
- `frontend` — React SPA, talks to `server` over REST + WebSocket.

**Why split into separate services at all, instead of one monolith doing everything synchronously?**
Transcoding is CPU-bound and can take from seconds to minutes depending on video length/resolution. If `server` did this inline on the upload request, the HTTP request would hang for the full duration, tie up a request thread, and any crash mid-transcode would kill the whole API process. Decoupling via a queue means:
- The upload API responds immediately (the client gets an ack in milliseconds, not minutes).
- `worker` can be scaled independently of `server` (more CPU-bound workers without touching the API tier).
- A worker crash doesn't take down the API (in the local/Compose topology; see §12 for the bundled free-tier deployment).

**Trade-off accepted:** this adds real distributed-systems complexity — jobs that fail mid-flight, duplicate delivery, and state that lives partly in the DB and partly in the queue. Handling that complexity correctly is the point of the project.

---

## 2. Monorepo vs. Separate Repos

**Decision:** Single monorepo, one root `docker-compose.yml`, each service (`server/`, `worker/`, `notification-service/`, `frontend/`) with its own `Dockerfile` and `package.json`.

**Alternative considered:** Separate repos per service (closer to how larger orgs with independent deploy pipelines per service would do it).

**Why monorepo:** At this project's scale, coordinated changes (e.g. a Prisma schema change touching both `server` and `worker`) are far more common than independent releases. A monorepo keeps that atomic — one commit, one PR, no cross-repo version drift to track. The trade-off (losing independent versioning/deploy cadence per service) doesn't matter yet because nothing here needs to deploy on a different cadence than anything else.

---

## 3. Data Model & Job-Per-Rendition Design

**Decision:** 6-table Postgres schema — `users`, `api_keys`, `videos`, `video_renditions`, `transcoding_jobs`, `notifications`. Each requested output resolution for a video gets its own `VideoRendition` row *and* its own `TranscodingJob` row, rather than one job per video that internally loops over resolutions.

**Why job-per-rendition, not job-per-video:** If one job handled all resolutions for a video sequentially, a failure at 1080p would either fail the entire video (losing 480p/720p work already done) or need its own internal retry/partial-completion bookkeeping. Making each rendition an independent unit of work means:
- BullMQ's own per-job retry/backoff logic can be used as-is — no hand-rolled partial-failure state machine.
- Renditions can genuinely process in parallel across multiple workers.
- A user can retry *just* the failed 1080p rendition without re-transcoding the others.

**Trade-off:** more rows, more jobs in flight, and a `finalizeVideoStatusIfDone()` step is now needed to figure out when a video, as a whole, is done (see §7). That aggregation cost is small and worth it for the independent-retry and parallelism wins.

---

## 4. Upload Path: Presigned URLs, Not Proxying Through the Server

**Decision:** `POST /videos/presign` returns an R2 presigned PUT URL; the browser uploads the raw video **directly to R2**, bypassing `server` entirely for the actual bytes. `POST /videos/:id/complete` is called afterward to confirm and kick off processing.

**Why:** If the browser uploaded to `server` first and `server` re-uploaded to R2, every byte of every video would transit the API server twice, doubling bandwidth cost and tying up server memory/connections for the duration of large uploads. Presigned URLs let the client talk directly to object storage while the server never touches the file bytes — it only issues a short-lived, signed permission slip.

**Internal mechanism:** a presigned URL carries a signature computed with HMAC (the S3-compatible SigV4 scheme) over the request's method, resource path, expiry, and a defined set of headers, using the secret access key. HMAC is symmetric, so R2 holds its own copy of that secret: on receiving the request it recomputes the signature and accepts the request only if it matches and hasn't expired. The secret itself never leaves the server and is never sent to the browser. The signature is valid only for that specific request shape and only until the expiry timestamp baked into it, so a leaked URL can't be repurposed for a different object or after it expires.

**Follow-on decision — completion is a separate explicit step, not inferred from the PUT succeeding:** `server` has no way to know the browser's PUT to R2 actually succeeded (that request never touches `server`). So `POST /videos/:id/complete` does a `HeadObjectCommand` against R2 as a guard — actually checking the object exists at the expected key before trusting the client's claim that "upload finished." This closes an obvious gap: a malicious or buggy client calling `/complete` without ever having uploaded anything.

**Known limitation accepted:** presigned URLs were also tried for serving HLS *playback* (so the player could stream renditions via signed URLs instead of a public bucket), but broke on HLS's own sub-playlist references — the master `.m3u8` references relative paths to segment files, and those relative references don't carry a signature. Switched to R2's public `r2.dev` subdomain for playback instead. This is a real, working-system trade-off (less access control on playback URLs) accepted because the segments themselves aren't sensitive in this project's threat model.

---

## 5. Queueing: BullMQ (Redis) for Transcode Jobs, RabbitMQ for Cross-Service Events

**Decision:** Two different queueing technologies are used for two different purposes, on purpose:
- **BullMQ (Redis-backed)** for `server → worker` transcode job dispatch.
- **RabbitMQ** for `worker → notification-service` event delivery (`rendition_completed` / `rendition_failed`).

**Why not just one queue everywhere?** These are different problems:
- Transcode jobs need per-job **progress reporting** (percent complete, live), fine-grained **retry/backoff** semantics, and a retained record of exhausted jobs — BullMQ was built specifically for this job-queue pattern and provides these out of the box. BullMQ requires Redis, so Redis is in the stack as a direct consequence of that choice.
- Cross-service events are simpler "this thing happened, whoever cares can react" messages. RabbitMQ's durable queue with acknowledgment gives at-least-once delivery to `notification-service` without coupling `worker` to knowing anything about who's listening.

Using BullMQ for both would mean hand-building the durable-event semantics RabbitMQ gives for free; using RabbitMQ for the transcode jobs would mean losing BullMQ's built-in progress/retry/backoff tooling. Each was picked for what it's actually good at.

**Internal mechanism — failed jobs:** when a job exhausts its configured retry attempts, BullMQ moves it to a `failed` set in Redis and retains it (queryable by job ID) rather than deleting it. That retained failed set plays the role of a dead-letter store. BullMQ does not automatically forward those jobs to a separate dead-letter queue, so a separate DLQ would be something to build deliberately if automated reprocessing were needed. Here, the `FAILED` DB status is only written once BullMQ has genuinely exhausted retries, not on the first attempt's failure, and a user-triggered retry re-enqueues the rendition (see WORKFLOW §8).

---

## 6. Worker Design: Download → Process → Upload → Update, with try/finally Cleanup

**Decision:** each worker job: downloads the source from R2 to a local tmp dir → spawns FFmpeg as a child process for that one rendition → uploads the resulting HLS output back to R2 → updates `VideoRendition`/`TranscodingJob` status **only after** the upload succeeds → regenerates `master.m3u8` → checks whether the video as a whole is now done.

**Why status is written only after upload succeeds, not after FFmpeg finishes:** a rendition isn't actually usable until its files exist in R2. Marking it `READY` right after FFmpeg exits but before the upload completes would create a window where the DB claims a video is playable and it isn't yet (or the upload could fail entirely, silently leaving a phantom-ready rendition).

**Why `try/finally` around temp file cleanup:** local disk under `tmp/` is a shared, finite resource across every job a worker processes. Without a guaranteed cleanup on every exit path (success *or* thrown error), failed jobs would leak disk indefinitely and eventually take the worker down entirely — a slow, silent failure mode that's much worse than the job itself failing loudly.

---

## 7. `finalizeVideoStatusIfDone()` — Aggregating Per-Rendition State to Per-Video State

**Decision:** a small dedicated function, called at the end of every worker job, checks whether *all* renditions for that video have reached a terminal state (`READY` or `FAILED`), and if so flips `Video.status` accordingly.

**Why this needs to exist at all (see §3):** splitting work into independent per-rendition jobs (a deliberate win) means there's no single place in the code where "this video is done" is naturally true — it's an emergent property of N independent jobs, each of which only knows about itself. This function is the explicit place that reconciles the many-jobs reality back into the one-video status the frontend actually cares about.

**Real bug this surfaced later (see §15, bug 4):** because this write is *separate* from the individual rendition-status writes, there's a real race window between "all renditions show READY" and "the video-level status is actually flipped." A naive frontend checking rendition statuses instead of `video.status` directly can render playback before the backend agrees the video is ready. This is a genuine eventual-consistency gotcha, not a hypothetical.

---

## 8. Reconciliation Sweep — A Second, Independent Consistency Mechanism

**Decision:** a separate BullMQ queue runs a periodic sweep job (a repeatable job; its interval is set in the job's repeat options) that checks videos stuck in `PENDING` and confirms via R2's `HeadObjectCommand` whether the source file actually exists, cleaning up orphans whose upload never happened.

**Why this is needed even though the upload flow is already guarded:** the `/complete` endpoint's `HeadObjectCommand` guard (§4) only checks *at the moment `/complete` is called*. If a client's upload fails, or the browser tab closes before calling `/complete` at all, there's no event that ever tells the backend what happened — the video row is stuck `PENDING` forever with nothing to trigger a state change. The sweep is a periodic, independent check that doesn't depend on any client ever calling back in — it actively verifies reality against the DB rather than waiting to be told. This is a standard reconciliation pattern for systems where client-reported state can't be fully trusted.

**Why the interval can be long:** the sweep only cleans up abandoned records; it isn't on any user-facing path, so a coarse interval costs nothing but a delay in garbage collection.

---

## 9. Notification Batching — One Email Per Video, Not Per Rendition

**Decision:** `notification-service` writes a `Notification` row for every rendition event, but only sends **one** summary email per video, once *all* renditions for that video have reached a terminal state — deduplicated via a Postgres JSON-path check rather than a schema migration.

**Why:** a video with 3 target resolutions would otherwise generate 3 separate emails for a single user action, which is bad UX. Batching to one summary email requires knowing when "all renditions done" is true — which is the same aggregation problem as §7, solved independently here (rather than depending on `worker`'s `finalizeVideoStatusIfDone()`) because `notification-service` shouldn't be coupled to `worker`'s internal implementation — it should be able to answer that question from the event stream and DB state it already has.

**Why a JSON-path check instead of a new schema column:** a new "already notified" boolean column would have needed a migration and ongoing bookkeeping. Querying existing rendition statuses via Postgres's native JSON-path support achieved the same dedup guarantee against data that already existed, avoiding schema churn for a derivable fact.

---

## 10. Email Transport: Gmail SMTP → Resend HTTP API (a deployment-driven pivot)

**Original decision (Phase 3):** Nodemailer over Gmail SMTP. Resend/SendGrid/SES were considered and rejected *at that time* specifically because they required domain verification / approved production access before they'd deliver to arbitrary real recipients — Gmail SMTP would send to anyone immediately, accepting a ~500/day cap and no delivery analytics as the trade-off.

**What changed:** once the custom domain (`ayushrana.me`) was verified with Resend during deployment, Resend's "only send to yourself" sandbox restriction no longer applied — reopening it as a real option. Independently, Render's free tier turned out to block **all outbound SMTP traffic on ports 25/465/587** as a platform policy — not fixable by any client-side code change.

**Two separate problems, not one:** the first failure (`ENETUNREACH`) was a real, fixable bug — Render's container had no outbound IPv6 route despite DNS returning an IPv6 address for Gmail's SMTP host, fixed by forcing `family: 4` (IPv4) on the Nodemailer transport. The *second* failure (`ETIMEDOUT`, after the IPv4 fix) was a platform-level policy block, not a bug — no amount of further debugging on the code side would have fixed it. The right move was to recognize "this is not a code problem" and switch transport: Resend's HTTP API rides over port 443, which isn't blocked.

---

## 11. WebSockets: Hosted on `server`, Hand-Rolled with `ws`, Not Socket.IO

**Decision:** `server` (not `worker` or `notification-service`) hosts the WebSocket server, using the plain `ws` library rather than Socket.IO.

**Why `server` and not the background services:** `server` is the only service that already terminates client-facing HTTP connections and has the auth/session context (JWT cookie) needed to authenticate a socket. `worker` and `notification-service` are background consumers — they have no reason to ever hold a client connection open.

**Why plain `ws` over Socket.IO:** Socket.IO would have handled reconnection/fallback/rooms automatically, but at the cost of hiding exactly the mechanics this project exists to demonstrate. Hand-writing the upgrade-request authentication, the per-videoId subscription tracking, and the relay from queue events to open sockets means every part of that path is understood and explainable.

**Mechanism:** the HTTP upgrade request is authenticated using the JWT cookie already present on it (same auth as regular REST calls — no separate WS-specific auth scheme needed). Ownership is verified per-`videoId` subscription. Open sockets are tracked in-process via a `Map<videoId, Set<socket>>`. `server` runs a BullMQ `QueueEvents` listener, which is built on a Redis stream (the queue's `events` stream, read with a blocking `XREAD`). When `worker` calls `job.updateProgress()` or a job completes or fails, an entry is appended to that stream; the listener reads it and relays it to whichever sockets are subscribed to that video.

**What this means for scaling, and the actual limits:** because each `server` instance runs its own `QueueEvents` reader over the shared stream, every instance sees every event and relays it to its own locally connected sockets, so the relay itself does not need extra cross-instance plumbing. The real limits of the current design are:
- Subscription state (`Map<videoId, Set<socket>>`) lives in one process's memory. If that instance restarts, its sockets drop and subscriptions are lost; clients must reconnect, re-subscribe, and re-fetch the current status over REST to catch up.
- Events are only read from the point the listener starts, so progress emitted while an instance was down is not replayed to its clients (the REST status fetch covers the gap for state, not for intermediate percentages).
- Every instance processes every event for every video, even those with no local subscribers. This is cheap at this scale but grows with total event volume, not with local connections.

**Deployment-only fallback:** `ENABLE_WEBSOCKETS` (server) / `VITE_ENABLE_WS` (frontend) env flags, default `true`, are set `false` only on the deployed environment, activating a coarser HTTP-polling fallback (status-only, no live percent) in the frontend instead of deleting the real, tested WS feature. Local/Docker Compose behavior is completely unchanged. Render web services do support WebSocket connections, but long-lived connections on the free tier have been reported by users to be dropped by the platform after a few minutes, so the deployment was configured conservatively with polling. Re-enabling WebSockets on the demo is a possible follow-up and has not been verified against current free-tier behavior.

---

## 12. Deployment Topology: Free-Tier-Driven, With the Trade-offs Stated Up Front

**Final architecture:** frontend → Vercel (custom domain `streamforge.ayushrana.me`). Postgres → Neon. Redis → Upstash. RabbitMQ → CloudAMQP. `server` + `worker` + `notification-service` → bundled into **one** Render free Web Service container.

**Why bundle three services into one container — isn't that a step backward from the whole point of splitting them?** Render's free tier has no "Background Worker" service type at all (that tier starts at $7+/mo per service), and a genuinely separate `worker`/`notification-service` deployment would have required paying for services this project isn't monetized to justify. Bundling them into one container's `start.sh` — which runs `worker` and `notification-service` backgrounded with `&`, and `server` in the foreground last (so it controls the container's lifecycle for Render's healthcheck) — is an explicit, cost-driven compromise. The existing `docker-compose.yml` already demonstrates the "real" architecture (genuinely separate services, each independently scalable), which is what would run in an actual production deployment with a real budget. The code's architecture and the demo's deployment topology are two different things, and the gap between them is a budget constraint, not a design misunderstanding.

**Known accepted limitation of the bundled container:** a backgrounded process (`worker` or `notification-service`) crashing shortly after start is invisible both to `start.sh`'s `set -e` and to Render's healthcheck (which only observes `server`). A proper process supervisor (e.g. `pm2`, `supervisord`) would be the correct fix; judged not worth the added complexity for a free-tier demo deployment where this failure mode has not been observed in practice.

**Cold starts:** Render's free tier spins the container down after 15 minutes without inbound traffic. A dedicated, dependency-free `/health` endpoint (no DB/Redis/RabbitMQ calls — just confirms the Node process is alive) is pinged on a schedule to keep the container warm, specifically to avoid a 30–60s cold-start delay during a live demo.

---

## 13. Testing Scope — What Was Tested, and What Was Deliberately Left Untested

**Decision:** Vitest + Supertest integration tests against real isolated Postgres/Redis (via a separate `docker-compose.test.yml`), not mocked Prisma. 20 tests total: `server`'s auth flow (7) and video-retry endpoint (4, asserting actual DB state post-request, not just response codes), plus `worker`'s pure progress-calculation logic (9 unit tests, including a named regression test for a real bug — see §15, bug 1).

**Why real DB/Redis instead of mocks:** mocking Prisma would test that the code calls Prisma correctly, not that the actual SQL/transactions behave correctly against a real database — for a project centered on getting the distributed-systems mechanics right, that's the part actually worth verifying.

**Why `server/index.ts` and `worker.ts` needed refactoring to enable this at all:** both had import-time side effects (instantiating a real HTTP listener / a real BullMQ Worker + Redis connection just by importing the file), which made them un-importable by a test runner without those side effects firing. Splitting `server` into `app.ts` (pure construction, importable) + `index.ts` (runtime/side-effects, only run when actually started) let Supertest import a bare `app` and test it directly. The same split was applied to `worker` by extracting the pure logic (`parseFFmpegTimeSeconds`, `calculatePercent`) into `worker/src/lib/progress.ts`, separate from the file that actually stands up the Worker/Redis connection.

**Deliberate scope boundary — what's untested:** `worker`'s actual job-processing logic (the FFmpeg spawn/upload/DB-write sequence), `notification-service`, and the RabbitMQ/WebSocket reconnect logic remain untested. This was an explicit decision, not an oversight — full coverage of every reconnect edge case is a reasonable thing to defer for a portfolio project, and the boundary is stated here rather than implying full coverage.

---

## 14. Load Testing & Concurrency Tuning

**Setup:** `server/scripts/load-test.ts` fires N uploads through the real API and polls each to a terminal state; `server/scripts/metrics.ts` runs raw SQL over the job table to compute processing-time percentiles per resolution, queue-wait percentiles, exact peak concurrency (via a timestamp event sweep), and batch wall-clock. A `createdAt` (enqueue time) column was added to `TranscodingJob` so queue wait could be measured against the existing `startedAt`/`completedAt`. Runs used Docker Compose locally on a 14-core/20-thread machine, 6 uploads (12 jobs) per run, at BullMQ worker concurrency 1, 2, and 3.

**Findings:**
1. **Default concurrency of 1 serialized everything.** Batch wall-clock was 117s with a p95 queue wait around 100s, even though each job's actual FFmpeg work was only ~9s. The bottleneck was scheduling, not encode speed.
2. **Concurrency 2 cut batch time by about a third.**
3. **Concurrency 3 gave almost no further gain, while per-job time nearly doubled.** Root cause: FFmpeg's `libx264` spawns as many threads as it likes by default, so more concurrent jobs meant more FFmpeg processes fighting for the same cores.
4. **Capping FFmpeg at `-threads 4` fixed most of the per-job slowdown.** With concurrency 2 and the cap, batch wall-clock fell to about 72s, roughly 39% below baseline, without giving up the throughput gain.
5. **Concurrency 3 with the thread cap still plateaued.** The likely culprit is disk I/O (R2 downloads and HLS segment writes) rather than CPU. This was not investigated further.

**What these numbers do and don't show:** the test clip is only 15 seconds long, which is fine for the scheduling and contention findings but means the results must not be read as "transcodes X minutes of video in Y seconds." Runs were local, not against the free-tier deployment, where platform limits would dominate. The disk-I/O explanation in point 5 is a hypothesis, not a measurement.

---

## 15. Bugs Actually Found and Fixed

These are real, previously-shipped bugs, each with a concrete lesson:

1. **Percent-rounding bug (Phase 4):** `Math.round(x/y) * 100` rounds the 0–1 fraction to the nearest integer *before* multiplying by 100 — so it can only ever produce `0` or `100`, never a smooth progress percentage. Fixed to `Math.round((x/y) * 100)`. Caught with a named regression test in `worker`'s test suite so it can't silently reappear.
2. **Missing `withCredentials: true` on axios (Phase 6):** broke *all* cookie-based auth silently — the API calls returned success-looking responses, but the browser never stored the cross-origin cookie, so every subsequent "authenticated" request was actually anonymous. Only caught via real browser testing; `curl` never surfaces this class of bug because `curl` doesn't enforce the browser's cookie/CORS model.
3. **`Notification.status` update no-op (Phase 3 audit):** a `where` clause referenced the wrong field, so update calls silently succeeded (no error thrown) but updated zero rows. A reminder that "no error" is not the same as "did what I intended" — this class of bug only surfaces by checking actual resulting state, which is why the retry test (§13) asserts DB state directly instead of trusting response codes.
4. **`VideoDetail.tsx` polling race (deployment):** frontend derived "done" from individual rendition statuses instead of `Video.status` directly, creating a real window where renditions showed `READY` before the backend's separate `finalizeVideoStatusIfDone()` write had flipped the video-level status — playback wouldn't appear until the page was manually refreshed. Direct consequence of the §7 design — fixed by having the frontend check the single source of truth (`video.status`) instead of re-deriving it client-side.
5. **R2 CORS (Phase 6):** the R2 bucket needed its own explicit CORS policy for browser uploads to work at all — another browser-enforced behavior invisible to `curl`-based testing, reinforcing why real end-to-end browser verification (not just API testing) mattered before calling any phase complete.
6. **Unbounded FFmpeg threading under worker concurrency (Phase 8):** see §14 — default `libx264` thread usage made concurrent jobs slow each other down; fixed with an explicit `-threads` cap.

---

## 16. What Was Deliberately Deferred

- **API key endpoints** — schema table (`api_keys`) exists and is migrated, but the endpoints were never built. Deferred as low-priority since the core architecture doesn't depend on it.
- **Video deletion / cleanup logic** — not yet built.
- **Load testing against the deployed stack** — local load tests are done (§14); the free-tier deployment's platform limits (shared CPU, bundled container) would dominate any results there, so they wouldn't say much about the architecture.
- **Video-level access control beyond auth** — playback URLs are public-bucket-served (§4), not per-request authorized; acceptable given the project's actual threat model (a portfolio demo, not a platform holding sensitive user content).
- **Test coverage for `worker`'s job-processing flow, `notification-service`, and reconnect logic** (§13).

Each of these was a conscious scope decision with a stated reason, along with what would be done differently with more time or budget.