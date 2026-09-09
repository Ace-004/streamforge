# ============================================================
# Base
# Node.js + Alpine
# RabbitMQ is hosted externally on CloudAMQP.
# ============================================================

FROM node:20-alpine AS base

RUN apk add --no-cache ffmpeg

WORKDIR /app


# ============================================================
# Build server
# ============================================================

FROM base AS build-server

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./

RUN npm ci

COPY server/ ./

# Only needed during build for prisma generate.
# Runtime DATABASE_URL is supplied by Render.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

RUN npx prisma generate

RUN npm run build


# ============================================================
# Build worker
# ============================================================

FROM base AS build-worker

WORKDIR /app/worker

COPY worker/package.json worker/package-lock.json ./

RUN npm ci

COPY worker/ ./

ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

RUN npx prisma generate

RUN npm run build


# ============================================================
# Build notification-service
# ============================================================

FROM base AS build-notification

WORKDIR /app/notification-service

COPY notification-service/package.json notification-service/package-lock.json ./

RUN npm ci

COPY notification-service/ ./

ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

RUN npx prisma generate

RUN npm run build


# ============================================================
# Production
# ============================================================

FROM base AS production

ENV NODE_ENV=production


# ------------------------------------------------------------
# Server
# ------------------------------------------------------------

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./

RUN npm ci --omit=dev

COPY --from=build-server /app/server/dist ./dist
COPY --from=build-server /app/server/src/generated ./src/generated

COPY server/prisma ./prisma
COPY server/prisma.config.ts ./


# ------------------------------------------------------------
# Worker
# ------------------------------------------------------------

WORKDIR /app/worker

COPY worker/package.json worker/package-lock.json ./

RUN npm ci --omit=dev

COPY --from=build-worker /app/worker/dist ./dist
COPY --from=build-worker /app/worker/src/generated ./src/generated

COPY worker/prisma ./prisma
COPY worker/prisma.config.ts ./


# ------------------------------------------------------------
# Notification service
# ------------------------------------------------------------

WORKDIR /app/notification-service

COPY notification-service/package.json notification-service/package-lock.json ./

RUN npm ci --omit=dev

COPY --from=build-notification /app/notification-service/dist ./dist
COPY --from=build-notification /app/notification-service/src/generated ./src/generated

COPY notification-service/prisma ./prisma
COPY notification-service/prisma.config.ts ./


# ============================================================
# Startup
# ============================================================

WORKDIR /app

COPY render-deploy/start.sh ./start.sh

RUN chmod +x ./start.sh

EXPOSE 4000

CMD ["./start.sh"]