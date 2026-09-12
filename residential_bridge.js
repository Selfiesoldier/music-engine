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
  // On Termux / Linux, check system PATH first (e.g. native pkg install yt-dlp)
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

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
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
    // Keep max 25 tracks or 150 MB on Termux
    while ((m4aFiles.length > 25 || totalBytes > 150 * 1024 * 1024) && m4aFiles.length > 5) {
      const oldest = m4aFiles.shift();
      try {
        fs.unlinkSync(oldest.path);
        totalBytes -= oldest.size;
        console.log(`[Bridge] 🧹 Evicted LRU cached track from Termux: ${path.basename(oldest.path)}`);
      } catch (_) {}
    }
  } catch (_) {}
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  
  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'residential_bridge', timestamp: Date.now() }));
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

  if (reqUrl.pathname === '/stream') {
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ?url= query parameter' }));
    }

    const key = getCacheKey(targetUrl);
    const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);

    console.log(`[Bridge] 📥 Request for: ${targetUrl}`);

    // If cached and valid, stream immediately
    if (fs.existsSync(cachedFile)) {
      const stats = fs.statSync(cachedFile);
      if (stats.size > 50000) {
        console.log(`[Bridge] ⚡ Serving cached file (${(stats.size / 1024 / 1024).toFixed(2)} MB)...`);
        res.writeHead(200, {
          'Content-Type': 'audio/mp4',
          'Content-Length': stats.size,
          'Cache-Control': 'public, max-age=86400',
          'X-Bridge-Source': 'residential-cache'
        });
        return fs.createReadStream(cachedFile).pipe(res);
      }
    }

    // Download audio directly via residential IP (NO COOKIES to eliminate timeout races & reload errors)
    const tempFile = path.join(CACHE_DIR, `${key}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.temp.m4a`);

    const currentArgs = [
      '-f', 'ba[ext=m4a]/ba[ext=webm]/bestaudio/ba/b/best',
      '-o', tempFile,
      '--no-video',
      '--no-playlist',
      '--no-warnings',
      '--force-ipv4',
      '--extractor-args', 'youtube:player_client=android,web,tv,visionos',
      targetUrl
    ];

    console.log(`[Bridge] 🚀 Downloading original track via residential IP (clean direct mode, no cookies)...`);

    const ytProcess = spawn(YTDLP_PATH, currentArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errBuffer = '';
    ytProcess.stderr.on('data', (d) => { errBuffer += d.toString(); });

    ytProcess.on('close', (code, signal) => {
      if (code !== 0 || !fs.existsSync(tempFile)) {
        console.error(`[Bridge] ❌ Download failed (code ${code}, signal ${signal}): ${errBuffer.slice(0, 200)}`);
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Download failed', code, signal, details: errBuffer.slice(-300) }));
        }
        return;
      }

      // Rename temp file to cached file
      try {
        fs.renameSync(tempFile, cachedFile);
      } catch (_) {}

      const fileToStream = fs.existsSync(cachedFile) ? cachedFile : tempFile;
      const stats = fs.statSync(fileToStream);

      pruneBridgeCache();

      console.log(`[Bridge] ✅ Completed download (${(stats.size / 1024 / 1024).toFixed(2)} MB). Streaming to bot server...`);
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'audio/mp4',
          'Content-Length': stats.size,
          'Cache-Control': 'public, max-age=86400',
          'X-Bridge-Source': 'residential-direct'
        });
        fs.createReadStream(fileToStream).pipe(res);
      }
    });

    req.on('close', () => {
      if (!ytProcess.killed) {
        try { ytProcess.kill('SIGKILL'); } catch (_) {}
      }
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(8888, '0.0.0.0', () => {
  console.log('🚀 Residential Audio Bridge running on http://127.0.0.1:8888');
});
