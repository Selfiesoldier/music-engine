import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Port configuration (Pterodactyl passes PORT or SERVER_PORT)
const rawPort = process.env.PORT || process.env.SERVER_PORT || 3000;
const PORT = parseInt(String(rawPort).trim(), 10) || 3000;


// Resolve yt-dlp path (cross-platform)
function getYTPath() {
  if (process.platform === 'win32') {
    const localExe = path.join(__dirname, 'yt-dlp.exe');
    if (fs.existsSync(localExe)) return localExe;
  }
  const localLinux = path.join(__dirname, 'yt-dlp');
  if (fs.existsSync(localLinux)) {
    try {
      fs.chmodSync(localLinux, 0o755);
      console.log(`[Worker] 🔒 Granted executable permissions (755) to: ${localLinux}`);
    } catch (e) {
      console.warn(`[Worker] ⚠️ Could not chmod yt-dlp: ${e.message}`);
    }
    return localLinux;
  }
  return 'yt-dlp';
}

const YTDLP_PATH = getYTPath();
try {
  if (fs.existsSync(YTDLP_PATH)) {
    fs.chmodSync(YTDLP_PATH, 0o755);
  }
} catch (_) {}

const CACHE_DIR = path.join(__dirname, 'cache');
const MAX_CACHED_TRACKS = parseInt(process.env.MAX_CACHE_TRACKS, 10) || 100;
const MAX_CACHE_SIZE_BYTES = (parseInt(process.env.MAX_CACHE_MB, 10) || 400) * 1024 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DASHBOARD_HTML_PATH = path.join(__dirname, '..', 'src', 'admin_dashboard.html');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Clean up any stale temp files on boot
try {
  const stale = fs.readdirSync(CACHE_DIR);
  for (const f of stale) {
    if (f.endsWith('.tmp') || f.endsWith('.part') || f.includes('.temp.')) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (_) {}
    }
  }
} catch (_) {}

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

// Intercept console.log for the log buffer
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

// ==========================================
// 🛡️ MULTI-CLIENT & CONCURRENCY THROTTLE
// ==========================================
let MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 1;
let activeDownloads = 0;
let totalDownloadsServed = 0;
const downloadQueue = [];
const inFlightDownloads = new Map(); // key -> Promise<{ success, cachedFile, size, error }>
const clientStats = new Map(); // clientId -> { requests, cacheHits, downloads, failures, firstSeen, lastSeen }

function getClientIdentifier(req, reqUrl) {
  const queryClient = reqUrl.searchParams.get('client') || reqUrl.searchParams.get('clientId') || reqUrl.searchParams.get('bot');
  const headerClient = req.headers['x-client-id'] || req.headers['x-bot-name'] || req.headers['user-agent'];
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown-ip';
  const cleanIp = String(ip).split(',')[0].trim().replace(/^.*:/, '');

  if (queryClient) return String(queryClient).slice(0, 40);
  if (headerClient && !headerClient.includes('node') && !headerClient.includes('Mozilla')) {
    return String(headerClient).slice(0, 40);
  }
  return `server_${cleanIp || 'node'}`;
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
  console.log(`[Worker Queue] ⏳ Queueing download for [${clientId}] (Queue Pos: ${queuePos}, Active: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS})`);

  return new Promise((resolve, reject) => {
    downloadQueue.push({
      clientId,
      targetUrl,
      startTime,
      resolve: () => {
        const waitTimeMs = Date.now() - startTime;
        console.log(`[Worker Queue] 🟢 Dispatching queued download for [${clientId}] (waited ${waitTimeMs}ms)`);
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

function removeQueuedDownload(targetReject) {
  const idx = downloadQueue.findIndex(q => q.reject === targetReject);
  if (idx !== -1) {
    const [removed] = downloadQueue.splice(idx, 1);
    console.log(`[Worker Queue] 🛑 Removed canceled download request for [${removed.clientId}] from queue.`);
  }
}

function getCacheKey(targetUrl) {
  const ytMatch = (targetUrl || '').match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return `yt_${ytMatch[1]}`;
  const normalized = (targetUrl || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
  return `track_${crypto.createHash('md5').update(normalized || 'unknown').digest('hex').slice(0, 16)}`;
}

async function pruneLRUCache() {
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    const trackFiles = [];
    let totalBytes = 0;

    for (const f of files) {
      if (f.endsWith('.m4a') && !f.includes('.temp.')) {
        const full = path.join(CACHE_DIR, f);
        try {
          const st = await fs.promises.stat(full);
          trackFiles.push({ path: full, size: st.size, mtime: st.mtimeMs });
          totalBytes += st.size;
        } catch (_) {}
      }
    }

    trackFiles.sort((a, b) => a.mtime - b.mtime);

    while ((trackFiles.length > MAX_CACHED_TRACKS || totalBytes > MAX_CACHE_SIZE_BYTES) && trackFiles.length > 5) {
      const oldest = trackFiles.shift();
      try {
        await fs.promises.unlink(oldest.path);
        totalBytes -= oldest.size;
        console.log(`🧹 [Worker LRU] Evicted old track: ${path.basename(oldest.path)}`);
      } catch (_) {}
    }
  } catch (err) {
    console.error('LRU prune error:', err.message);
  }
}

// 🎯 SMART CANDIDATE RANKER & SNIPPET SHIELD
// ===========================================
async function resolveBestCandidate(queryUrl, title, artist, expDur) {
  if (!queryUrl.startsWith('scsearch')) return queryUrl;

  const cleanQuery = queryUrl.replace(/^scsearch\d*:/, '').trim();
  const searchArg = `scsearch5:${cleanQuery}`;
  console.log(`[Worker Ranker] 🔍 Fetching top 5 SoundCloud candidates for: "${cleanQuery}"...`);

  return new Promise((resolve) => {
    try {
      try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (_) {}
      const proc = spawn(YTDLP_PATH, [
        '--dump-json',
        '--flat-playlist',
        '--no-warnings',
        '--socket-timeout', '10',
        searchArg
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      let rawOutput = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        resolve(queryUrl);
      }, 10000);

      proc.stdout.on('data', d => rawOutput += d.toString());

      proc.on('close', () => {
        clearTimeout(timer);
        const lines = rawOutput.trim().split('\n').filter(Boolean);
        const items = [];
        for (const l of lines) {
          try {
            const parsed = JSON.parse(l);
            if (parsed.url || parsed.webpage_url) {
              items.push({
                url: parsed.url || parsed.webpage_url,
                title: parsed.title || '',
                duration: Number(parsed.duration) || 0,
                uploader: parsed.uploader || parsed.channel || ''
              });
            }
          } catch (_) {}
        }

        if (items.length === 0) {
          return resolve(queryUrl);
        }

        // Rank the candidates
        const ranked = items.map(item => {
          let score = 0;
          const dur = item.duration || 0;

          // 1. Hard Snippet Shield: Disqualify previews under 75 seconds
          if (dur < 75) return { ...item, score: -9999, reason: 'Snippet' };
          // Disqualify 11+ minute mixes
          if (dur > 660) return { ...item, score: -500, reason: 'Mix' };

          // 2. Duration accuracy match
          if (expDur > 0) {
            const diff = Math.abs(dur - expDur);
            if (diff < 30) score += 60;
            else if (diff < 60) score += 40;
            else if (diff < 120) score += 20;
          } else if (dur >= 120 && dur <= 360) {
            score += 30;
          }

          // 3. Title token matching
          const matchTitle = (title || cleanQuery).toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const itemTitle = (item.title || '').toLowerCase();
          let titleHits = 0;
          matchTitle.forEach(w => { if (itemTitle.includes(w)) titleHits++; });
          score += (titleHits / Math.max(1, matchTitle.length)) * 40;

          // 4. Artist token matching
          if (artist) {
            const matchArtist = artist.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const itemUploader = (item.uploader || '').toLowerCase();
            let artistHits = 0;
            matchArtist.forEach(w => { if (itemTitle.includes(w) || itemUploader.includes(w)) artistHits++; });
            score += (artistHits / Math.max(1, matchArtist.length)) * 25;
          }

          // 5. Penalize low-quality tags
          if (/snippet|preview|teaser|earrape|ear rape|chipmunk/i.test(itemTitle)) score -= 60;

          return { ...item, score };
        }).sort((a, b) => b.score - a.score);

        const winner = ranked[0];
        if (winner && winner.score > -1000 && winner.url) {
          console.log(`[Worker Ranker] 🎯 Picked best candidate: "${winner.title}" (${winner.duration}s, score: ${winner.score})`);
          return resolve(winner.url);
        }

        resolve(items[0].url || queryUrl);
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(queryUrl);
      });
    } catch (_) {
      resolve(queryUrl);
    }
  });
}

// 📦 Core Downloader with In-Flight Coalescing
async function performDownload(key, targetUrl, reqTitle, reqArtist, reqDuration) {
  const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);

  // 1. Double check cache right before downloading
  if (fs.existsSync(cachedFile)) {
    const stats = fs.statSync(cachedFile);
    if (stats.size > 50000) {
      return { success: true, cachedFile, size: stats.size };
    }
  }

  // 2. Resolve Best Full-Length Candidate if needed
  let downloadTarget = targetUrl;
  if (targetUrl.startsWith('scsearch')) {
    downloadTarget = await resolveBestCandidate(targetUrl, reqTitle, reqArtist, reqDuration);
  }

  // 3. Acquire slot from concurrency queue
  await acquireDownloadSlot('downloader', targetUrl);

  const tempFile = path.join(CACHE_DIR, `${key}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.temp.m4a`);
  const ytdlpArgs = [
    '--force-ipv4',
    '--no-cache-dir',
    '--socket-timeout', '12',
    '--retries', '2',
    '--concurrent-fragments', '1',
    '--no-video',
    '--no-playlist',
    '--no-warnings',
    '--format', 'bestaudio/ba/b/best',
    '-o', tempFile,
    downloadTarget
  ];

  return new Promise((resolve) => {
    let proc = null;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      if (!settled && proc) {
        console.error(`[Worker] ⚠️ Download timed out after 45s for: ${targetUrl}`);
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
    }, 45000);

    try {
      try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (_) {}
      proc = spawn(YTDLP_PATH, ytdlpArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let errOutput = '';
      proc.stderr.on('data', d => { errOutput += d.toString(); });

      proc.on('close', async (code) => {
        settled = true;
        clearTimeout(timeoutTimer);
        releaseDownloadSlot();

        if (code === 0 && fs.existsSync(tempFile)) {
          const stats = fs.statSync(tempFile);
          if (stats.size > 50000) {
            try {
              await fs.promises.rename(tempFile, cachedFile);
            } catch (_) {
              try { await fs.promises.copyFile(tempFile, cachedFile); fs.unlinkSync(tempFile); } catch (_) {}
            }

            console.log(`[Worker] ✅ Track downloaded & cached (${(stats.size / 1024 / 1024).toFixed(2)} MB): ${key}.m4a`);
            totalDownloadsServed++;
            pruneLRUCache();
            return resolve({ success: true, cachedFile, size: stats.size });
          }
        }

        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
        console.error(`[Worker] ❌ Download failed for "${targetUrl}" (code ${code}): ${errOutput.slice(-200)}`);
        return resolve({ success: false, error: errOutput.slice(-200) || `Process exited with code ${code}` });
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

  // Multi-Client Health Check
  if (reqUrl.pathname === '/health') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'download_worker',
      uptimeSeconds: Math.floor(process.uptime()),
      concurrency: {
        activeDownloads,
        maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
        queueLength: downloadQueue.length
      },
      stats: {
        totalDownloadsServed,
        connectedClientsCount: clientStats.size
      },
      memory: {
        rssMB: (mem.rss / 1024 / 1024).toFixed(1),
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1)
      }
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

  // Fast Ping
  if (reqUrl.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('pong');
  }

  // Stream endpoint: GET /stream?url=<targetUrl>&client=<id>&title=...&artist=...&duration=...
  if (reqUrl.pathname === '/stream') {
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
    }

    const key = getCacheKey(targetUrl);
    const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);

    console.log(`[Worker] 📥 Incoming request from [Client: ${clientId}] for: "${targetUrl}"`);

    // 1. Instant Cache Hit (0% CPU, 0s delay)
    if (fs.existsSync(cachedFile)) {
      try {
        const stats = fs.statSync(cachedFile);
        if (stats.size > 50000) {
          console.log(`[Worker] ⚡ Cache HIT for [Client: ${clientId}] (${(stats.size / 1024 / 1024).toFixed(2)} MB): ${key}.m4a`);
          trackClientEvent(clientId, 'cacheHit');
          totalDownloadsServed++;
          try { fs.utimesSync(cachedFile, new Date(), new Date()); } catch (_) {}

          res.writeHead(200, {
            'Content-Type': 'audio/mp4',
            'Content-Length': stats.size,
            'Cache-Control': 'public, max-age=86400',
            'X-Worker-Cache': 'HIT',
            'X-Worker-Client': clientId
          });
          return fs.createReadStream(cachedFile).pipe(res);
        }
      } catch (_) {}
    }

    // 2. In-Flight Coalescing (If another client server is already downloading this song)
    let downloadPromise;
    if (inFlightDownloads.has(key)) {
      console.log(`[Worker] 👥 Coalescing request for [Client: ${clientId}]: Reusing active in-flight download for "${targetUrl}"`);
      downloadPromise = inFlightDownloads.get(key);
    } else {
      const reqTitle = reqUrl.searchParams.get('title') || '';
      const reqArtist = reqUrl.searchParams.get('artist') || '';
      const reqDuration = parseInt(reqUrl.searchParams.get('duration') || '0', 10);

      downloadPromise = performDownload(key, targetUrl, reqTitle, reqArtist, reqDuration)
        .finally(() => {
          inFlightDownloads.delete(key);
        });

      inFlightDownloads.set(key, downloadPromise);
    }

    // Abort handling if client disconnects while waiting
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    const result = await downloadPromise;

    if (clientDisconnected) {
      console.log(`[Worker] 🛑 [Client: ${clientId}] disconnected before stream could be delivered.`);
      return;
    }

    if (result.success && result.cachedFile && fs.existsSync(result.cachedFile)) {
      trackClientEvent(clientId, 'download');
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'Content-Length': result.size,
        'Cache-Control': 'public, max-age=86400',
        'X-Worker-Cache': 'MISS',
        'X-Worker-Client': clientId
      });
      return fs.createReadStream(result.cachedFile).pipe(res);
    }

    // Download failed
    trackClientEvent(clientId, 'failure');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Download failed on worker',
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
          fileList.push({
            name: f,
            sizeMB: (st.size / 1024 / 1024).toFixed(2),
            ageMin: Math.round((now - st.mtimeMs) / 60000)
          });
        } catch (_) {}
      }
      fileList.sort((a, b) => a.ageMin - b.ageMin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        totalFiles: fileList.length,
        totalMB: (totalBytes / 1024 / 1024).toFixed(1),
        maxMB: MAX_CACHE_SIZE_BYTES / 1024 / 1024,
        files: fileList.slice(0, 100)
      }, null, 2));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Admin: Update Config (requires auth) ──────────────────────────
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

  // ── Admin: Clear Cache (requires auth) ────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/clear-cache') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    try {
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.m4a') && !f.includes('.temp.'));
      let freed = 0, count = 0;
      for (const f of files) {
        const fp = path.join(CACHE_DIR, f);
        try { const st = fs.statSync(fp); freed += st.size; fs.unlinkSync(fp); count++; } catch (_) {}
      }
      console.log(`🗑️ [Admin] Cache cleared: ${count} files, ${(freed / 1024 / 1024).toFixed(1)} MB freed`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, deletedCount: count, freedMB: (freed / 1024 / 1024).toFixed(1) }));
    } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Admin: Drain Queue (requires auth) ────────────────────────────
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

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Not found',
    availableEndpoints: ['/dashboard', '/health', '/clients', '/logs', '/cache-files', '/ping', '/stream?url=...']
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================================');
  console.log(`🚀 Multi-Client Dedicated Audio Download Worker running on port ${PORT}`);
  console.log(`📍 yt-dlp executable: ${YTDLP_PATH}`);
  console.log(`🛡️ Max Concurrent Downloads: ${MAX_CONCURRENT_DOWNLOADS} (Guaranteed Low CPU)`);
  console.log(`📁 Cache Directory: ${CACHE_DIR} (Max ${MAX_CACHED_TRACKS} tracks / ${MAX_CACHE_SIZE_BYTES / 1024 / 1024} MB)`);
  console.log(`🎛️ Admin Dashboard: http://0.0.0.0:${PORT}/dashboard`);
  console.log('📡 Endpoints: /dashboard, /health, /clients, /logs, /cache-files, /ping, /stream');
  console.log('======================================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  server.close(() => process.exit(0));
});
