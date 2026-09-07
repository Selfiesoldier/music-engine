FROM node:20-bookworm-slim

# Install system dependencies: FFmpeg, Python3, curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Set up non-root user for cloud hosting compatibility
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

COPY --chown=user package*.json ./
RUN npm install --omit=dev

COPY --chown=user . .
RUN mkdir -p cache/tracks cache/tts

# Default host and environment
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Support Render (10000), HuggingFace (7860), and default (30060)
EXPOSE 10000
EXPOSE 7860
EXPOSE 30060

CMD ["node", "src/index.js"]
