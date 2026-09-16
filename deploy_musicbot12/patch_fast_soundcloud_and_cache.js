import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(serverPath, 'utf8');

// 1. Update pruneStaleCacheFiles to never delete cached songs
content = content.replace(
  "if (f !== keepBasename && !f.includes('transition')) {",
  "if (f !== keepBasename && !f.includes('transition') && !f.startsWith('song_')) {"
);

// 2. Add SongCache and Notification helpers if not already present
if (!content.includes('const MAX_CACHED_SONGS =')) {
  const helpers = `
// ==========================================
// 🎵 SMART SONG CACHING & LRU SYSTEM
// ==========================================
const MAX_CACHED_SONGS = 15;
const MAX_CACHE_SIZE_BYTES = 120 * 1024 * 1024; // 120 MB max

function getSongCacheKey(url, title = '') {
  const ytMatch = (url || '').match(/(?:v=|youtu\\.be\\/|embed\\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return \`yt_\${ytMatch[1]}\`;
  const normalized = (title || url || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
  return \`sc_\${crypto.createHash('md5').update(normalized || 'unknown').digest('hex').slice(0, 16)}\`;
}

function pruneLRUSongCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const songFiles = [];
    let totalBytes = 0;

    for (const f of files) {
      if (f.startsWith('song_') && f.endsWith('.m4a')) {
        const filePath = path.join(CACHE_DIR, f);
        try {
          const st = fs.statSync(filePath);
          songFiles.push({ name: f, path: filePath, size: st.size, mtime: st.mtimeMs });
          totalBytes += st.size;
        } catch (_) {}
      }
    }

    songFiles.sort((a, b) => a.mtime - b.mtime);

    while ((songFiles.length > MAX_CACHED_SONGS || totalBytes > MAX_CACHE_SIZE_BYTES) && songFiles.length > 5) {
      const oldest = songFiles.shift();
      try {
        fs.unlinkSync(oldest.path);
        totalBytes -= oldest.size;
        console.log(\`🧹 [SongCache] Evicted LRU cached track: \${oldest.name} (\${(oldest.size / 1024 / 1024).toFixed(2)} MB)\`);
      } catch (_) {}
    }
  } catch (e) {}
}

async function sendRoomNotification(text) {
  try {
    await fetch('http://127.0.0.1:5001/api/say', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IPC-Secret': process.env.IPC_SECRET
      },
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.timeout(3000)
    });
  } catch (_) {}
}

let isBridgeHealthy = false;
let lastBridgeHealthCheck = 0;

async function checkBridgeHealth() {
  if (!residentialBridgeUrl) {
    isBridgeHealthy = false;
    return false;
  }
  const now = Date.now();
  if (now - lastBridgeHealthCheck < 20000) {
    return isBridgeHealthy;
  }
  try {
    const resp = await fetch(\`\${residentialBridgeUrl}/health\`, { signal: AbortSignal.timeout(2500) });
    isBridgeHealthy = resp.ok;
  } catch (_) {
    isBridgeHealthy = false;
  }
  lastBridgeHealthCheck = now;
  return isBridgeHealthy;
}
`;
  content = content.replace('let currentLocalFilePath = null;', 'let currentLocalFilePath = null;\n' + helpers);
  console.log('Added smart caching & bridge health helpers');
}

// 3. Replace downloadTrackToFile with the fast-track & caching logic
const oldDownloadRegex = /async function downloadTrackToFile\(url, outputPath, thisStreamId, title = ''\) \{[\s\S]*?\n\}\n\nasync function startStream/m;

const newDownloadTrackToFile = `async function downloadTrackToFile(url, outputPath, thisStreamId, title = '') {
  const isDirectSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');
  const cacheKey = getSongCacheKey(url, title);
  const cachedPath = path.join(CACHE_DIR, \`song_\${cacheKey}.m4a\`);

  // 1. Check local persistent song cache first (0s instant playback!)
  if (fs.existsSync(cachedPath)) {
    try {
      const stats = fs.statSync(cachedPath);
      if (stats.size > 50000) {
        console.log(\`⚡ [SongCache] Instant Cache Hit for "\${title || url}" (\${(stats.size / 1024 / 1024).toFixed(2)} MB)!\`);
        fs.copyFileSync(cachedPath, outputPath);
        try { fs.utimesSync(cachedPath, new Date(), new Date()); } catch (_) {}
        return outputPath;
      }
    } catch (_) {}
  }

  const bridgeOnline = !isDirectSoundCloud && (await checkBridgeHealth());

  // 2. If Home Residential Bridge is connected and healthy, stream YouTube directly
  if (bridgeOnline) {
    try {
      console.log(\`🏠 [Downloader] Streaming YouTube audio via Residential Bridge (\${residentialBridgeUrl})...\`);
      const bridgeStreamUrl = \`\${residentialBridgeUrl}/stream?url=\${encodeURIComponent(url)}\`;
      const resp = await fetch(bridgeStreamUrl, { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) {
        throw new Error(\`Bridge returned HTTP status \${resp.status}\`);
      }
      const fileStream = fs.createWriteStream(outputPath);
      await new Promise((resolve, reject) => {
        resp.body.pipe(fileStream);
        resp.body.on('error', reject);
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
      if (thisStreamId !== currentStreamId) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
        throw new Error("Download aborted: Stream ID changed");
      }
      const stats = fs.statSync(outputPath);
      if (stats.size > 50000) {
        console.log(\`✅ [Downloader] YouTube track downloaded via Residential Bridge (\${(stats.size / 1024 / 1024).toFixed(2)} MB)\`);
        try {
          fs.copyFileSync(outputPath, cachedPath);
          pruneLRUSongCache();
        } catch (_) {}
        return outputPath;
      }
      console.warn(\`⚠️ [Downloader] Bridge file too small (\${stats.size} bytes), proceeding to SoundCloud fallback...\`);
    } catch (bridgeErr) {
      if (thisStreamId !== currentStreamId) throw bridgeErr;
      console.warn(\`⚠️ [Downloader] Residential Bridge failed (\${bridgeErr.message}), fast-tracking to SoundCloud...\`);
    }
  } else if (!isDirectSoundCloud) {
    console.log(\`⚡ [Downloader] Residential bridge offline — fast-tracking directly to SoundCloud (skipping 30s cloud timeout)...\`);
  }

  // 3. Clean high-fidelity SoundCloud Fallback
  const cleanTitle = (title || url || '')
    .replace(/^(?:video\\s*song|full\\s*video|official\\s*video|audio\\s*song)\\s*[-:]\\s*/i, '')
    .replace(/[#|/]/g, ' ')
    .replace(/\\b(official|music|video|song|full|lyrics|hd|4k)\\b/gi, '')
    .trim();

  const scTarget = isDirectSoundCloud ? url : \`scsearch1:\${cleanTitle} original -cover -nightcore -slowed -reverb -karaoke\`;
  console.log(\`⚡ [Downloader] SoundCloud: Fetching audio for "\${cleanTitle || url}"...\`);

  try {
    await executeYtdlpDownload(scTarget, outputPath, thisStreamId, false);
    const stats = fs.statSync(outputPath);
    if (stats.size > 50000) {
      try {
        fs.copyFileSync(outputPath, cachedPath);
        pruneLRUSongCache();
      } catch (_) {}
      return outputPath;
    }
  } catch (scErr) {
    if (!isDirectSoundCloud && cleanTitle) {
      try {
        console.warn(\`⚠️ [Downloader] Filtered SoundCloud failed, retrying standard query...\`);
        await executeYtdlpDownload(\`scsearch1:\${cleanTitle}\`, outputPath, thisStreamId, false);
        const stats = fs.statSync(outputPath);
        if (stats.size > 50000) {
          try {
            fs.copyFileSync(outputPath, cachedPath);
            pruneLRUSongCache();
          } catch (_) {}
          return outputPath;
        }
      } catch (scErr2) {}
    }
  }

  // 4. If neither Bridge nor SoundCloud found the song
  console.error(\`❌ [Downloader] Song "\${title || url}" not found on SoundCloud (or Bridge is offline)\`);
  await sendRoomNotification(\`⚠️ "\${cleanTitle || 'Song'}" not found on SoundCloud (YouTube bridge is offline).\`);
  throw new Error(\`Song not found on SoundCloud\`);
}

async function startStream`;

if (oldDownloadRegex.test(content)) {
  content = content.replace(oldDownloadRegex, newDownloadTrackToFile);
  console.log('Replaced downloadTrackToFile with Fast-Track + Smart Cache + Room Notification');
} else {
  console.log('oldDownloadRegex did not match');
}

fs.writeFileSync(serverPath, content, 'utf8');
console.log('server.js patched successfully!');
