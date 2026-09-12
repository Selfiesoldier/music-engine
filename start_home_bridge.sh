#!/usr/bin/env bash
echo "========================================================"
echo "  Highrise Musicbot - Home Residential Audio Bridge"
echo "  (Termux / PRoot Linux / Android / Raspberry Pi)"
echo "========================================================"

# In Termux, auto-install missing prerequisites
if command -v pkg &> /dev/null; then
    if ! command -v node &> /dev/null; then
        echo "📦 Installing Node.js..."
        pkg install -y nodejs
    fi
    if ! command -v yt-dlp &> /dev/null; then
        echo "📦 Installing yt-dlp and Python..."
        pkg install -y yt-dlp python
    fi
    # Ensure Termux has working DNS servers for Go binaries like cloudflared
    if [ -n "$PREFIX" ]; then
        mkdir -p "$PREFIX/etc"
        DNS1=$(getprop net.dns1 2>/dev/null)
        if [ -n "$DNS1" ]; then
            echo "nameserver $DNS1" > "$PREFIX/etc/resolv.conf"
        fi
        echo "nameserver 1.1.1.1" >> "$PREFIX/etc/resolv.conf"
        echo "nameserver 8.8.8.8" >> "$PREFIX/etc/resolv.conf"
    fi
    if ! command -v cloudflared &> /dev/null; then
        echo "📦 Installing native Termux cloudflared..."
        pkg install -y cloudflared
    fi
    # Remove any generic Linux binary that might conflict
    rm -f ./cloudflared
    if command -v yt-dlp &> /dev/null; then
        rm -f ./yt-dlp
    fi
fi

# Check node
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Run: pkg install nodejs -y"
    exit 1
fi

# Check yt-dlp (fallback if not in pkg)
if ! command -v yt-dlp &> /dev/null && [ ! -f "./yt-dlp" ]; then
    echo "⚠️ yt-dlp not found in PATH. Installing via curl..."
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp
    chmod +x yt-dlp
fi

# For standard Linux (non-Termux)
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
