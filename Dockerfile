FROM denoland/deno:bin AS deno_bin
FROM brainicism/bgutil-ytdlp-pot-provider:latest AS pot_provider
FROM node:20-bookworm-slim

# Copy official Deno binary (the only JS runtime natively supported by yt-dlp for EJS challenge solving)
COPY --from=deno_bin /deno /usr/local/bin/deno

# Copy prebuilt bgutil PO Token provider for Botguard challenges
COPY --from=pot_provider /app /app/pot-provider

# Install system dependencies: FFmpeg, Python3, python3-pip, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && pip3 install --break-system-packages --no-cache-dir -U curl_cffi bgutil-ytdlp-pot-provider \
    && mkdir -p /usr/local/share/yt-dlp/plugins \
    && ln -s $(python3 -c "import site; print(site.getsitepackages()[0])")/yt_dlp_plugins /usr/local/share/yt-dlp/plugins/bgutil-ytdlp-pot-provider

WORKDIR /app

# Copy package descriptors & install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code and assets
COPY . .

# Install yt-dlp.conf system-wide so yt-dlp auto-reads POT provider & player client config
RUN cp yt-dlp.conf /etc/yt-dlp.conf

RUN mkdir -p cache/tracks cache/tts && chmod +x start.sh

# Enforce Node memory boundary (160 MB) for 512 MB cloud hosts
ENV PORT=10000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Render Web Service primary port
EXPOSE 10000

CMD ["./start.sh"]
