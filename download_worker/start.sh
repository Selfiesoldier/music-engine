#!/bin/bash
echo "=================================================="
echo "🚀 Dedicated Highrise Music Download Worker"
echo "=================================================="

export MALLOC_ARENA_MAX=2
export MALLOC_TRIM_THRESHOLD_=65536
export PORT="${PORT:-${SERVER_PORT:-3000}}"
export NODE_OPTIONS="--max-old-space-size=128"

mkdir -p cache
chmod +x yt-dlp 2>/dev/null || true

# Self-healing watchdog loop for 24/7 uptime on Orihost
while true; do
  echo "⚡ [Worker Watchdog] Starting Audio Download Worker on port ${PORT}..."
  node worker.js || true
  echo "⚠️ [Worker Watchdog] Process exited. Auto-restarting in 2s..."
  sleep 2
done
