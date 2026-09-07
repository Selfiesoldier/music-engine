#!/bin/bash
# ==============================================================================
# Highrise Music Engine v3.0 — Host Launch Script
# Memory-safe execution with bgutil Botguard POT Provider
# ==============================================================================
set -e

# 1. Start local Botguard PO Token server on port 4416 (for yt-dlp)
if [ -f "/app/pot-provider/build/main.js" ]; then
  echo "🛡️ [POT Provider] Starting local Botguard PO Token server on port 4416..."
  node /app/pot-provider/build/main.js &
  sleep 1
fi

# 2. Enforce memory constraints for 512 MB cloud hosts (Render)
export NODE_OPTIONS="--max-old-space-size=192 --expose-gc"

echo "🚀 Starting Highrise Music Engine with memory limit: 192 MB..."
exec node src/index.js
