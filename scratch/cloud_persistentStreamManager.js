import fs from 'fs';
import path from 'path';

// Load mp3FrameParser with robust fallback across execution environments
let parseMp3Frames;
try {
  ({ parseMp3Frames } = await import('./mp3FrameParser.js'));
} catch (_) {
  try {
    ({ parseMp3Frames } = await import('../src/audio/mp3FrameParser.js'));
  } catch (_e) {
    ({ parseMp3Frames } = await import('./src/audio/mp3FrameParser.js'));
  }
}

// Optional 96k CBR MP3 validator
let is96kCbrMp3Buffer = () => true;
try {
  const v = await import('./mp3Validator.js');
  if (v.is96kCbrMp3Buffer) is96kCbrMp3Buffer = v.is96kCbrMp3Buffer;
} catch (_) {}

const MAX_BURST_BYTES = 12 * 1024; // 12 KB = ~1.02 seconds of 96kbps MP3 audio

export class PersistentStreamManager {
  constructor(options = {}) {
    this.bitrate = options.bitrate || '96k';
    this.streamName = options.streamName || 'Highrise Dedicated Audio Stream';
    this.assetsDir = options.assetsDir || path.join(process.cwd(), 'assets');

    this.clients = new Set();
    this.clientMetadata = new Map();

    // Byte-accurate Icecast burst buffer
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
    this.maxBurstBytes = MAX_BURST_BYTES;

    this.stats = {
      totalBytes: 0,
      droppedClients: 0,
      peakListeners: 0,
      startTime: Date.now(),
      totalConnections: 0
    };

    this.isSendingSilence = false;
    this.silenceInterval = null;
    this.silenceMp3Buffer = null;
    this.silenceFrames = [];
    this.silenceFrameIndex = 0;

    // Announcement state
    this.announcementSessionId = 0;
    this.isAnnouncing = false;

    this.streamVersion = 1;
    this.audioPlayer = null;
  }

  init() {
    if (!fs.existsSync(this.assetsDir)) {
      try { fs.mkdirSync(this.assetsDir, { recursive: true }); } catch (_) {}
    }

    const silencePath = path.join(this.assetsDir, 'silence_96k.mp3');
    const silenceB64Path = path.join(this.assetsDir, '..', 'scratch', 'silence_b64.txt');

    if (fs.existsSync(silencePath) && fs.statSync(silencePath).size >= 1000) {
      try {
        this.silenceMp3Buffer = fs.readFileSync(silencePath);
        console.log(`✅ [StreamManager] Loaded silence buffer (${this.silenceMp3Buffer.length} bytes) from ${silencePath}.`);
      } catch (err) {
        console.warn(`⚠️ [StreamManager] Failed to read ${silencePath}: ${err.message}.`);
      }
    }

    // Fallback: Read raw base64 from scratch/silence_b64.txt if audio file missing
    if (!this.silenceMp3Buffer || this.silenceMp3Buffer.length < 1000) {
      if (fs.existsSync(silenceB64Path)) {
        try {
          const b64 = fs.readFileSync(silenceB64Path, 'utf8').trim();
          this.silenceMp3Buffer = Buffer.from(b64, 'base64');
          try {
            fs.writeFileSync(silencePath, this.silenceMp3Buffer);
            console.log(`✅ [StreamManager] Cached silence asset (${this.silenceMp3Buffer.length} bytes) to ${silencePath}.`);
          } catch (_) {}
        } catch (b64Err) {
          console.warn(`⚠️ [StreamManager] Could not read ${silenceB64Path}: ${b64Err.message}`);
        }
      }
    }

    // Pre-parse the entire silence file into discrete, intact MPEG Layer 3 frames
    if (this.silenceMp3Buffer && typeof parseMp3Frames === 'function') {
      this.silenceFrames = parseMp3Frames(this.silenceMp3Buffer);
    } else {
      this.silenceFrames = [];
    }

    this.silenceFrameIndex = 0;
    console.log(`✅ [StreamManager] Loaded ${this.silenceFrames.length} intact MPEG Layer 3 frames (313/314 bytes).`);
  }

  startSilenceFeed() {
    if (this.silenceInterval) return;
    if (!this.silenceFrames || this.silenceFrames.length === 0) {
      this.init();
    }
    if (!this.silenceFrames || this.silenceFrames.length === 0) {
      console.error('❌ [StreamManager] Cannot start silence feed: No intact silence frames available.');
      return;
    }

    this.isSendingSilence = true;

    const hrStart = process.hrtime.bigint();
    let silenceFramesSent = 0;
    const LEAD_NS = 500_000_000n; // 500ms lead cushion

    this.silenceInterval = setInterval(() => {
      if (!this.isSendingSilence) return;

      const elapsedNs = process.hrtime.bigint() - hrStart;
      // High-resolution pacing: 44.1kHz CBR MPEG-1 Layer 3 = 1152 samples per frame (~26.122ms)
      const targetFrames = Number(((elapsedNs + LEAD_NS) * 44100n) / 1_152_000_000_000n);

      // When nobody is listening and burst buffer is primed, idle to maintain 0.0% CPU
      // Keep silenceFramesSent synchronized with real time so it never falls behind and bursts when a client connects!
      if (this.clients.size === 0 && this.audioBufferBytes >= this.maxBurstBytes) {
        silenceFramesSent = targetFrames;
        return;
      }

      // Safeguard: Clamp max catchup to at most 3 frames (~78ms) to prevent burst floods under any clock jitter
      if (targetFrames - silenceFramesSent > 10) {
        silenceFramesSent = targetFrames - 2;
      }

      while (silenceFramesSent < targetFrames) {
        const frame = this.silenceFrames[this.silenceFrameIndex % this.silenceFrames.length];
        this.silenceFrameIndex++;
        this.broadcast(frame);
        silenceFramesSent++;
      }
    }, 25);
  }

  stopSilenceFeed() {
    if (this.silenceInterval) {
      clearInterval(this.silenceInterval);
      this.silenceInterval = null;
    }
    this.isSendingSilence = false;
  }

  resumeSilenceFeed() {
    this.stopSilenceFeed();
    this.startSilenceFeed();
  }

  clearBurstBuffer() {
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
  }

  broadcast(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.stats.totalBytes += chunk.length;

    // Maintain byte-accurate 12 KB rolling burst buffer (exactly ~1.02s of 96kbps MP3 audio)
    this.audioBuffer.push(chunk);
    this.audioBufferBytes += chunk.length;
    while (this.audioBufferBytes > this.maxBurstBytes && this.audioBuffer.length > 1) {
      const removed = this.audioBuffer.shift();
      this.audioBufferBytes -= removed.length;
    }

    const now = Date.now();
    for (const client of this.clients) {
      const meta = this.clientMetadata.get(client);
      if (!meta) continue;

      // If client buffer is bloated (> 64 KB = ~5.4s unread in kernel socket buffer)
      if (client.writableLength > 64 * 1024) {
        if (now - meta.lastSuccessfulWrite > 10000) {
          console.warn(`⚠️ [StreamManager] Removing stalled listener (${(client.writableLength / 1024).toFixed(0)} KB un-drained > 10s)`);
          this.removeClient(client);
        }
        continue;
      }

      try {
        const canWrite = client.write(chunk);
        meta.lastWrite = now;
        if (canWrite) {
          meta.lastSuccessfulWrite = now;
        }
        meta.bytesWritten += chunk.length;
        meta.writeFailures = 0;
      } catch (_) {
        meta.writeFailures = (meta.writeFailures || 0) + 1;
        if (meta.writeFailures > 10) this.removeClient(client);
      }
    }
  }

  addClient(res) {
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true, 10000);
    }

    if (!this.isSendingSilence && (!this.audioPlayer || !this.audioPlayer.isPlaying)) {
      this.startSilenceFeed();
    }

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'none',
      'X-Accel-Buffering': 'no',
      'X-Stream-Version': String(this.streamVersion),
      'X-Stream-Live': 'true',
      'icy-index-metadata': '1',
      'icy-name': this.streamName || 'pakmusic',
      'icy-genre': 'music, pop',
      'icy-br': this.bitrate.replace('k', ''),
      'icy-pub': '1',
      'icy-country-code': 'IN',
      'icy-language-codes': 'en'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const now = Date.now();
    this.clients.add(res);
    this.clientMetadata.set(res, {
      addedAt: now,
      bytesWritten: 0,
      writeFailures: 0,
      lastWrite: now,
      lastSuccessfulWrite: now
    });
    this.stats.totalConnections++;

    // Socket drain listener: when TCP buffer drains, update lastSuccessfulWrite immediately
    res.on('drain', () => {
      const meta = this.clientMetadata.get(res);
      if (meta) {
        meta.lastSuccessfulWrite = Date.now();
      }
    });

    if (this.clients.size > this.stats.peakListeners) {
      this.stats.peakListeners = this.clients.size;
    }

    console.log(`👤 Client joined /stream (${this.clients.size} active listener${this.clients.size === 1 ? '' : 's'}, burst=${(this.audioBufferBytes / 1024).toFixed(1)}KB)`);

    // Fast Instant-Play Burst: Flush clean, frame-aligned ~12KB (~1.0s) buffer
    // Satisfies browser initial buffer instantly (<20ms) while preventing 2x/3x/10x catchup burst
    if (this.audioBuffer.length > 0) {
      const burstPayload = Buffer.concat(this.audioBuffer);
      let syncOffset = -1;
      for (let i = 0; i < Math.min(burstPayload.length - 4, 3000); i++) {
        if (burstPayload[i] === 0xFF) {
          const b1 = burstPayload[i + 1];
          // 11 sync bits (0xFF 0xEx) + valid Layer + valid bitrate & samplerate
          if ((b1 & 0xE0) === 0xE0 && ((b1 >> 1) & 0x03) !== 0) {
            const b2 = burstPayload[i + 2];
            if (((b2 >> 4) & 0x0F) !== 0x0F && ((b2 >> 2) & 0x03) !== 0x03) {
              syncOffset = i;
              break;
            }
          }
        }
      }
      const cleanBurst = syncOffset > 0 ? burstPayload.subarray(syncOffset) : burstPayload;
      try {
        res.write(cleanBurst);
      } catch (_) {}
    }

    const cleanup = () => this.removeClient(res);
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
  }

  removeClient(res) {
    if (this.clients.has(res)) {
      this.clients.delete(res);
      this.clientMetadata.delete(res);
      console.log(`👋 Client left /stream (${this.clients.size} active listener${this.clients.size === 1 ? '' : 's'})`);
      try { res.end(); } catch (_) {}
    }
  }

  stopAnnouncement() {
    this.announcementSessionId = (this.announcementSessionId || 0) + 1;
    this.isAnnouncing = false;
  }

  startNewAnnouncementSession() {
    this.stopAnnouncement();
    return this.announcementSessionId;
  }

  isAnnouncementSessionActive(sessionId) {
    return Boolean(sessionId && sessionId === this.announcementSessionId);
  }

  async normalizeAudioTo96kMp3(inputBuffer) {
    if (!inputBuffer || inputBuffer.length === 0) return null;

    if (is96kCbrMp3Buffer(inputBuffer)) {
      return inputBuffer;
    }

    console.error('❌ [StreamManager] Strict Zero-Load: Received non-96k MP3 announcement. Speech normalization must be performed upstream. Refusing playback.');
    return null;
  }

  async streamAnnouncementMp3(mp3Buffer, sessionId) {
    if (!mp3Buffer || mp3Buffer.length === 0) return true;

    // Guard input with is96kCbrMp3Buffer - speech must be exact 96k CBR 44.1kHz MP3
    if (!is96kCbrMp3Buffer(mp3Buffer)) {
      console.warn('⚠️ [StreamManager] Announcement aborted: audio buffer failed 96k CBR MP3 validation.');
      return false;
    }

    const normalizedBuffer = mp3Buffer;
    const expectedSession = sessionId !== null ? sessionId : this.announcementSessionId;
    if (this.announcementSessionId !== expectedSession) return false;

    this.stopSilenceFeed();
    this.isAnnouncing = true;

    // Pause audio player smoothly so music frames are NEVER interleaved with speech
    if (this.audioPlayer && typeof this.audioPlayer.pauseForAnnouncement === 'function' && this.audioPlayer.isPlaying) {
      this.audioPlayer.pauseForAnnouncement();
    }

    // Parse announcement frames directly for clean frame-level delivery
    const announcementFrames = typeof parseMp3Frames === 'function'
      ? parseMp3Frames(normalizedBuffer)
      : [];

    if (announcementFrames.length === 0) {
      console.warn('⚠️ [StreamManager] Announcement aborted: 0 intact frames parsed from buffer.');
      this.isAnnouncing = false;
      if (this.audioPlayer && this.audioPlayer.isPlaying && typeof this.audioPlayer.resumeAfterAnnouncement === 'function') {
        this.audioPlayer.resumeAfterAnnouncement();
      } else {
        this.resumeSilenceFeed();
      }
      return false;
    }

    const hrStart = process.hrtime.bigint();
    let framesSent = 0;
    const LEAD_NS = 500_000_000n; // 500ms lead

    try {
      while (framesSent < announcementFrames.length) {
        if (this.announcementSessionId !== expectedSession) {
          return false;
        }

        const elapsedNs = process.hrtime.bigint() - hrStart;
        const targetFrames = Number(((elapsedNs + LEAD_NS) * 44100n) / 1_152_000_000_000n);

        while (framesSent < targetFrames && framesSent < announcementFrames.length) {
          this.broadcast(announcementFrames[framesSent]);
          framesSent++;
        }

        if (framesSent >= announcementFrames.length) break;

        await new Promise(r => setTimeout(r, 25));
      }

      if (this.announcementSessionId === expectedSession) {
        if (this.audioPlayer && this.audioPlayer.isPlaying && typeof this.audioPlayer.resumeAfterAnnouncement === 'function') {
          this.audioPlayer.resumeAfterAnnouncement();
        } else {
          this.resumeSilenceFeed();
        }
      }
      return true;
    } finally {
      if (this.announcementSessionId === expectedSession) {
        this.isAnnouncing = false;
      }
    }
  }

  getStats() {
    return {
      activeListeners: this.clients.size,
      peakListeners: this.stats.peakListeners,
      totalConnections: this.stats.totalConnections,
      totalMegabytes: (this.stats.totalBytes / 1024 / 1024).toFixed(2),
      burstBufferKB: (this.audioBufferBytes / 1024).toFixed(1),
      isSendingSilence: this.isSendingSilence,
      uptimeSeconds: Math.floor((Date.now() - this.stats.startTime) / 1000)
    };
  }
}
