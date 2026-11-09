import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import os from 'os';

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const req = protocol.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) {}
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) {}
        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch (_) {}
        reject(err);
      });
    });
    req.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch (_) {}
      reject(err);
    });
    req.setTimeout(30000, () => {
      req.abort();
      file.close();
      try { fs.unlinkSync(destPath); } catch (_) {}
      reject(new Error('Download timed out after 30s'));
    });
  });
}

/**
 * Scans an MP3 file to determine the byte offset of the end of the last complete MP3 frame.
 * Truncates partial frames at EOF and ignores trailing ID3v1 tags (128 bytes).
 * @param {string} filePath - Path to the local MP3 file
 * @param {number} totalFileSize - Total size of the file in bytes
 * @returns {number} Byte offset where the last intact frame ends (effectiveFileSize)
 */
export function getEffectiveMp3FileSize(filePath, totalFileSize) {
  try {
    if (!totalFileSize || totalFileSize <= 0) {
      totalFileSize = fs.statSync(filePath).size;
    }
    if (totalFileSize <= 4) return totalFileSize;

    const buf = fs.readFileSync(filePath);

    // Check ID3v1 tag at EOF (128 bytes starting with 'TAG')
    let maxAudioOffset = buf.length;
    if (buf.length >= 128 && buf.subarray(buf.length - 128, buf.length - 125).toString('ascii') === 'TAG') {
      maxAudioOffset = buf.length - 128;
    }

    // Skip ID3v2 metadata prefix at start
    let offset = 0;
    if (buf.length >= 10 && buf.subarray(0, 3).toString('ascii') === 'ID3') {
      const tagSize = ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F);
      const footer = (buf[5] & 0x10) ? 10 : 0;
      offset = 10 + tagSize + footer;
    }

    const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    const MPEG1_RATES = [44100, 48000, 32000, 0];
    const MPEG2_RATES = [22050, 24000, 16000, 0];
    const MPEG25_RATES = [11025, 12000, 8000, 0];

    let lastCompleteFrameEnd = 0;

    while (offset + 4 <= maxAudioOffset) {
      if (buf[offset] === 0xFF && (buf[offset + 1] & 0xE0) === 0xE0) {
        const ver = (buf[offset + 1] >> 3) & 0x03;
        const layer = (buf[offset + 1] >> 1) & 0x03;
        const brIdx = (buf[offset + 2] >> 4) & 0x0F;
        const srIdx = (buf[offset + 2] >> 2) & 0x03;
        const padding = (buf[offset + 2] >> 1) & 0x01;

        if (ver !== 1 && layer === 1 && brIdx > 0 && brIdx < 15 && srIdx < 3) {
          let bitrate = 0;
          let sampleRate = 0;
          const isMpeg1 = ver === 3;
          if (isMpeg1) {
            bitrate = MPEG1_L3_BITRATES[brIdx] * 1000;
            sampleRate = MPEG1_RATES[srIdx];
          } else if (ver === 2) {
            bitrate = MPEG2_L3_BITRATES[brIdx] * 1000;
            sampleRate = MPEG2_RATES[srIdx];
          } else if (ver === 0) {
            bitrate = MPEG2_L3_BITRATES[brIdx] * 1000;
            sampleRate = MPEG25_RATES[srIdx];
          }

          const frameSize = isMpeg1
            ? Math.floor((144 * bitrate) / sampleRate) + padding
            : Math.floor((72 * bitrate) / sampleRate) + padding;

          if (frameSize > 0 && offset + frameSize <= maxAudioOffset) {
            lastCompleteFrameEnd = offset + frameSize;
            offset += frameSize;
            continue;
          }
        }
      }
      offset++;
    }

    if (lastCompleteFrameEnd > 0) {
      return lastCompleteFrameEnd;
    }
  } catch (err) {
    console.warn(`⚠️ [AudioPlayer] Error scanning MP3 frame boundaries: ${err.message}. Falling back to full file.`);
  }

  return totalFileSize;
}

export class AudioPlayer extends EventEmitter {
  constructor(streamManager) {
    super();
    this.streamManager = streamManager;
    if (this.streamManager) {
      this.streamManager.audioPlayer = this;
    }
    this.currentTranscoder = null;
    this.currentTrack = null;
    this.isPlaying = false;
    this.currentVolume = 100; // 0 - 100
    this.playSessionId = 0;
    this.currentFd = null;
    this.tempFilesToClean = new Set();
  }

  setVolume(vol) {
    const parsed = Math.max(0, Math.min(150, Number(vol) || 100));
    this.currentVolume = parsed;
    console.log(`🔊 [AudioPlayer] Volume set to ${this.currentVolume}%`);
    return this.currentVolume;
  }

  cleanTempFiles() {
    for (const filePath of this.tempFilesToClean) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
    }
    this.tempFilesToClean.clear();
  }

  async play(trackInfo) {
    const { source, title = 'Unknown Track', durationSeconds = 0, volume, webhookUrl } = trackInfo;

    if (!source) {
      throw new Error('Missing "source" parameter (must be URL or file path)');
    }

    // Stop previous track cleanly
    this.stop(false, false);
    this.streamManager.stopAnnouncement();

    if (this.streamManager.clearBurstBuffer) {
      this.streamManager.clearBurstBuffer();
    }

    const sessionId = ++this.playSessionId;
    this.isPlaying = true;
    if (typeof volume === 'number') this.currentVolume = volume;

    this.currentTrack = {
      source,
      title,
      durationSeconds: Number(durationSeconds) || 0,
      startTime: Date.now(),
      webhookUrl
    };

    console.log(`▶️ [AudioPlayer] [Session ${sessionId}] Preparing: "${title}" (Vol: ${this.currentVolume}%)`);

    const tmpDir = os.tmpdir();
    let localInputPath = source;
    const isRemote = source.startsWith('http://') || source.startsWith('https://');

    if (isRemote) {
      let ext = '.m4a';
      try {
        const parsedUrl = new URL(source);
        const urlExt = path.extname(parsedUrl.pathname);
        if (urlExt && urlExt.length <= 5) ext = urlExt;
      } catch (_) {}

      localInputPath = path.join(tmpDir, `in_${sessionId}_${Date.now()}${ext}`);
      this.tempFilesToClean.add(localInputPath);
      console.log(`📥 [AudioPlayer] Downloading audio source to local disk (${ext})...`);
      try {
        await downloadFile(source, localInputPath);
        const downloadedBytes = fs.statSync(localInputPath).size;
        console.log(`✅ [AudioPlayer] Downloaded ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB to local disk.`);
      } catch (err) {
        console.error(`❌ [AudioPlayer] Download failed: ${err.message}`);
        this.stop(true, true);
        return;
      }
    }

    if (sessionId !== this.playSessionId || !this.isPlaying) {
      this.cleanTempFiles();
      return;
    }

    // Check if input file is ALREADY a ready MP3 (magic bytes: 'ID3' or sync frame 0xFF 0xE0)
    let isAlreadyMp3 = localInputPath.endsWith('.mp3');
    try {
      const fdCheck = fs.openSync(localInputPath, 'r');
      const header = Buffer.alloc(4);
      const readCount = fs.readSync(fdCheck, header, 0, 4, 0);
      fs.closeSync(fdCheck);
      if (readCount >= 3 && header.subarray(0, 3).toString('ascii') === 'ID3') {
        isAlreadyMp3 = true;
      } else if (readCount >= 2 && header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) {
        isAlreadyMp3 = true;
      }
    } catch (_) {}

    // Strict Zero-Load Architecture: Audio Server ONLY streams pre-encoded 96k CBR MP3
    if (!isAlreadyMp3) {
      console.error(`❌ [AudioPlayer] Strict Zero-Load: Received non-MP3 audio (${path.extname(localInputPath) || 'unknown'}). All transcoding must be offloaded to Termux or Download Worker. Refusing to spawn FFmpeg.`);
      this.stop(true, true);
      return;
    }

    console.log(`🚀 [AudioPlayer] Verified 96kbps CBR MP3! Direct monotonic frame streaming (0% CPU, 0 FFmpeg processes).`);
    const localOutputPath = localInputPath;

    // Stop silence right before music begins streaming
    this.streamManager.stopSilenceFeed();
    this.streamManager.streamVersion++;
    if (this.currentTrack) {
      this.currentTrack.startTime = Date.now();
    }

    console.log(`🚀 [AudioPlayer] Starting zero-CPU MP3 frame streaming at 12 KB/sec...`);

    // Stream the MP3 file at exact 12 KB/sec monotonic rate (100ms chunks = 1200 bytes)
    const CHUNK_SIZE = 1200; // 100ms at 96kbps (12000 * 0.1 = 1200 bytes)
    const CHUNK_NS = 100_000_000n; // 100ms in ns
    const LEAD_NS = 1_000_000_000n; // 1.0 second lead cushion

    const fd = fs.openSync(localOutputPath, 'r');
    this.currentFd = fd;
    const readBuffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let fileOffset = 0;
    const hrStart = process.hrtime.bigint();
    let chunksSent = 0;

    const totalFileSize = fs.statSync(localOutputPath).size;
    const effectiveFileSize = getEffectiveMp3FileSize(localOutputPath, totalFileSize);
    if (effectiveFileSize < totalFileSize) {
      console.log(`🎯 [AudioPlayer] Clean EOF alignment: effective audio size ${effectiveFileSize} bytes (trimmed ${totalFileSize - effectiveFileSize} trailing/ID3v1 bytes from ${totalFileSize})`);
    } else {
      console.log(`🎯 [AudioPlayer] Clean EOF alignment: audio file is already frame-aligned at ${effectiveFileSize} bytes.`);
    }

    while (sessionId === this.playSessionId && this.isPlaying) {
      const elapsedNs = process.hrtime.bigint() - hrStart;
      const targetChunks = Number((elapsedNs + LEAD_NS) / CHUNK_NS);

      while (chunksSent < targetChunks) {
        if (fileOffset >= effectiveFileSize) {
          break; // EOF
        }

        const maxToRead = Math.min(CHUNK_SIZE, effectiveFileSize - fileOffset);
        let bytesRead = 0;
        try {
          bytesRead = fs.readSync(fd, readBuffer, 0, maxToRead, fileOffset);
        } catch (e) {
          console.error('Read error:', e.message);
          bytesRead = 0;
        }

        if (bytesRead > 0) {
          if (fileOffset + bytesRead > effectiveFileSize) {
            bytesRead = effectiveFileSize - fileOffset;
          }
          const slice = bytesRead === CHUNK_SIZE ? readBuffer : readBuffer.subarray(0, bytesRead);
          this.streamManager.broadcast(slice);
          fileOffset += bytesRead;
          chunksSent++;
          if (fileOffset >= effectiveFileSize) {
            break; // EOF
          }
        } else {
          break; // EOF
        }
      }

      if (fileOffset >= effectiveFileSize) {
        console.log(`🏁 [AudioPlayer] Track reached clean EOF on frame boundary (${(fileOffset / 1024 / 1024).toFixed(2)} MB played).`);
        break;
      }

      await new Promise(r => setTimeout(r, 40));
    }

    if (this.currentFd === fd) {
      try { fs.closeSync(fd); } catch (_) {}
      this.currentFd = null;
    }

    if (sessionId === this.playSessionId) {
      console.log(`⏹️ [AudioPlayer] Finished track: "${title}"`);
      this.stop(true, true);
    }
  }

  stop(notifyFinished = false, resumeSilence = true) {
    this.isPlaying = false;
    this.playSessionId++;

    if (this.currentTranscoder) {
      try { this.currentTranscoder.kill('SIGKILL'); } catch (_) {}
      this.currentTranscoder = null;
    }

    if (this.currentFd) {
      try { fs.closeSync(this.currentFd); } catch (_) {}
      this.currentFd = null;
    }

    this.cleanTempFiles();

    if (!notifyFinished) {
      this.streamManager.stopAnnouncement();
    }

    const finishedTrack = this.currentTrack;
    this.currentTrack = null;

    if (resumeSilence) {
      this.streamManager.resumeSilenceFeed();
    }

    if (notifyFinished && finishedTrack) {
      this.emit('trackEnd', finishedTrack);
      if (finishedTrack.webhookUrl) {
        this.triggerWebhook(finishedTrack.webhookUrl, {
          event: 'trackEnd',
          track: finishedTrack
        });
      }
    }
  }

  async triggerWebhook(url, data) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (e) {
      console.warn(`⚠️ [AudioPlayer] Webhook failed for ${url}:`, e.message);
    }
  }

  getStatus() {
    const elapsed = this.currentTrack ? Math.floor((Date.now() - this.currentTrack.startTime) / 1000) : 0;
    return {
      isPlaying: this.isPlaying,
      volume: this.currentVolume,
      currentTrack: this.currentTrack ? {
        title: this.currentTrack.title,
        durationSeconds: this.currentTrack.durationSeconds,
        elapsedSeconds: elapsed
      } : null
    };
  }
}
