#!/bin/sh

headscale serve &
PID=$!

echo "Waiting for Headscale to start..."
sleep 3

echo "Ensuring user 'edge-devices' exists..."
headscale users create edge-devices 2>/dev/null || true

headscale preauthkeys create --user edge-devices --reusable --expiration 90d > /etc/headscale/latest_auth_key.txt 2>/dev/null || true

wait "$PID"
