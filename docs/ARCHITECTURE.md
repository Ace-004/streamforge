# StreamForge — Architecture & Trade-offs

A decision-by-decision technical record of *why* the system is built the way it is. Each section states the choice, the alternatives that were on the table, and the trade-off explicitly accepted. This is written to be defensible in an interview — not just "what we built" but "what we gave up and why that was the right call for this project."

---

## 1. High-Level System Shape

StreamForge is a distributed, asynchronous video transcoding platform — architecturally similar in shape to how YouTube/Vimeo-class systems separate the "fast path" (user-facing upload/API) from the "slow path" (CPU-heavy transcoding), connected by a durable queue rather than a direct function call.

**Services:**
- `server` — HTTP API, auth, presigned-upload orchestration, WebSocket server, enqueues jobs.
- `worker` — pulls jobs from the queue, runs FFmpeg, uploads renditions, updates DB, publishes events.
- `notification-service` — consumes events from RabbitMQ, writes notifications, sends batched emails.
- `frontend` — React SPA, talks to `server` over REST + WebSocket.

**Why split into separate services at all, instead of one monolith doing everything synchronously?**
Transcoding is CPU-bound and can take from seconds to minutes depending on video length/resolution. If `server` did this inline on the upload request, the HTTP request would hang for the full duration, tie up a request thread, and any crash mid-transcode would kill the whole API process. Decoupling via a queue means:
- The upload API responds immediately (the client gets an ack in milliseconds, not minutes).
- `worker` can be scaled independently of `server` (more CPU-bound workers without touching the API tier).
- A worker crash doesn't take down the API.

**Trade-off accepted:** this adds real distributed-systems complexity — you now have to reason about jobs that fail mid-flight, duplicate delivery, and state that lives partly in the DB and partly in the queue. That complexity is the entire point of the project (to demonstrate that this trade-off is understood and handled correctly), not an accident.

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

**Why:** If the browser uploaded to `server` first and `server` re-uploaded to R2, every byte of every video would transit the API server twice, doubling bandwidth cost and tying up server memory/connections for the duration of large uploads. Presigned URLs let the client talk directly to object storage while the server never touches the file bytes — it only issues a short-lived, cryptographically signed permission slip.

**Internal mechanism (this is the part worth being able to explain cold):** a presigned URL's signature is an HMAC computed over the request (method, resource path, expiry, and a subset of headers) using R2's secret access key. Because it's HMAC-signed, R2 can verify on the receiving end that *this exact request* was authorized by someone holding the secret, without R2 ever needing to see the secret itself, and without `server` exposing its R2 credentials to the browser. The signature is only valid for that specific request shape and only until the expiry timestamp baked into it.

**Follow-on decision — completion is a separate explicit step, not inferred from the PUT succeeding:** `server` has no way to know the browser's PUT to R2 actually succeeded (that request never touches `server`). So `POST /videos/:id/complete` does a `HeadObjectCommand` against R2 as a guard — actually checking the object exists at the expected key/size before trusting the client's claim that "upload finished." This closes an obvious gap: a malicious or buggy client calling `/complete` without ever having uploaded anything.

**Known limitation accepted:** presigned URLs were also tried for serving HLS *playback* (so the player could stream renditions via signed URLs instead of a public bucket), but broke on HLS's own sub-playlist references — the master `.m3u8` references relative paths to segment files, and those relative references don't carry a signature. Switched to R2's public `r2.dev` subdomain for playback instead. This is a real, working-system trade-off (less access control on playback URLs) accepted because the segments themselves aren't sensitive in this project's threat model — worth stating outright if asked, not glossing over.

---

## 5. Queueing: BullMQ (Redis) for Transcode Jobs, RabbitMQ for Cross-Service Events — Not Just One Queue Technology

**Decision:** Two different queueing technologies are used for two different purposes, on purpose:
- **BullMQ (Redis-backed)** for `server → worker` transcode job dispatch.
- **RabbitMQ** for `worker → notification-service` event delivery (`rendition_completed` / `rendition_failed`).

**Why not just one queue everywhere?** These are actually different problems:
- Transcode jobs need per-job **progress reporting** (percent complete, live), fine-grained **retry/backoff** semantics, and a **dead-letter concept** — BullMQ was built specifically for this job-queue pattern and provides all of it out of the box on top of Redis, which is already in the stack for other reasons.
- Cross-service events are simpler pub/sub-shaped: "this thing happened, whoever cares can react." RabbitMQ's durable queue with acknowledgment gives at-least-once delivery to `notification-service` without coupling `worker` to knowing anything about who's listening.

Using BullMQ for both would mean hand-building the durable-event-fanout semantics RabbitMQ gives for free; using RabbitMQ for the transcode jobs would mean losing BullMQ's built-in progress/retry/backoff tooling. Each was picked for what it's actually good at, not out of technology-collecting.

**Internal mechanism — BullMQ's failed-job tracking IS the dead-letter queue:** BullMQ doesn't need a separate DLQ concept. Every job that exhausts its configured retry attempts transitions to a `failed` state and stays queryable in Redis (via the job's ID, kept in a sorted set) rather than disappearing. That failed-jobs list *is* the dead-letter queue — it's just a state, not a separate structure — and the `FAILED` DB status is only written once BullMQ has genuinely exhausted retries, not on the first attempt's failure.

---

## 6. Worker Design: Download → Process → Upload → Update, with try/finally Cleanup

**Decision:** each worker job: downloads the source from R2 to a local tmp dir → spawns FFmpeg as a child process for that one rendition → uploads the resulting HLS output back to R2 → updates `VideoRendition`/`TranscodingJob` status **only after** the upload succeeds → regenerates `master.m3u8` → checks whether the video as a whole is now done.

**Why status is written only after upload succeeds, not after FFmpeg finishes:** a rendition isn't actually usable until its files exist in R2. Marking it `READY` right after FFmpeg exits but before the upload completes would create a window where the DB claims a video is playable and it isn't yet (or the upload could fail entirely, silently leaving a phantom-ready rendition).

**Why `try/finally` around temp file cleanup:** local disk under `tmp/` is a shared, finite resource across every job a worker processes. Without a guaranteed cleanup on every exit path (success *or* thrown error), failed jobs would leak disk indefinitely and eventually take the worker down entirely — a slow, silent failure mode that's much worse than the job itself failing loudly.

---

## 7. `finalizeVideoStatusIfDone()` — Aggregating Per-Rendition State to Per-Video State

**Decision:** a small dedicated function, called at the end of every worker job, checks whether *all* renditions for that video have reached a terminal state (`READY` or `FAILED`), and if so flips `Video.status` accordingly.

**Why this needs to exist at all (see §3):** splitting work into independent per-rendition jobs (a deliberate win) means there's no single place in the code where "this video is done" is naturally true — it's an emergent property of N independent jobs, each of which only knows about itself. This function is the explicit place that reconciles the many-jobs reality back into the one-video status the frontend actually cares about.

**Real bug this surfaced later (see §11):** because this write is *separate* from the individual rendition-status writes, there's a real race window between "all renditions show READY" and "the video-level status is actually flipped." A naive frontend checking rendition statuses instead of `video.status` directly can render playback before the backend agrees the video is ready. This is a genuine distributed-systems gotcha, not a hypothetical — see the deployment bugs section.

---

## 8. Reconciliation Sweep — A Second, Independent Consistency Mechanism

**Decision:** a separate BullMQ queue runs a sweep job every 15 minutes, checking for videos stuck in `PENDING` and confirming via R2's `HeadObjectCommand` whether the source file actually exists.

**Why this is needed even though the upload flow is already guarded:** the `/complete` endpoint's `HeadObjectCommand` guard (§4) only checks *at the moment `/complete` is called*. If a client uploads to R2 but the browser tab closes before calling `/complete` at all, there's no event that ever tells the backend the upload happened or didn't — the video row is stuck `PENDING` forever with nothing to trigger a state change. The sweep is a periodic, independent second check that doesn't depend on any client ever calling back in — it actively verifies reality against the DB rather than waiting to be told. This is a standard reconciliation pattern for systems where client-reported state can't be fully trusted.

---

## 9. Notification Batching — One Email Per Video, Not Per Rendition

**Decision:** `notification-service` writes a `Notification` row for every rendition event, but only sends **one** summary email per video, once *all* renditions for that video have reached a terminal state — deduplicated via a Postgres JSON-path check rather than a schema migration.

**Why:** a video with 3 target resolutions would otherwise generate 3 separate emails for a single user action, which is bad UX and looks amateurish. Batching to one summary email requires knowing when "all renditions done" is true — which is the same aggregation problem as §7, solved independently here (rather than depending on `worker`'s `finalizeVideoStatusIfDone()`) because `notification-service` shouldn't be coupled to `worker`'s internal implementation — it should be able to answer that question from the event stream and DB state it already has.

**Why a JSON-path check instead of a new schema column:** a new "already notified" boolean column would have needed a migration and ongoing bookkeeping. Querying existing rendition statuses via Postgres's native JSON-path support achieved the same dedup guarantee against data that already existed, avoiding schema churn for a derivable fact.

---

## 10. Email Transport: Gmail SMTP → Resend HTTP API (a deployment-driven pivot, not a Phase-3 mistake)

**Original decision (Phase 3):** Nodemailer over Gmail SMTP. Resend/SendGrid/SES were considered and rejected *at that time* specifically because they required domain verification / approved production access before they'd deliver to arbitrary real recipients — Gmail SMTP would send to anyone immediately, accepting a ~500/day cap and no delivery analytics as the trade-off.

**What changed:** once the custom domain (`ayushrana.me`) was verified with Resend during deployment, Resend's "only send to yourself" sandbox restriction no longer applied — reopening it as a real option. Independently, Render's free tier turned out to block **all outbound SMTP traffic on ports 25/465/587** as a platform policy (confirmed via Render's own changelog) — not fixable by any client-side code change.

**Why this is worth narrating as two separate problems, not one:** the first failure (`ENETUNREACH`) was a real, fixable bug — Render's container had no outbound IPv6 route despite DNS returning an IPv6 address for Gmail's SMTP host, fixed by forcing `family: 4` (IPv4) on the Nodemailer transport. The *second* failure (`ETIMEDOUT`, after the IPv4 fix) was a platform-level policy block, not a bug — no amount of further debugging on the code side would have fixed it. Recognizing "this is not a code problem" and switching transport (Resend's HTTP API rides over port 443, which isn't blocked) rather than continuing to debug a socket that was never going to connect is the actual engineering judgment worth highlighting here.

---

## 11. WebSockets: Hosted on `server`, Hand-Rolled with `ws`, Not Socket.IO

**Decision:** `server` (not `worker` or `notification-service`) hosts the WebSocket server, using the plain `ws` library rather than Socket.IO.

**Why `server` and not the background services:** `server` is the only service that already terminates client-facing HTTP connections and has the auth/session context (JWT cookie) needed to authenticate a socket. `worker` and `notification-service` are non-scalable-client-facing background consumers — they have no reason to ever hold a client connection open.

**Why plain `ws` over Socket.IO:** Socket.IO would have handled reconnection/fallback/rooms automatically, but at the cost of hiding exactly the mechanics this project exists to demonstrate understanding of. Hand-writing the upgrade-request authentication, the per-videoId subscription tracking, and the relay from Redis pub/sub events to open sockets means every part of that path can be explained, not just "Socket.IO handles it."

**Mechanism:** the HTTP upgrade request is authenticated using the JWT cookie already present on it (same auth as regular REST calls — no separate WS-specific auth scheme needed). Ownership is verified per-`videoId` subscription. Open sockets are tracked in-process via a `Map<videoId, Set<socket>>`. `server`'s BullMQ `QueueEvents` listener (itself backed by Redis pub/sub) receives progress/completed/failed events from jobs running on `worker` and relays them to whichever sockets are subscribed to that video.

**Known, explicitly accepted scope limit:** the `Map<videoId, Set<socket>>` lives in a single `server` process's memory. It would not work correctly across multiple `server` replicas — a client connected to replica A wouldn't receive an event whose triggering job update was relayed only to replica B's in-memory map. Fixing this for real horizontal scaling would require moving that fan-out through Redis pub/sub across instances (a well-known pattern), deliberately left out of scope here as a documented, single-instance-only limitation rather than an oversight.

**Deployment-only fallback:** `ENABLE_WEBSOCKETS` (server) / `VITE_ENABLE_WS` (frontend) env flags, default `true`, are set `false` only on the deployed environment (Render's free tier had WebSocket-support concerns for the target plan), activating a coarser HTTP-polling fallback (status-only, no live percent) in the frontend instead of deleting the real, tested WS feature. Local/Docker Compose behavior is completely unchanged.

---

## 12. Deployment Topology: Free-Tier-Driven, With the Trade-offs Stated Up Front

**Final architecture:** frontend → Vercel (custom domain `streamforge.ayushrana.me`). Postgres → Neon. Redis → Upstash. RabbitMQ → CloudAMQP. `server` + `worker` + `notification-service` → bundled into **one** Render free Web Service container.

**Why bundle three services into one container — isn't that a step backward from the whole point of splitting them?** Render's free tier has no "Background Worker" service type at all (that tier starts at $7+/mo per service), and a genuinely separate `worker`/`notification-service` deployment would have required paying for services this project isn't monetized to justify. Bundling them into one container's `start.sh` — which runs `worker` and `notification-service` backgrounded with `&`, and `server` in the foreground last (so it controls the container's lifecycle for Render's healthcheck) — is an explicit, cost-driven compromise. The existing `docker-compose.yml` already demonstrates the "real" architecture (genuinely separate services, each independently scalable), which is what would run in an actual production deployment with a real budget. This is the single most important trade-off to be able to explain unprompted in an interview: **the code's architecture and the demo's deployment topology are two different things, and the gap between them is a budget constraint, not a design misunderstanding.**

**Known accepted limitation of the bundled container:** a backgrounded process (`worker` or `notification-service`) crashing shortly after start is invisible both to `start.sh`'s `set -e` and to Render's healthcheck (which only observes `server`). A proper process supervisor (e.g. `pm2`, `supervisord`) would be the correct fix; judged not worth the added complexity for a free-tier demo deployment where this failure mode has not been observed in practice.

**Cold starts:** Render's free tier sleeps the container after 15 minutes of no inbound traffic. A dedicated, dependency-free `/health` endpoint (no DB/Redis/RabbitMQ calls — just confirms the Node process is alive) is pinged every 5 minutes by an external uptime monitor to keep the container warm, specifically to avoid a 30–60s cold-start delay during a live demo or interview.

---

## 13. Testing Scope — What Was Tested, and What Was Deliberately Left Untested

**Decision:** Vitest + Supertest integration tests against real isolated Postgres/Redis (via a separate `docker-compose.test.yml`), not mocked Prisma. 20 tests total: `server`'s auth flow (7) and video-retry endpoint (4, asserting actual DB state post-request, not just response codes), plus `worker`'s pure progress-calculation logic (9 unit tests, including a named regression test for a real bug — see §14).

**Why real DB/Redis instead of mocks:** mocking Prisma would test that the code calls Prisma correctly, not that the actual SQL/transactions behave correctly against a real database — for a project centered on getting the distributed-systems mechanics right, that's the part actually worth verifying.

**Why `server/index.ts` and `worker.ts` needed refactoring to enable this at all:** both had import-time side effects (instantiating a real HTTP listener / a real BullMQ Worker + Redis connection just by importing the file), which made them un-importable by a test runner without those side effects firing. Splitting `server` into `app.ts` (pure construction, importable) + `index.ts` (runtime/side-effects, only run when actually started) let Supertest import a bare `app` and test it directly. The same split was applied to `worker` by extracting the pure logic (`parseFFmpegTimeSeconds`, `calculatePercent`) into `worker/src/lib/progress.ts`, separate from the file that actually stands up the Worker/Redis connection.

**Deliberate scope boundary — what's untested:** `worker`'s actual job-processing logic (the FFmpeg spawn/upload/DB-write sequence), `notification-service`, and the RabbitMQ/WebSocket reconnect logic remain untested. This was an explicit decision, not an oversight — full coverage of every reconnect edge case is a reasonable thing to defer for a fresher's portfolio project, and being able to say *why* that line was drawn (rather than claiming full coverage) is itself a signal of engineering judgment.

---

## 14. Bugs Actually Found and Fixed (Worth Knowing Cold)

These are real, previously-shipped bugs — not hypotheticals — and are good material for "tell me about a bug you found" style questions:

1. **Percent-rounding bug (Phase 4):** `Math.round(x/y) * 100` rounds the 0–1 fraction to the nearest integer *before* multiplying by 100 — so it can only ever produce `0` or `100`, never a smooth progress percentage. Fixed to `Math.round((x/y) * 100)`. Caught with a named regression test in `worker`'s test suite so it can't silently reappear.
2. **Missing `withCredentials: true` on axios (Phase 6):** broke *all* cookie-based auth silently — the API calls returned success-looking responses, but the browser never stored the cross-origin cookie, so every subsequent "authenticated" request was actually anonymous. Only caught via real browser testing; `curl` never surfaces this class of bug because `curl` doesn't enforce the browser's cookie/CORS model.
3. **`Notification.status` update no-op (Phase 3 audit):** a `where` clause referenced the wrong field, so update calls silently succeeded (no error thrown) but updated zero rows. A reminder that "no error" is not the same as "did what I intended" — this class of bug only surfaces by checking actual resulting state, which is exactly why the retry test (§13) asserts DB state directly instead of trusting response codes.
4. **`VideoDetail.tsx` polling race (deployment):** frontend derived "done" from individual rendition statuses instead of `Video.status` directly, creating a real window where renditions showed `READY` before the backend's separate `finalizeVideoStatusIfDone()` write had flipped the video-level status — playback wouldn't appear until the page was manually refreshed. Direct consequence of the §7 design (video-level status is a derived, separately-written fact) — fixed by having the frontend check the single source of truth (`video.status`) instead of re-deriving it client-side.
5. **R2 CORS (Phase 6):** the R2 bucket needed its own explicit CORS policy for browser uploads to work at all — another browser-enforced behavior invisible to `curl`-based testing, reinforcing why real end-to-end browser verification (not just API testing) mattered before calling any phase complete.

---

## 15. What Was Deliberately Deferred (and Why That's a Defensible Answer, Not a Gap)

- **API key endpoints** — schema table (`api_keys`) exists and is migrated, but the endpoints were never built. Deferred as low-priority since the core resume-relevant architecture doesn't depend on it.
- **Video deletion / cleanup logic** — not yet built.
- **Real production metrics** (transcode throughput, queue depth under load) — deferred until there's a reason to generate real load to measure, rather than fabricating numbers.
- **Video-level access control beyond auth** — playback URLs are public-bucket-served (§4), not per-request authorized; acceptable given the project's actual threat model (a portfolio demo, not a platform holding sensitive user content).

The consistent theme across every deferred item: each one was a conscious scope decision with a stated reason, not something simply not gotten to. Being able to say "I chose not to build X because Y, and here's what I'd do differently with more time/budget" is a stronger answer than pretending the system is more complete than it is.