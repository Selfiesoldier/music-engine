FROM node:20-bookworm-slim

# Install system dependencies: FFmpeg, Python3, python3-pip, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir -U yt-dlp

WORKDIR /app

# Copy package descriptors & install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code and assets
COPY . .
RUN mkdir -p cache/tracks cache/tts

# Enforce Node memory boundary (160 MB) for 512 MB cloud hosts
ENV NODE_OPTIONS="--max-old-space-size=160 --expose-gc"
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Support Render (10000), HuggingFace (7860), and local/VPS (30060)
EXPOSE 10000
EXPOSE 7860
EXPOSE 30060

CMD ["node", "src/index.js"]
