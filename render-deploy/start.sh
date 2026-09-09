#!/bin/sh
set -e

echo "Starting RabbitMQ..."
rabbitmq-server -detached

echo "Waiting for RabbitMQ to be ready..."
until rabbitmq-diagnostics -q ping; do
  sleep 2
done
echo "RabbitMQ is ready."

echo "Starting notification-service..."
node /app/notification-service/dist/index.js &

echo "Starting worker..."
node /app/worker/dist/index.js &

echo "Starting server (foreground)..."
node /app/server/dist/index.js