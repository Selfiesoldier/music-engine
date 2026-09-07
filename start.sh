#!/bin/bash
# ==============================================================================
# Highrise Music Engine v3.0 — Host Launch Script
# Memory-safe execution for 512 MB containers
# ==============================================================================
set -e

export NODE_OPTIONS="--max-old-space-size=192 --expose-gc"

echo "🚀 Starting Highrise Music Engine with memory limit: 192 MB..."
exec node src/index.js
