import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const YTDLP_PATH = process.platform === 'win32' 
  ? path.join(__dirname, 'yt-dlp.exe') 
  : (fs.existsSync(path.join(__dirname, 'yt-dlp')) ? path.join(__dirname, 'yt-dlp') : 'yt-dlp');
const CACHE_DIR = path.join(__dirname, 'bridge_cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCacheKey(targetUrl) {
  return crypto.createHash('md5').update(targetUrl).digest('hex');
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  
  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'residential_bridge', timestamp: Date.now() }));
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

    // Download complete audio file using residential IP
    const tempFile = path.join(CACHE_DIR, `${key}.temp.m4a`);
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}

    const cookieFile = fs.existsSync(path.join(__dirname, 'cookies.txt'))
      ? path.join(__dirname, 'cookies.txt')
      : (fs.existsSync(path.join(__dirname, 'cookies.master.txt')) ? path.join(__dirname, 'cookies.master.txt') : null);

    const args = [
      '-f', 'ba[ext=m4a]/ba[ext=webm]/ba/b/best',
      '-o', tempFile,
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=android,web,tv,visionos',
      ...(cookieFile ? ['--cookies', cookieFile] : []),
      targetUrl
    ];

    console.log(`[Bridge] 🚀 Downloading original track via residential IP...`);
    
    function runDownload(useCookies = true) {
      const currentArgs = [
        '-f', 'ba[ext=m4a]/ba[ext=webm]/bestaudio/ba/b/best',
        '-o', tempFile,
        '--no-playlist',
        '--no-warnings',
        '--extractor-args', 'youtube:player_client=android,web,tv,visionos',
        ...(useCookies && cookieFile ? ['--cookies', cookieFile] : []),
        targetUrl
      ];

      const ytProcess = spawn(YTDLP_PATH, currentArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let errBuffer = '';
      ytProcess.stderr.on('data', (d) => { errBuffer += d.toString(); });

      ytProcess.on('close', (code) => {
        // If failed with cookie error "The page needs to be reloaded" or bot check, retry without cookies!
        if ((code !== 0 || !fs.existsSync(tempFile)) && useCookies && cookieFile && (errBuffer.includes('The page needs to be reloaded') || errBuffer.includes('Sign in') || errBuffer.includes('bot'))) {
          console.warn(`[Bridge] ⚠️ Cookies triggered YouTube reload requirement. Retrying clean without cookies...`);
          try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
          return runDownload(false);
        }

        if (code !== 0 || !fs.existsSync(tempFile)) {
          console.error(`[Bridge] ❌ Download failed (code ${code}): ${errBuffer.slice(0, 200)}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Download failed', details: errBuffer }));
        }

        // Rename temp file to cached file
        try {
          fs.renameSync(tempFile, cachedFile);
        } catch (_) {}

        const fileToStream = fs.existsSync(cachedFile) ? cachedFile : tempFile;
        const stats = fs.statSync(fileToStream);

        console.log(`[Bridge] ✅ Completed download (${(stats.size / 1024 / 1024).toFixed(2)} MB). Streaming to bot server...`);
        res.writeHead(200, {
          'Content-Type': 'audio/mp4',
          'Content-Length': stats.size,
          'Cache-Control': 'public, max-age=86400',
          'X-Bridge-Source': useCookies ? 'residential-fresh' : 'residential-nocookies'
        });

        fs.createReadStream(fileToStream).pipe(res);
      });

      req.on('close', () => {
        if (!ytProcess.killed) {
          try { ytProcess.kill(); } catch (_) {}
        }
      });
    }

    runDownload(true);
    return;

    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(8888, '0.0.0.0', () => {
  console.log('🚀 Residential Audio Bridge running on http://127.0.0.1:8888');
});
