import { SmartTitleParser } from '../utils/SmartTitleParser.js';
import yts from 'yt-search';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { CookieShield } from './CookieShield.js';
import { AudioCache } from './AudioCache.js';

export class TrackDownloader {
  constructor() {
    this.cookieShield = new CookieShield();
    this.audioCache = new AudioCache();
    this.resolvedYtdlpPath = this.resolveYtdlp();
    this.activeProcesses = new Set();
    this.inFlightDownloads = new Map();
  }

  resolveYtdlp() {
    const isWindows = process.platform === 'win32';
    const candidates = isWindows
      ? [
          path.join(CONFIG.ROOT_DIR, 'yt-dlp.exe'),
          path.join(CONFIG.ROOT_DIR, '..', 'yt-dlp.exe'),
          'yt-dlp.exe',
          'yt-dlp'
        ]
      : [
          path.join(CONFIG.ROOT_DIR, 'yt-dlp'),
          path.join(CONFIG.ROOT_DIR, '..', 'yt-dlp'),
          '/usr/local/bin/yt-dlp',
          '/usr/bin/yt-dlp',
          'yt-dlp'
        ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        if (!isWindows) {
          if (c.endsWith('.exe')) continue; // Never run Windows binary on Linux!
          try { fs.chmodSync(c, 0o755); } catch (e) {}
        }
        return c;
      }
    }

    // Auto-fetch Linux binary on headless hosts (OriHost)
    if (!isWindows) {
      const targetBin = path.join(CONFIG.ROOT_DIR, 'yt-dlp');
      this.autoDownloadLinuxBinary(targetBin);
      return targetBin;
    }

    return 'yt-dlp';
  }

  autoDownloadLinuxBinary(targetBin) {
    try {
      console.log('📦 [Downloader] Linux yt-dlp binary missing. Auto-downloading official release...');
      import('node-fetch').then(async ({ default: fetch }) => {
        const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        const res = await fetch(url);
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(targetBin, buffer);
          fs.chmodSync(targetBin, 0o755);
          console.log('✅ [Downloader] Successfully installed Linux yt-dlp binary (chmod 755)!');
          this.resolvedYtdlpPath = targetBin;
        }
      }).catch(err => {
        console.warn('⚠️ [Downloader] Failed to auto-download yt-dlp binary:', err.message);
      });
    } catch (e) {}
  }

  async resolveMetadata(query) {
    // 1. Direct URL check
    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    let video = null;
    let candidates = [];

    if (/^[a-zA-Z0-9_-]{11}$/.test(query.trim())) {
      try {
        video = await yts({ videoId: query.trim() });
      } catch (e) {}
    }

    if (!video) {
      if (isUrl) {
        const match = query.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
        const videoId = match ? match[1] : null;
        if (videoId) {
          try {
            video = await yts({ videoId });
          } catch (e) {}
        }
        if (!video) {
          const searchRes = await yts(query);
          video = searchRes?.videos?.[0];
          candidates = searchRes?.videos?.slice(1, 5) || [];
        }
      } else {
        const searchRes = await yts(query);
        video = searchRes?.videos?.[0];
        candidates = searchRes?.videos?.slice(1, 5) || [];
      }
    }

    if (!video) return null;

    const cleaned = SmartTitleParser.clean(video.title, video.author?.name || 'Unknown Artist');

    return {
      videoId: video.videoId,
      url: video.url || `https://youtube.com/watch?v=${video.videoId}`,
      title: cleaned.title,
      rawTitle: video.title,
      artist: cleaned.artist,
      rawArtist: video.author?.name || 'Unknown Artist',
      duration: video.timestamp || '0:00',
      durationSeconds: video.seconds || 0,
      thumbnail: video.thumbnail,
      candidates
    };
  }

  async downloadTrack(metadata) {
    const videoId = metadata.videoId;

    // 1. Check Smart LRU Cache (Instant 0.0s Return!)
    const cachedFile = this.audioCache.getTrack(videoId);
    if (cachedFile) {
      console.log(`⚡ [AudioCache HIT] Instant replay from cache: "${metadata.title}" (0.0s)`);
      return cachedFile;
    }

    // 2. Check In-Flight Downloads (Prevent concurrent collision on same track)
    if (this.inFlightDownloads.has(videoId)) {
      console.log(`⏳ [Downloader] Joining active in-flight download for: "${metadata.title}" (${videoId})`);
      return await this.inFlightDownloads.get(videoId);
    }

    const downloadPromise = (async () => {
      try {
        return await this._executeDownload(metadata);
      } catch (err) {
        // Fallback: If primary video was blocked, region-restricted, or format failed, try 1 candidate!
        if (metadata.candidates && metadata.candidates.length > 0) {
          const cand = metadata.candidates[0];
          console.warn(`🔄 [Downloader] Primary video failed (${err.message.slice(0, 80)}). Trying fallback: "${cand.title}" (${cand.videoId})...`);
          try {
            const candMeta = {
              ...metadata,
              videoId: cand.videoId,
              url: cand.url || `https://youtube.com/watch?v=${cand.videoId}`,
              title: cand.title,
              candidates: []
            };
            return await this._executeDownload(candMeta, false);
          } catch (candErr) {
            console.warn(`⚠️ [Downloader] Fallback candidate failed:`, candErr.message.slice(0, 80));
          }
        }
        throw err;
      }
    })();

    this.inFlightDownloads.set(videoId, downloadPromise);
    try {
      return await downloadPromise;
    } finally {
      this.inFlightDownloads.delete(videoId);
    }
  }

  async _executeDownload(metadata, useCookies = null) {
    const videoId = metadata.videoId;
    const hasCookies = Boolean(this.cookieShield.findMasterCookieFile());
    const shouldPassCookies = useCookies !== null ? useCookies : hasCookies;
    console.log(`📥 [Downloader] Fetching audio from YouTube for: "${metadata.title}"${shouldPassCookies ? ' (with cookies)' : ' (unauthenticated mode)'}`);
    const outputPath = this.audioCache.getTrackPath(videoId);
    const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tempPath = `${outputPath}.${uniqueId}.tmp`;

    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}

    const cookieArgs = shouldPassCookies ? this.cookieShield.getYtdlpCookieArgs() : [];
    const ffmpegDir = path.dirname(CONFIG.FFMPEG_PATH);
    const ffmpegLocationArgs = fs.existsSync(CONFIG.FFMPEG_PATH) ? ['--ffmpeg-location', ffmpegDir] : [];

    const denoArgs = fs.existsSync('/usr/local/bin/deno') ? ['--js-runtimes', 'deno'] : [];
    const ytdlpArgs = [
      '--no-playlist',
      '-f', 'ba/b/best',
      '--no-warnings',
      '--geo-bypass',
      ...denoArgs,
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      '--no-check-certificate',
      '--socket-timeout', '10',
      ...ffmpegLocationArgs,
      ...cookieArgs,
      '-o', tempPath,
      metadata.url
    ];

    const startTime = Date.now();
    try {
      await new Promise((resolve, reject) => {
        let isPython = false;
        let bin = this.resolvedYtdlpPath;
        let args = ytdlpArgs;

        // On Linux, if yt-dlp is a Python script
        if (!bin.endsWith('.exe') && fs.existsSync(bin)) {
          try {
            const head = fs.readFileSync(bin, { encoding: 'utf-8', flag: 'r' }).slice(0, 100);
            if (head.includes('python')) {
              isPython = true;
              bin = 'python3';
              args = [this.resolvedYtdlpPath, ...ytdlpArgs];
            }
          } catch (e) {}
        }

        // CRITICAL: stdio ignore stdout so pipe buffer does not fill and deadlock child process!
        const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        this.activeProcesses.add(proc);

        let timeoutId = null;
        let settled = false;

        const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          this.activeProcesses.delete(proc);
        };

        timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            try {
              if (!proc.killed) proc.kill('SIGKILL');
            } catch (e) {}
            reject(new Error(`yt-dlp download timed out after 15s for "${metadata.title}"`));
          }
        }, 15000);

        let stderr = '';
        if (proc.stderr) {
          proc.stderr.on('data', d => stderr += d.toString());
        }

        proc.on('close', code => {
          if (settled) return;
          settled = true;
          cleanup();

          if (code === 0) {
            try {
              const parentDir = path.dirname(tempPath);
              const baseTemp = path.basename(tempPath);
              const matches = fs.existsSync(parentDir)
                ? fs.readdirSync(parentDir).filter(f => f.startsWith(baseTemp) && !f.endsWith('.part'))
                : [];

              if (matches.length > 0) {
                const matchedFile = path.join(parentDir, matches[0]);
                fs.renameSync(matchedFile, outputPath);
                resolve();
              } else if (fs.existsSync(tempPath)) {
                fs.renameSync(tempPath, outputPath);
                resolve();
              } else if (fs.existsSync(outputPath)) {
                resolve();
              } else {
                reject(new Error(`yt-dlp output file not found for ${tempPath}`));
              }
            } catch (renameErr) {
              if (fs.existsSync(outputPath)) {
                resolve();
              } else {
                reject(renameErr);
              }
            }
          } else {
            reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(-300).trim()}`));
          }
        });

        proc.on('error', err => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
      });
    } catch (dlErr) {
      if (shouldPassCookies && cookieArgs.length > 0) {
        console.warn(`🔄 [Downloader] Cookie download failed (${dlErr.message.slice(0, 60)}). Retrying in unauthenticated mode...`);
        return await this._executeDownload(metadata, false);
      } else if (!shouldPassCookies && hasCookies) {
        console.warn(`🔄 [Downloader] Unauthenticated download failed (${dlErr.message.slice(0, 60)}). Retrying with cookies...`);
        return await this._executeDownload(metadata, true);
      }
      throw dlErr;
    }

    if (fs.existsSync(outputPath)) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ [Downloader] Downloaded in ${elapsed}s: "${path.basename(outputPath)}"`);
      this.audioCache.prune();
      return outputPath;
    }

    throw new Error('Track download produced no output file');
  }

  abortAll() {
    this.inFlightDownloads.clear();
    if (this.activeProcesses.size > 0) {
      console.log(`🛑 [Downloader] Aborting ${this.activeProcesses.size} active download process(es)...`);
      for (const proc of this.activeProcesses) {
        try {
          proc.removeAllListeners('close');
          proc.removeAllListeners('error');
          if (!proc.killed) proc.kill('SIGKILL');
        } catch (e) {}
      }
      this.activeProcesses.clear();
    }
    this.audioCache.cleanTransients();
  }

  destroy() {
    this.abortAll();
  }
}
