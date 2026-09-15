import http from 'http';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveYtDlp() {
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(__dirname, 'yt-dlp.exe')) ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp.exe';
  }
  // On Termux / Linux, check system PATH first
  try {
    execSync('which yt-dlp', { stdio: 'ignore' });
    return 'yt-dlp';
  } catch (_) {}
  if (fs.existsSync(path.join(__dirname, 'yt-dlp'))) {
    return path.join(__dirname, 'yt-dlp');
  }
  return 'yt-dlp';
}

const YTDLP_PATH = resolveYtDlp();
const CACHE_DIR = path.join(__dirname, 'bridge_cache');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DASHBOARD_HTML_PATH = path.join(__dirname, '../src', 'admin_dashboard.html');
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || 8888, 10);
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
const inFlightStreams = new Map(); // key -> Promise<{ success, cachedFile, size, error }>
const clientStats = new Map(); // clientId -> { requests, cacheHits, downloads, failures, lastSeen }

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

function acquireDownloadSlot(clientId, cleanUrl) {
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
      cleanUrl,
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

function cleanYouTubeUrl(url) {
  const ytMatch = (url || '').match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) {
    return `https://www.youtube.com/watch?v=${ytMatch[1]}`;
  }
  return url;
}

function getCacheKey(targetUrl) {
  const ytMatch = (targetUrl || '').match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return `yt_${ytMatch[1]}`;
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
    // Keep max 35 tracks or 250 MB on Termux/home machine
    while ((m4aFiles.length > 35 || totalBytes > 250 * 1024 * 1024) && m4aFiles.length > 5) {
      const oldest = m4aFiles.shift();
      try {
        fs.unlinkSync(oldest.path);
        totalBytes -= oldest.size;
        console.log(`[Bridge] 🧹 Evicted LRU cached track: ${path.basename(oldest.path)}`);
      } catch (_) {}
    }
  } catch (_) {}
}

async function performBridgeDownload(key, cleanUrl) {
  const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);
  if (fs.existsSync(cachedFile)) {
    const stats = fs.statSync(cachedFile);
    if (stats.size > 50000) {
      return { success: true, cachedFile, size: stats.size };
    }
  }

  await acquireDownloadSlot('bridge', cleanUrl);

  const tempFile = path.join(CACHE_DIR, `${key}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.temp.m4a`);
  const currentArgs = [
    '-f', 'ba[ext=m4a]/ba/ba*/bestaudio/140/251/18/b/best',
    '--no-video',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--force-ipv4',
    '--extractor-args', 'youtube:player_client=android,web,tv',
    '-o', tempFile,
    cleanUrl
  ];

  return new Promise((resolve) => {
    let proc = null;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      if (!settled && proc) {
        console.error(`[Bridge] ⚠️ Download timed out after 45s for: ${cleanUrl}`);
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
    }, 45000);

    try {
      proc = spawn(YTDLP_PATH, currentArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let errBuffer = '';
      proc.stderr.on('data', (d) => { errBuffer += d.toString(); });

      proc.on('close', (code) => {
        settled = true;
        clearTimeout(timeoutTimer);
        releaseDownloadSlot();

        if (code === 0 && fs.existsSync(tempFile)) {
          const stats = fs.statSync(tempFile);
          if (stats.size > 50000) {
            try {
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
        console.error(`[Bridge] ❌ Download failed for "${cleanUrl}" (code ${code}): ${errBuffer.slice(-200)}`);
        return resolve({ success: false, error: errBuffer.slice(-200) || `Process exited with code ${code}` });
      });

      proc.on('error', (err) => {
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


// ==========================================
// 📋 CIRCULAR LOG BUFFER (last 200 events)
// ==========================================
const LOG_BUFFER = [];
const LOG_MAX = 200;

function classifyLog(msg) {
  if (/✅|success|cached|served|HIT/i.test(msg)) return 'success';
  if (/❌|error|fail|FAIL/i.test(msg)) return 'error';
  if (/⏳|queued|queue|waiting/i.test(msg)) return 'warn';
  if (/⚡|cache HIT|instant/i.test(msg)) return 'cache';
  if (/📥|incoming|request|client/i.test(msg)) return 'info';
  return 'default';
}

function addLog(msg) {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  LOG_BUFFER.push({ time, msg: String(msg), type: classifyLog(msg) });
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
}

const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);
console.log = (...args) => { const m = args.join(' '); addLog(m); _origLog(m); };
console.error = (...args) => { const m = args.join(' '); addLog(m); _origErr(m); };
console.warn = (...args) => { const m = args.join(' '); addLog(m); _origWarn(m); };

function checkAdminAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token === ADMIN_PASSWORD;
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

  // Health check with multi-client & concurrency stats
  if (reqUrl.pathname === '/health' || reqUrl.pathname === '/') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'residential_bridge',
      uptimeSeconds: Math.floor(process.uptime()),
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

  // Detailed Connected Clients Report
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

  if (reqUrl.pathname === '/diag') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    let ytdlpVer = 'unknown';
    try {
      ytdlpVer = execSync(`${YTDLP_PATH} --version`, { timeout: 4000 }).toString().trim();
    } catch (err) {
      ytdlpVer = `FAIL: ${err.message}`;
    }
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'residential_bridge',
      ytdlpPath: YTDLP_PATH,
      ytdlpVersion: ytdlpVer,
      platform: process.platform,
      arch: process.arch,
      timestamp: Date.now()
    }));
  }

  // Stream endpoint: GET /stream?url=<targetUrl>&client=<id>
  if (reqUrl.pathname === '/stream') {
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ?url= query parameter' }));
    }

    const cleanUrl = cleanYouTubeUrl(targetUrl);
    const key = getCacheKey(cleanUrl);
    const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);

    console.log(`[Bridge] 📥 Request from [Client: ${clientId}] for: ${cleanUrl}`);

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
          'X-Bridge-Source': 'residential-cache',
          'X-Bridge-Client': clientId
        });
        return fs.createReadStream(cachedFile).pipe(res);
      }
    }

    // 2. In-Flight Coalescing (If another client server is already fetching this track)
    let streamPromise;
    if (inFlightStreams.has(key)) {
      console.log(`[Bridge] 👥 Coalescing request for [Client: ${clientId}]: Reusing active in-flight stream for "${cleanUrl}"`);
      streamPromise = inFlightStreams.get(key);
    } else {
      streamPromise = performBridgeDownload(key, cleanUrl)
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
        'X-Bridge-Source': 'residential-download',
        'X-Bridge-Client': clientId
      });
      return fs.createReadStream(result.cachedFile).pipe(res);
    }

    // Stream failed
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

  
  // ── Admin Dashboard ────────────────────────────────────────────────
  if (reqUrl.pathname === '/dashboard') {
    try {
      let html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
      html = html.replace('ADMIN_PASSWORD_PLACEHOLDER', ADMIN_PASSWORD);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Dashboard HTML not found: ' + e.message);
    }
  }

  // ── Live Logs ──────────────────────────────────────────────────────
  if (reqUrl.pathname === '/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ entries: LOG_BUFFER.slice().reverse() }, null, 2));
  }

  // ── Cache File List ────────────────────────────────────────────────
  if (reqUrl.pathname === '/cache-files') {
    try {
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.m4a') && !f.includes('.temp.'));
      let totalBytes = 0;
      const fileList = [];
      const now = Date.now();
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(CACHE_DIR, f));
          totalBytes += st.size;
          fileList.push({ name: f, sizeMB: (st.size / 1024 / 1024).toFixed(2), ageMin: Math.round((now - st.mtimeMs) / 60000) });
        } catch (_) {}
      }
      fileList.sort((a, b) => a.ageMin - b.ageMin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ totalFiles: fileList.length, totalMB: (totalBytes / 1024 / 1024).toFixed(1), maxMB: 300, files: fileList.slice(0, 100) }, null, 2));
    } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Admin: Update Config ──────────────────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/config') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (cfg.maxConcurrent) {
          MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(10, parseInt(cfg.maxConcurrent)));
          console.log(`⚙️ [Admin] Max concurrent updated to ${MAX_CONCURRENT_DOWNLOADS}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, maxConcurrent: MAX_CONCURRENT_DOWNLOADS }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── Admin: Clear Cache ────────────────────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/clear-cache') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    try {
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.m4a') && !f.includes('.temp.'));
      let freed = 0, count = 0;
      for (const f of files) {
        const fp = path.join(CACHE_DIR, f);
        try { const st = fs.statSync(fp); freed += st.size; fs.unlinkSync(fp); count++; } catch (_) {}
      }
      console.log(`🗑️ [Admin] Cache cleared: ${count} files, ${(freed/1024/1024).toFixed(1)} MB freed`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, deletedCount: count, freedMB: (freed/1024/1024).toFixed(1) }));
    } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Admin: Drain Queue ────────────────────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/drain-queue') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    const drained = downloadQueue.length;
    while (downloadQueue.length > 0) {
      const item = downloadQueue.shift();
      try { item.reject(new Error('Queue drained by admin')); } catch (_) {}
    }
    console.log(`⚡ [Admin] Queue drained: ${drained} requests rejected`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, drained }));
  }

  // ── Admin: Force GC ───────────────────────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/gc') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    try { if (typeof global.gc === 'function') global.gc(); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, message: 'GC hint sent' }));
  }

res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found', availableEndpoints: ['/dashboard', '/health', '/clients', '/logs', '/cache-files', '/diag', '/stream?url=...'] }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================================');
  console.log(`🚀 Multi-Client Residential Audio Bridge running on port ${PORT}`);
  console.log(`🛡️ Max Concurrent Downloads: ${MAX_CONCURRENT_DOWNLOADS} (Low CPU Guarantee)`);
  console.log(`📁 Cache Directory: ${CACHE_DIR}`);
  console.log('📡 Endpoints: /health, /clients, /diag, /stream?url=<target>&client=<name>');
  console.log('======================================================');
});
