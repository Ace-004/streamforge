#!/bin/sh
set -e

echo "Running Prisma migrations..."

cd /app/server

npx prisma migrate deploy

echo "Prisma migrations completed."

echo "Starting notification-service..."

node /app/notification-service/dist/index.js &

echo "Starting worker..."

node /app/worker/dist/index.js &

echo "Starting server (foreground)..."

node /app/server/dist/index.js