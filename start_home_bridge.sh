#!/usr/bin/env bash
echo "========================================================"
echo "  Highrise Musicbot - Home Residential Audio Bridge"
echo "  (Termux / PRoot Linux / Android / Raspberry Pi)"
echo "========================================================"

# Check node
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Run: apt update && apt install nodejs"
    exit 1
fi

# Check yt-dlp
if ! command -v yt-dlp &> /dev/null && [ ! -f "./yt-dlp" ]; then
    echo "⚠️ yt-dlp not found in PATH. Installing via pip/curl..."
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp
    chmod +x yt-dlp
fi

# Check cloudflared
if ! command -v cloudflared &> /dev/null && [ ! -f "./cloudflared" ]; then
    echo "⚠️ cloudflared not found. Downloading ARM64 binary..."
    ARCH=$(uname -m)
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
    elif [ "$ARCH" = "x86_64" ]; then
        curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
    elif [ "$ARCH" = "armv7l" ]; then
        curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm -o cloudflared
    fi
    chmod +x cloudflared
fi

echo "🚀 Starting bridge manager..."
node home_bridge_manager.js
