#!/bin/bash
# ==============================================================================
# Highrise Music Engine v3.0 — Host Launch Script
# Memory-safe execution with bgutil Botguard POT Provider
# ==============================================================================
set -e

# 1. Start local Botguard PO Token server on port 4416 (for yt-dlp)
if [ -f "/app/pot-provider/build/main.js" ]; then
  echo "🛡️ [POT Provider] Starting local Botguard PO Token server on port 4416..."
  NODE_OPTIONS="--max-old-space-size=64" node /app/pot-provider/build/main.js &
  POT_PID=$!
  echo "🛡️ [POT Provider] PID: $POT_PID — waiting for it to become ready..."
  # Wait up to 25 seconds for the POT provider to be ready
  for i in $(seq 1 25); do
    sleep 1
    if curl -sf http://127.0.0.1:4416/ > /dev/null 2>&1; then
      echo "✅ [POT Provider] Ready on port 4416 (after ${i}s)"
      break
    fi
    if [ "$i" = "25" ]; then
      echo "⚠️ [POT Provider] Not responding after 25s — continuing anyway..."
    fi
  done
else
  echo "⚠️ [POT Provider] Build not found at /app/pot-provider/build/main.js — skipping"
fi

# 2. Enforce memory constraints for 512 MB cloud hosts (Render)
export NODE_OPTIONS="--max-old-space-size=160 --expose-gc"

echo "🚀 Starting Highrise Music Engine with memory limit: 160 MB..."
exec node src/index.js
