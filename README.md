# StreamForge

**A distributed, YouTube-style video transcoding platform** — upload a video, it's automatically transcoded into multiple HLS renditions in parallel across a worker fleet, with live progress over WebSockets and email notifications on completion.

🔗 **Live demo:** [streamforge.ayushrana.me](https://streamforge.ayushrana.me)

Built to be architecturally honest: every service, queue, and trade-off exists for a stated reason — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full reasoning behind every major decision.

---

## Features

- 🔐 **Auth** — JWT in an httpOnly cookie, bcrypt password hashing, `zod`-validated requests, rate-limited auth routes
- ☁️ **Direct-to-storage uploads** — presigned R2 URLs, so video bytes never transit the API server
- ⚙️ **Distributed transcoding** — BullMQ + Redis job queue, one job per output rendition, processed in parallel by independently scalable workers, FFmpeg-driven HLS output
- 📡 **Live progress** — hand-rolled WebSocket layer relaying real FFmpeg progress from `worker` to the browser in real time
- 📬 **Event-driven notifications** — RabbitMQ pub/sub, batched (one email per video, not per rendition) via Resend
- ▶️ **Adaptive playback** — `hls.js`-powered player with automatic bitrate switching
- 🔁 **Self-healing** — a periodic reconciliation sweep catches uploads that never completed their handshake
- ✅ **Tested** — integration tests against real (isolated) Postgres/Redis, not mocks

---

## Architecture

```
                     ┌─────────────┐
   Browser  ───────► │   server    │ ───► Postgres (Neon)
       │             │  (REST+WS)  │
       │             └──────┬──────┘
       │ direct PUT         │ enqueues
       ▼                    ▼
┌─────────────┐      ┌─────────────┐        ┌──────────────────────┐
│ Cloudflare  │◄─────│   worker    │───────► │   RabbitMQ            │
│     R2      │ up-  │ (FFmpeg,    │ publish │  (video-events queue) │
│  (storage)  │ load │  BullMQ)    │         └──────────┬────────────┘
└─────────────┘      └─────────────┘                    │ consume
                             ▲                            ▼
                             │                  ┌──────────────────────┐
                             └── Redis (Upstash) │ notification-service │
                                  (job queue +   │  (batched email via  │
                                   pub/sub)      │   Resend)            │
                                                 └──────────────────────┘
```

Four independently deployable services — `server`, `worker`, `notification-service`, `frontend` — connected by a durable queue (BullMQ/Redis) for job dispatch and a message broker (RabbitMQ) for cross-service events, so the CPU-heavy transcoding path is fully decoupled from the request/response API path.

> **Note on the live demo's deployment topology:** for cost reasons (Render's free tier has no background-worker service type), `server` + `worker` + `notification-service` are bundled into a single container in production. The architecture above — genuinely separate, independently scalable services — is what `docker-compose.yml` runs locally, and is the real design. See [`docs/ARCHITECTURE.md` §12](docs/ARCHITECTURE.md) for the full reasoning.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js, TypeScript |
| API framework | Express |
| Database | PostgreSQL + Prisma |
| Job queue | BullMQ (Redis) |
| Message broker | RabbitMQ |
| Video processing | FFmpeg, ffprobe |
| Object storage | Cloudflare R2 |
| Real-time | WebSockets (`ws`) |
| Email | Resend |
| Frontend | React, Vite, TypeScript, `hls.js` |
| Auth | JWT (httpOnly cookie), bcrypt |
| Testing | Vitest, Supertest |
| Containerization | Docker, Docker Compose |

Full reasoning for every pick — including what was rejected and why — is in [`docs/TECH_STACK.md`](docs/TECH_STACK.md).

---

## Getting Started (Local Development)

### Prerequisites
- Docker + Docker Compose
- Node.js 20+ (if running services outside Docker)

### Run the full stack

```bash
git clone https://github.com/Ace-004/streamforge.git
cd streamforge
cp .env.example .env   # fill in the values below
docker compose up --build
```

This starts Postgres, Redis, RabbitMQ, `server`, `worker`, `notification-service`, and `frontend`, wired together.

- Frontend: `http://localhost:5173`
- API: `http://localhost:4000`

### Environment variables

| Variable | Used by | Description |
|---|---|---|
| `DATABASE_URL` | server, worker | Postgres connection string |
| `REDIS_URL` | server, worker | Redis connection string (BullMQ) |
| `RABBITMQ_URL` | worker, notification-service | RabbitMQ connection string |
| `JWT_SECRET` | server | Secret for signing auth tokens |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | server, worker | Cloudflare R2 credentials |
| `R2_PUBLIC_URL` | server | Public `r2.dev` (or custom) domain for playback URLs |
| `RESEND_API_KEY` | notification-service | Email delivery |
| `EMAIL_FROM` | notification-service | Sender address (verified domain) |
| `FRONTEND_URL` | notification-service | Used to build links in emails |
| `ENABLE_WEBSOCKETS` | server | `true`/`false` — WS vs. polling fallback |

See `.env.example` in each service directory for the complete list.

### Run tests

```bash
docker compose -f docker-compose.test.yml up -d   # isolated test DB + Redis
cd server && npm test
cd ../worker && npm test
```

---

## Project Structure

```
streamforge/
├── server/                 # REST API + WebSocket server + auth
├── worker/                 # BullMQ consumer — FFmpeg transcoding
├── notification-service/   # RabbitMQ consumer — batched email notifications
├── frontend/                # React + Vite SPA
├── render-deploy/           # Production deployment Dockerfile + start.sh
├── docker-compose.yml       # Full local dev stack
├── docker-compose.test.yml  # Isolated test infra
└── docs/
    ├── ARCHITECTURE.md      # Every major design decision + trade-off explained
    ├── TECH_STACK.md        # Every technology: what, why, and how it works internally
    └── WORKFLOW.md          # Full end-to-end request/data flow walkthrough
```

---

## How It Works (Short Version)

1. Client requests a **presigned URL** and uploads the video **directly to R2** — the API server never touches the raw bytes.
2. On upload confirmation, `server` probes the file with `ffprobe`, decides applicable output resolutions, and creates one `TranscodingJob` per rendition — enqueued to BullMQ.
3. `worker` instances pick up jobs, run FFmpeg, stream live progress over Redis pub/sub → WebSocket, upload results back to R2, and update job/video state.
4. Completion/failure events are published to RabbitMQ; `notification-service` batches them into a single summary email per video.
5. The frontend plays back the finished HLS stream with automatic bitrate switching via `hls.js`.

Full step-by-step detail: [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

---

## Known Limitations

Documented deliberately, not hidden — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full context on each:

- WebSocket subscription state is per-process (in-memory) — wouldn't fan out correctly across multiple `server` replicas without adding cross-instance Redis pub/sub.
- Playback URLs are served via R2's public subdomain, not signed — HLS's relative sub-playlist references don't carry a signature.
- Test coverage focuses on auth, the retry endpoint, and progress-calculation logic; `worker`'s full job-processing pipeline and reconnect logic are untested.
- API key endpoints (schema exists) and video deletion are not yet implemented.

---

## License

MIT