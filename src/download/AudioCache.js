import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

export class AudioCache {
  constructor() {
    this.cacheDir = path.join(CONFIG.CACHE_DIR, 'tracks');
    this.rootCacheDir = CONFIG.CACHE_DIR;
    this.maxSizeBytes = CONFIG.MAX_CACHE_SIZE_MB * 1024 * 1024;
    this.init();
  }

  init() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  getTrackPath(videoId) {
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.cacheDir, `${safeId}.m4a`);
  }

  hasTrack(videoId) {
    if (!videoId) return false;
    const p = this.getTrackPath(videoId);
    if (!fs.existsSync(p)) return false;
    const stats = fs.statSync(p);
    return stats.size > 50000; // Must be at least 50 KB
  }

  getTrack(videoId) {
    if (!this.hasTrack(videoId)) return null;
    const p = this.getTrackPath(videoId);
    try {
      // Update access time for LRU tracking
      const now = new Date();
      fs.utimesSync(p, now, now);
      return p;
    } catch (e) {
      return p;
    }
  }

  /**
   * Recursively scans the entire cache/ tree and purges any incomplete download fragments,
   * temporary files (.tmp, .part, .ytdl, .download, .crdownload), and 0-byte corrupt files.
   */
  cleanTransients(targetDir = this.rootCacheDir) {
    const stats = { count: 0, bytes: 0, removedFiles: [] };

    const scanDirectory = (dir) => {
      if (!fs.existsSync(dir)) return;

      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDirectory(fullPath);
        } else if (entry.isFile()) {
          const lowerName = entry.name.toLowerCase();
          const isTransient =
            lowerName.endsWith('.tmp') ||
            lowerName.includes('.tmp.') ||
            lowerName.endsWith('.part') ||
            lowerName.endsWith('.ytdl') ||
            lowerName.endsWith('.download') ||
            lowerName.endsWith('.crdownload');

          let isCorruptZeroByte = false;
          let fileSize = 0;
          try {
            const fStat = fs.statSync(fullPath);
            fileSize = fStat.size;
            const isTTS = fullPath.includes(path.sep + 'tts') || fullPath.includes('/tts');
            const minSize = isTTS ? 1000 : 50000;
            // Catch 0-byte or truncated media files
            if (fileSize < minSize && (lowerName.endsWith('.m4a') || lowerName.endsWith('.mp3'))) {
              isCorruptZeroByte = true;
            }
          } catch (e) {}

          if (isTransient || isCorruptZeroByte) {
            try {
              fs.unlinkSync(fullPath);
              stats.count++;
              stats.bytes += fileSize;
              stats.removedFiles.push(entry.name);
              console.log(`🧹 [Startup Cleanup] Purged corrupt/transient fragment: ${path.relative(CONFIG.ROOT_DIR, fullPath)} (${fileSize} bytes)`);
            } catch (err) {
              console.warn(`⚠️ [Startup Cleanup] Failed to unlink ${entry.name}:`, err.message);
            }
          }
        }
      }
    };

    scanDirectory(targetDir);

    // Also check for root level queue_state.json.tmp
    const queueTmp = path.join(CONFIG.ROOT_DIR, 'queue_state.json.tmp');
    if (fs.existsSync(queueTmp)) {
      try {
        fs.unlinkSync(queueTmp);
        stats.count++;
        stats.removedFiles.push('queue_state.json.tmp');
      } catch (e) {}
    }

    return stats;
  }

  prune() {
    try {
      const files = fs.readdirSync(this.cacheDir).map(file => {
        const fullPath = path.join(this.cacheDir, file);
        const stats = fs.statSync(fullPath);
        return {
          path: fullPath,
          size: stats.size,
          atime: stats.atimeMs || stats.mtimeMs
        };
      });

      let totalSize = files.reduce((acc, f) => acc + f.size, 0);
      if (totalSize <= this.maxSizeBytes) return;

      // Sort oldest accessed first
      files.sort((a, b) => a.atime - b.atime);

      for (const f of files) {
        if (totalSize <= this.maxSizeBytes * 0.8) break; // Prune to 80% of max
        try {
          fs.unlinkSync(f.path);
          totalSize -= f.size;
          console.log(`🧹 [AudioCache] Evicted old track: ${path.basename(f.path)}`);
        } catch (e) {}
      }
    } catch (err) {
      console.error('❌ [AudioCache] Prune error:', err.message);
    }
  }
}
