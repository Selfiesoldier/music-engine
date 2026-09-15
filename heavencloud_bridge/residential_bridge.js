import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect yt-dlp binary (local Linux binary, local Windows exe, or system path)
const YTDLP_PATH = fs.existsSync(path.join(__dirname, 'yt-dlp'))
  ? path.join(__dirname, 'yt-dlp')
  : (process.platform === 'win32' && fs.existsSync(path.join(__dirname, 'yt-dlp.exe'))
    ? path.join(__dirname, 'yt-dlp.exe')
    : 'yt-dlp');

// Automatically ensure executable permission on Linux
if (process.platform !== 'win32' && fs.existsSync(path.join(__dirname, 'yt-dlp'))) {
  try {
    fs.chmodSync(path.join(__dirname, 'yt-dlp'), 0o755);
    console.log('✅ Set executable permissions (0755) on ./yt-dlp');
  } catch (e) {
    console.warn('⚠️ Could not chmod ./yt-dlp:', e.message);
  }
}

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const CACHE_DIR = path.join(__dirname, 'bridge_cache');
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || 30191, 10);
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 1;

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Clean up stale temp files on boot
try {
  const stale = fs.readdirSync(CACHE_DIR);
  for (const f of stale) {
    if (f.endsWith('.temp.m4a') || f.endsWith('.part')) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (_) {}
    }
  }
} catch (_) {}

// ==========================================
// 🛡️ MULTI-CLIENT & CONCURRENCY THROTTLE
// ==========================================
let activeDownloads = 0;
let totalStreamsServed = 0;
const downloadQueue = [];
const inFlightStreams = new Map();
const clientStats = new Map();

function getClientIdentifier(req, reqUrl) {
  const queryClient = reqUrl.searchParams.get('client') || reqUrl.searchParams.get('clientId') || reqUrl.searchParams.get('bot');
  const headerClient = req.headers['x-client-id'] || req.headers['x-bot-name'];
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown-ip';
  const cleanIp = String(ip).split(',')[0].trim().replace(/^.*:/, '');

  if (queryClient) return String(queryClient).slice(0, 40);
  if (headerClient) return String(headerClient).slice(0, 40);
  return `server_${cleanIp || 'bot'}`;
}

function trackClientEvent(clientId, eventType) {
  if (!clientStats.has(clientId)) {
    clientStats.set(clientId, {
      clientId,
      requests: 0,
      cacheHits: 0,
      downloads: 0,
      failures: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    });
  }
  const s = clientStats.get(clientId);
  s.lastSeen = Date.now();
  if (eventType === 'request') s.requests++;
  else if (eventType === 'cacheHit') s.cacheHits++;
  else if (eventType === 'download') s.downloads++;
  else if (eventType === 'failure') s.failures++;
}

function acquireDownloadSlot(clientId, targetUrl) {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads++;
    return Promise.resolve({ queued: false, waitTimeMs: 0 });
  }

  const startTime = Date.now();
  const queuePos = downloadQueue.length + 1;
  console.log(`[Bridge Queue] ⏳ Queueing stream for [${clientId}] (Queue Pos: ${queuePos}, Active: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS})`);

  return new Promise((resolve, reject) => {
    downloadQueue.push({
      clientId,
      targetUrl,
      startTime,
      resolve: () => {
        const waitTimeMs = Date.now() - startTime;
        console.log(`[Bridge Queue] 🟢 Dispatching queued stream for [${clientId}] (waited ${waitTimeMs}ms)`);
        resolve({ queued: true, waitTimeMs });
      },
      reject
    });
  });
}

function releaseDownloadSlot() {
  if (downloadQueue.length > 0) {
    const nextItem = downloadQueue.shift();
    nextItem.resolve();
  } else {
    activeDownloads = Math.max(0, activeDownloads - 1);
  }
}

function getCacheKey(targetUrl) {
  return crypto.createHash('md5').update(targetUrl).digest('hex');
}

function pruneBridgeCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    const m4aFiles = [];
    let totalBytes = 0;
    for (const f of files) {
      if (f.endsWith('.m4a') && !f.includes('.temp.')) {
        const full = path.join(CACHE_DIR, f);
        try {
          const st = fs.statSync(full);
          m4aFiles.push({ path: full, size: st.size, mtime: st.mtimeMs });
          totalBytes += st.size;
        } catch (_) {}
      }
    }
    m4aFiles.sort((a, b) => a.mtime - b.mtime);
    while ((m4aFiles.length > 40 || totalBytes > 300 * 1024 * 1024) && m4aFiles.length > 5) {
      const oldest = m4aFiles.shift();
      try {
        fs.unlinkSync(oldest.path);
        totalBytes -= oldest.size;
        console.log(`[Bridge] 🧹 Evicted LRU cached track: ${path.basename(oldest.path)}`);
      } catch (_) {}
    }
  } catch (_) {}
}

async function performBridgeDownload(key, targetUrl) {
  const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);
  if (fs.existsSync(cachedFile)) {
    const stats = fs.statSync(cachedFile);
    if (stats.size > 50000) {
      return { success: true, cachedFile, size: stats.size };
    }
  }

  await acquireDownloadSlot('heavencloud-bridge', targetUrl);

  const tempFile = path.join(CACHE_DIR, `${key}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.temp.m4a`);
  const args = [
    '-f', 'ba[ext=m4a]/ba[ext=webm]/ba',
    '-o', tempFile,
    '--no-playlist',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=visionos,android'
  ];

  if (fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
  }
  args.push(targetUrl);

  return new Promise((resolve) => {
    let ytProcess = null;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      if (!settled && ytProcess) {
        console.error(`[Bridge] ⚠️ Download timed out after 45s for: ${targetUrl}`);
        try { ytProcess.kill('SIGKILL'); } catch (_) {}
      }
    }, 45000);

    try {
      ytProcess = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let errBuffer = '';
      ytProcess.stderr.on('data', (d) => { errBuffer += d.toString(); });

      ytProcess.on('close', (code) => {
        settled = true;
        clearTimeout(timeoutTimer);
        releaseDownloadSlot();

        if (code === 0 && fs.existsSync(tempFile)) {
          const stats = fs.statSync(tempFile);
          if (stats.size > 50000) {
            try {
              if (fs.existsSync(cachedFile)) fs.unlinkSync(cachedFile);
              fs.renameSync(tempFile, cachedFile);
            } catch (_) {
              try { fs.copyFileSync(tempFile, cachedFile); fs.unlinkSync(tempFile); } catch (_) {}
            }
            pruneBridgeCache();
            totalStreamsServed++;
            console.log(`[Bridge] ✅ Track downloaded & cached (${(stats.size / 1024 / 1024).toFixed(2)} MB): ${key}.m4a`);
            return resolve({ success: true, cachedFile, size: stats.size });
          }
        }

        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
        console.error(`[Bridge] ❌ Download failed (code ${code}): ${errBuffer.slice(0, 200)}`);
        return resolve({ success: false, error: errBuffer.slice(-200) || `Process exited with code ${code}` });
      });

      ytProcess.on('error', (err) => {
        settled = true;
        clearTimeout(timeoutTimer);
        releaseDownloadSlot();
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
        return resolve({ success: false, error: err.message });
      });

    } catch (spawnErr) {
      settled = true;
      clearTimeout(timeoutTimer);
      releaseDownloadSlot();
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
      return resolve({ success: false, error: spawnErr.message });
    }
  });
}

const server = http.createServer(async (req, res) => {
  // CORS & Multi-Host headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id, X-Bot-Name');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientId = getClientIdentifier(req, reqUrl);
  trackClientEvent(clientId, 'request');

  if (reqUrl.pathname === '/' || reqUrl.pathname === '/health') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'heavencloud_audio_bridge',
      port: PORT,
      ytdlp: YTDLP_PATH,
      hasCookies: fs.existsSync(COOKIES_PATH),
      concurrency: {
        activeDownloads,
        maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
        queueLength: downloadQueue.length
      },
      stats: {
        totalStreamsServed,
        connectedClientsCount: clientStats.size
      },
      memory: {
        rssMB: (mem.rss / 1024 / 1024).toFixed(1),
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1)
      },
      timestamp: Date.now()
    }, null, 2));
  }

  if (reqUrl.pathname === '/clients') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const clientsList = Array.from(clientStats.values()).map(c => ({
      ...c,
      lastSeenAgoSeconds: Math.round((Date.now() - c.lastSeen) / 1000)
    }));
    return res.end(JSON.stringify({
      totalClients: clientsList.length,
      activeDownloads,
      queueLength: downloadQueue.length,
      clients: clientsList
    }, null, 2));
  }

  // Diagnostic endpoint to check yt-dlp binary execution
  if (reqUrl.pathname === '/test' || reqUrl.pathname === '/diag') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const p = spawn(YTDLP_PATH, ['--version']);
      let stdout = '', stderr = '';
      p.stdout.on('data', d => stdout += d.toString());
      p.stderr.on('data', d => stderr += d.toString());
      p.on('error', err => {
        res.end(JSON.stringify({ success: false, error: err.message, ytdlp: YTDLP_PATH }));
      });
      p.on('close', code => {
        res.end(JSON.stringify({
          success: code === 0,
          code,
          version: stdout.trim(),
          stderr: stderr.trim(),
          ytdlp: YTDLP_PATH
        }));
      });
    } catch (e) {
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (reqUrl.pathname === '/stream') {
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ?url= query parameter' }));
    }

    const key = getCacheKey(targetUrl);
    const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);

    console.log(`[Bridge] 📥 Request from [Client: ${clientId}] for: ${targetUrl}`);

    // 1. Instant Cache Hit (0% CPU, 0s delay)
    if (fs.existsSync(cachedFile)) {
      const stats = fs.statSync(cachedFile);
      if (stats.size > 50000) {
        console.log(`[Bridge] ⚡ Serving cached file for [Client: ${clientId}] (${(stats.size / 1024 / 1024).toFixed(2)} MB)...`);
        trackClientEvent(clientId, 'cacheHit');
        totalStreamsServed++;
        try { fs.utimesSync(cachedFile, new Date(), new Date()); } catch (_) {}

        res.writeHead(200, {
          'Content-Type': 'audio/mp4',
          'Content-Length': stats.size,
          'Cache-Control': 'public, max-age=86400',
          'X-Bridge-Source': 'heavencloud-cache',
          'X-Bridge-Client': clientId
        });
        return fs.createReadStream(cachedFile).pipe(res);
      }
    }

    // 2. In-Flight Coalescing
    let streamPromise;
    if (inFlightStreams.has(key)) {
      console.log(`[Bridge] 👥 Coalescing request for [Client: ${clientId}]: Reusing active in-flight stream for "${targetUrl}"`);
      streamPromise = inFlightStreams.get(key);
    } else {
      streamPromise = performBridgeDownload(key, targetUrl)
        .finally(() => {
          inFlightStreams.delete(key);
        });

      inFlightStreams.set(key, streamPromise);
    }

    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    const result = await streamPromise;

    if (clientDisconnected) {
      console.log(`[Bridge] 🛑 [Client: ${clientId}] disconnected before stream could be delivered.`);
      return;
    }

    if (result.success && result.cachedFile && fs.existsSync(result.cachedFile)) {
      trackClientEvent(clientId, 'download');
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'Content-Length': result.size,
        'Cache-Control': 'public, max-age=86400',
        'X-Bridge-Source': 'heavencloud-direct',
        'X-Bridge-Client': clientId
      });
      return fs.createReadStream(result.cachedFile).pipe(res);
    }

    // Download failed
    trackClientEvent(clientId, 'failure');
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Bridge download failed',
        client: clientId,
        details: result.error || 'Unknown error'
      }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found', availableEndpoints: ['/health', '/clients', '/diag', '/stream?url=...'] }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================================');
  console.log(`🚀 Multi-Client HeavenCloud Audio Bridge running on port ${PORT}`);
  console.log(`🛡️ Max Concurrent Downloads: ${MAX_CONCURRENT_DOWNLOADS} (Low CPU Guarantee)`);
  console.log(`📁 Cache Directory: ${CACHE_DIR}`);
  console.log('📡 Endpoints: /health, /clients, /diag, /stream?url=<target>&client=<name>');
  console.log('======================================================');
});
