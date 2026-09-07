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

# Set up user with UID 1000 for Hugging Face Spaces compatibility
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

COPY --chown=user package*.json ./
RUN npm install --omit=dev

COPY --chown=user . .
RUN mkdir -p cache/tracks cache/tts

# Hugging Face Spaces routes traffic to port 7860
ENV PORT=7860
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 7860

CMD ["node", "src/index.js"]
