# StreamForge — Tech Stack Reference

For every technology used: **what it's used for here**, **why it was picked over the alternatives**, and **what it's actually doing internally** — the level of detail that separates "I used X" from "I understand X."

---

## Backend Runtime & Language

### Node.js + TypeScript
- **Used for:** all three backend services (`server`, `worker`, `notification-service`).
- **Why:** a single language across the whole backend (plus the React frontend) means shared types, one dependency ecosystem, and no context-switching cost. TypeScript specifically over plain JS to catch a real class of bugs (wrong field names, wrong argument types) at compile time rather than at runtime in production.
- **Internally:** Node's single-threaded event loop with a libuv-backed thread pool for I/O means the API tier is well suited to being I/O-bound (waiting on DB/Redis/R2) without blocking — but it's exactly *why* CPU-bound work like FFmpeg transcoding is deliberately pushed out to a child process (`worker` spawning FFmpeg), not run inline on the event loop, since a synchronous CPU-bound task would freeze the entire process for everyone.

---

## Database Layer

### PostgreSQL + Prisma (raw SQL where needed)
- **Used for:** the system of record — `users`, `videos`, `video_renditions`, `transcoding_jobs`, `notifications`, `api_keys` (unused).
- **Why Postgres over a NoSQL store:** the data is genuinely relational — a video has many renditions, each has many jobs, and correctness depends on transactional guarantees (e.g., creating a `VideoRendition` + its `TranscodingJob` together, atomically, in §"Upload pipeline" — see architecture doc §4). A document store would make that harder to guarantee without hand-rolled consistency logic.
- **Why Prisma:** typed query results matching the TypeScript models, migrations as versioned code, and enough escape hatches (raw SQL, JSON-path queries) to not be boxed in when the ORM's query builder isn't the right tool (e.g. the notification dedup check in the architecture doc §9 uses a native Postgres JSON-path query rather than forcing everything through Prisma's query builder).
- **Internally:** Prisma generates a typed client from `schema.prisma` at build time; migrations are plain SQL files under version control, applied via `prisma migrate deploy` — which is why it's safe to run on every container startup (idempotent: already-applied migrations are skipped, not re-run).

---

## Caching / Queue Backend

### Redis (via Upstash in production)
- **Used for:** the backing store for BullMQ (transcode job queue) and for BullMQ's `QueueEvents` pub/sub mechanism (relayed to WebSocket clients).
- **Why:** BullMQ requires Redis specifically — it's not a generic cache choice here, it's a direct dependency of the queue library.
- **Internally:** BullMQ stores jobs as Redis hashes, with sorted sets tracking job state (`waiting`, `active`, `delayed`, `completed`, `failed`) by score (typically timestamp/priority). Progress updates (`job.updateProgress()`) write to the job's hash and publish a Redis pub/sub event, which is what `server`'s `QueueEvents` listener picks up and relays to subscribed WebSocket clients — the live percent bar is, mechanically, a Redis pub/sub message forwarded over a WebSocket.

---

## Job Queue

### BullMQ
- **Used for:** `server → worker` transcode job dispatch — one job per rendition (architecture doc §3, §5).
- **Why over alternatives (raw Redis lists, Bull v3, Agenda/Bee-Queue):** BullMQ is the actively maintained successor to Bull, gives per-job progress reporting, configurable retry/backoff, and a queryable failed-jobs list out of the box — all needed here, not incidental features.
- **Internally:** a job added to a queue is pushed onto a Redis list/sorted-set structure; a `Worker` instance polls (or is woken via Redis blocking pops) and atomically claims a job via a Redis-level lock so two workers can't process the same job concurrently. On failure, BullMQ re-queues the job with exponential backoff up to a configured attempt count; once attempts are exhausted, the job moves to a `failed` state and is retained (queryable by ID) rather than deleted — this **is** the dead-letter queue, not a separate structure (see architecture doc §5).

---

## Message Broker

### RabbitMQ (via CloudAMQP in production)
- **Used for:** `worker → notification-service` event delivery (`rendition_completed`, `rendition_failed`) over a durable `video-events` queue.
- **Why a separate broker instead of reusing BullMQ/Redis for this too:** this is pub/sub-shaped ("something happened, notify whoever cares"), not job-queue-shaped (no need for progress %, no need for per-consumer retry/backoff tuning). RabbitMQ gives durable, acknowledged delivery to a decoupled consumer without `worker` needing to know anything about `notification-service`'s existence or availability.
- **Internally:** `worker` publishes to a durable queue (survives broker restarts because both the queue and the messages are marked persistent); `notification-service` consumes with manual acknowledgment, so a message is only removed from the queue once `notification-service` has actually finished processing it — if `notification-service` crashes mid-processing, the unacknowledged message is redelivered rather than lost. Both `worker` (publish side) and `notification-service` (consume side) implement their own reconnect logic, deliberately shaped differently: `worker`'s connection is lazy/pull-driven with a `connectingPromise` guard (only reconnects when it actually needs to publish next), while `notification-service`'s is push-driven with an active reconnect loop (it needs to always be listening). Both cap backoff at 30s.

---

## Video Processing

### FFmpeg (spawned as a child process, not a Node binding)
- **Used for:** the actual transcode — source video → per-resolution HLS output (`.m3u8` playlists + `.ts` segments).
- **Why spawn the CLI binary rather than use an FFmpeg Node binding/wrapper library:** direct control over exact flags, and — critically — the ability to parse FFmpeg's own `stderr` progress output (`time=` timestamps) to compute a live percentage, rather than depending on a wrapper library's own (sometimes incomplete) progress-reporting API.
- **Internally:** FFmpeg is run as a child process per job; its `stderr` stream is parsed line-by-line for `time=HH:MM:SS.ms` markers, compared against the known total duration (from `ffprobe`) to compute `percent = Math.round((elapsed / duration) * 100)` — reported into BullMQ's `job.updateProgress()`. HLS output specifically means FFmpeg is invoked to produce a `.m3u8` manifest plus a sequence of `.ts` (or fMP4) segment files per rendition; a `master.m3u8` is separately regenerated after each rendition completes, referencing all currently-ready renditions so ABR (adaptive bitrate) selection works as soon as any subset of renditions exists.

### ffprobe
- **Used for:** probing an uploaded source file's metadata (duration, resolution, codecs) right after upload, before any transcode job is created.
- **Why:** the applicable target renditions are decided from the source's actual properties (e.g. don't generate a 1080p rendition from a 480p source) — this has to happen before jobs are enqueued, so it runs synchronously in `server`'s `/complete` handler, not in `worker`.

---

## Object Storage

### Cloudflare R2
- **Used for:** source video uploads and all HLS output (manifests + segments).
- **Why R2 over S3 directly:** R2 is S3-API-compatible (so the same SDK/tooling works) but has no egress fees — relevant for a video-serving workload where segments get downloaded repeatedly during playback, and a meaningful cost consideration even at portfolio-project scale.
- **Internally (presigned URLs):** see architecture doc §4 — HMAC-signed request authorization, verified server-side (R2's side) without the secret ever leaving `server`. Playback specifically uses R2's public `r2.dev` subdomain rather than presigned URLs, because HLS's own sub-playlist relative references don't carry a signature (a real limitation hit and worked around, not a design preference).

---

## Auth

### JWT (in an httpOnly cookie) + bcrypt
- **Used for:** session auth across REST calls and the WebSocket upgrade handshake.
- **Why JWT in an httpOnly cookie rather than a bearer token in `localStorage`:** an httpOnly cookie is inaccessible to JavaScript, which meaningfully reduces XSS-based token theft compared to `localStorage`, at the cost of needing explicit `SameSite`/CORS configuration for cross-origin requests (a real issue hit during deployment — see architecture doc §12/bug log).
- **Why bcrypt for password hashing:** a deliberately slow, salted hash function — the slowness is the point, since it makes brute-force/rainbow-table attacks on stolen password hashes computationally expensive, unlike a fast general-purpose hash (e.g. SHA-256) which would be a mistake here.
- **Internally:** the JWT's signature (HMAC or RSA depending on config) lets `server` verify the token wasn't tampered with, without a database round-trip on every request — the trade-off being that a JWT can't be instantly revoked before its expiry without additional server-side state (not currently implemented; a known simplification).

### zod
- **Used for:** request-body validation on auth and upload routes.
- **Why:** runtime validation — TypeScript types are erased at runtime and give zero protection against a malformed/malicious actual HTTP request body; `zod` schemas are the runtime enforcement of the same shape TypeScript checks at compile time.

---

## Real-Time Layer

### `ws` (plain WebSocket library, not Socket.IO)
- See architecture doc §11 for the full reasoning (hand-rolled for understanding, not convenience) and the internal mechanism (JWT-cookie-authenticated upgrade request, `Map<videoId, Set<socket>>` in-process subscription tracking, BullMQ `QueueEvents`-driven relay).

---

## Frontend

### React (Vite, TypeScript) + react-router-dom + axios + hls.js
- **Vite over Create React App:** faster dev server (native ESM, no bundling in dev) and faster production builds — CRA is effectively unmaintained at this point.
- **axios (shared instance, `withCredentials: true`) over the native `fetch`:** mainly for a shared instance with consistent config (base URL, credentials) across every call site — and this specific config flag was the source of a real, subtle bug (architecture doc §14) since it's easy to forget and fails silently rather than erroring.
- **hls.js:** the browser's native `<video>` element doesn't universally support HLS playback (reliable mainly in Safari); `hls.js` implements the HLS protocol (parsing `.m3u8`, fetching/buffering `.ts` segments, adaptive bitrate switching) in JavaScript on top of the Media Source Extensions API, giving consistent HLS playback across Chrome/Firefox/etc. A manual quality-selector dropdown (letting a user force a specific rendition) was attempted but deliberately dropped after discovering inconsistent native-HLS-support reporting across browsers broke the selector logic — ABR (automatic quality switching based on bandwidth) alone was already working correctly and was kept as the only quality-selection mechanism.

---

## Testing

### Vitest + Supertest
- **Vitest over Jest:** native ESM/TypeScript support without extra transform configuration — Jest's CJS-first design historically fights TS+ESM setups.
- **Supertest:** drives real HTTP requests against an in-memory instance of the Express `app` (importable specifically because of the `app.ts`/`index.ts` split — architecture doc §13), so tests exercise the real route/middleware stack rather than calling handler functions directly.
- **Real Postgres/Redis via `docker-compose.test.yml` (separate ports) instead of mocks:** validates actual SQL/transaction behavior rather than "did the code call Prisma with the right arguments" — the thing actually worth verifying for a project centered on distributed-systems correctness.

---

## Deployment & Hosting

### Docker (multi-stage builds)
- **Why multi-stage:** the build stage installs full dev dependencies and compiles TypeScript; the final stage copies only compiled output + production dependencies + FFmpeg (needed in both `server`, for `ffprobe`, and `worker`, for the actual transcode) into a lean `node:20-alpine`-based image — keeping the deployed image smaller than a naive single-stage build would produce.

### Render (bundled `server`+`worker`+`notification-service` container) / Vercel (frontend) / Neon (Postgres) / Upstash (Redis) / CloudAMQP (RabbitMQ) / Resend (email)
- Each choice here was free-tier-constraint-driven, not a "best in class" pick — see architecture doc §12 for the full reasoning (why bundled into one container, what that costs, and what a real-budget deployment would look like instead) and §10 for why email transport specifically pivoted from Gmail SMTP to Resend mid-deployment (a platform-level SMTP port block on Render's free tier, not a code bug).

---

## Summary Table

| Technology | Role | Chosen because |
|---|---|---|
| Node.js + TS | Backend runtime | Shared language w/ frontend, compile-time safety |
| PostgreSQL + Prisma | System of record | Relational integrity, transactional guarantees |
| Redis (Upstash) | Queue backend | Required by BullMQ; pub/sub for live progress |
| BullMQ | Transcode job queue | Built-in progress/retry/backoff/DLQ semantics |
| RabbitMQ (CloudAMQP) | Cross-service events | Durable pub/sub, ack-based at-least-once delivery |
| FFmpeg / ffprobe | Video transcode & probing | Full control over flags + real progress parsing |
| Cloudflare R2 | Object storage | S3-compatible, no egress fees |
| JWT + bcrypt | Auth | httpOnly-cookie XSS resistance; slow hash by design |
| ws | Real-time updates | Hand-rolled to demonstrate the actual mechanics |
| React/Vite/hls.js | Frontend | Fast dev/build; standards-based HLS playback |
| Vitest + Supertest | Testing | Native ESM/TS; real HTTP + real DB integration tests |
| Docker (multi-stage) | Packaging | Lean production images |