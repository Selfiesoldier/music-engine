#!/bin/bash
# ==============================================================================
# Highrise Music Engine v3.0 — Host Launch Script
# Memory-safe execution with bgutil Botguard POT Provider
# ==============================================================================
set -e

# 1. Start local Botguard PO Token server on 127.0.0.1:4416 in background
# Strictly bound to loopback (127.0.0.1) so Render's external router does not capture port 4416
if [ -f "/app/pot-provider/build/main.js" ]; then
  echo "🛡️ [POT Provider] Starting local Botguard PO Token server on port 4416..."
  PORT=4416 NODE_OPTIONS="--max-old-space-size=64" node /app/pot-provider/build/main.js --port 4416 &
  POT_PID=$!
  echo "🛡️ [POT Provider] PID: $POT_PID running in background on port 4416"
else
  echo "⚠️ [POT Provider] Build not found at /app/pot-provider/build/main.js — skipping"
fi

# 2. Enforce memory constraints for 512 MB cloud hosts (Render)
export NODE_OPTIONS="--max-old-space-size=160 --expose-gc"

echo "🚀 Starting Highrise Music Engine with memory limit: 160 MB..."
exec node src/index.js
