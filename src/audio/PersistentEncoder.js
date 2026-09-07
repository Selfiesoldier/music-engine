import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { CONFIG } from '../config.js';
import { SilenceEngine } from './SilenceEngine.js';

export class PersistentEncoder {
  constructor() {
    this.clients = new Set();
    this.clientMetadata = new Map();
    this.audioBuffer = []; // Rolling buffer of recent MP3 chunks
    this.maxBufferLength = CONFIG.MAX_BURST_BUFFER;
    this.burstChunksCount = CONFIG.INITIAL_BURST_CHUNKS;

    this.pcmInputStream = null;
    this.encoderProcess = null;
    this.silenceEngine = null;
    this.isRunning = false;
    this.isDestroyed = false;
    this.restartAttempts = 0;
    this.restartTimeout = null;

    this.stats = {
      totalBytesOut: 0,
      totalConnections: 0,
      peakListeners: 0,
      droppedClients: 0,
      startedAt: Date.now()
    };
  }

  start() {
    if (this.isRunning || this.isDestroyed) return;

    console.log('🚀 [Encoder] Starting Persistent FFmpeg MP3 Encoder...');
    this.pcmInputStream = new PassThrough({ highWaterMark: 64 * 1024 });
    this.silenceEngine = new SilenceEngine(this.pcmInputStream);

    const ffmpegArgs = [
      '-threads', '1',
      '-f', 's16le',
      '-ar', String(CONFIG.SAMPLE_RATE),
      '-ac', String(CONFIG.CHANNELS),
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame',
      '-compression_level', '2',
      '-b:a', CONFIG.BITRATE,
      '-flush_packets', '1',
      '-write_xing', '0',
      '-id3v2_version', '0',
      '-f', 'mp3',
      'pipe:1'
    ];

    this.encoderProcess = spawn(CONFIG.FFMPEG_PATH, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.encoderProcess.stdout.on('data', (chunk) => {
      if (!this.isDestroyed) this.broadcast(chunk);
    });

    this.encoderProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('fatal')) {
        console.error('⚠️ [FFmpeg Encoder]', msg.trim());
      }
    });

    this.encoderProcess.on('error', (err) => {
      if (this.isDestroyed) return;
      console.error('❌ [FFmpeg Encoder Error]:', err.message);
      this.handleCrash();
    });

    this.encoderProcess.on('close', (code) => {
      if (this.isDestroyed) return;
      console.warn(`⚠️ [FFmpeg Encoder Closed] Code: ${code} - Triggering restart`);
      this.handleCrash();
    });

    this.pcmInputStream.pipe(this.encoderProcess.stdin);
    this.isRunning = true;
    this.restartAttempts = 0;

    // Start baseline silence feed immediately so stream is never dead
    this.silenceEngine.startFeed();
    console.log('✅ [Encoder] Persistent MP3 Encoder active!');
  }

  handleCrash() {
    if (this.isDestroyed) return;
    this.isRunning = false;
    if (this.silenceEngine) this.silenceEngine.destroy();
    if (this.restartTimeout) return;

    this.restartAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.restartAttempts - 1), 10000);
    console.log(`🔄 [Encoder] Restarting encoder in ${(delay / 1000).toFixed(1)}s (Attempt #${this.restartAttempts})...`);

    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      if (!this.isDestroyed) this.start();
    }, delay);
  }

  addClient(req, res) {
    if (this.isDestroyed) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Server shutting down');
      return;
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Connection': 'keep-alive',
        'Accept-Ranges': 'none',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
        'icy-name': 'Highrise Music Engine v3',
        'icy-br': CONFIG.BITRATE.replace('k', ''),
        'icy-pub': '1'
      });
      res.end();
      return;
    }

    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true, 15000);
      try { res.socket.setTimeout(0); } catch (e) {}
    }
    try { req.setTimeout(0); } catch (e) {}
    try { res.setTimeout(0); } catch (e) {}

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Connection': 'keep-alive',
      'Accept-Ranges': 'none',
      'Content-Disposition': 'inline',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
      'icy-name': 'Highrise Music Engine v3',
      'icy-br': CONFIG.BITRATE.replace('k', ''),
      'icy-pub': '1'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const meta = {
      connectedAt: Date.now(),
      lastWrite: Date.now(),
      bytesSent: 0,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress
    };

    this.clients.add(res);
    this.clientMetadata.set(res, meta);
    this.stats.totalConnections++;
    if (this.clients.size > this.stats.peakListeners) {
      this.stats.peakListeners = this.clients.size;
    }

    // Send gentle initial audio burst (~1.5s buffer cushion) so new client starts smoothly without buffer bloat
    if (this.audioBuffer.length > 0) {
      try {
        const burstCount = Math.min(this.burstChunksCount, 20);
        const startIdx = Math.max(0, this.audioBuffer.length - burstCount);
        const burst = Buffer.concat(this.audioBuffer.slice(startIdx));
        res.write(burst);
        meta.bytesSent += burst.length;
      } catch (e) {}
    }

    const cleanup = () => {
      if (this.clients.has(res)) {
        this.clients.delete(res);
        this.clientMetadata.delete(res);
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  broadcast(chunk) {
    if (this.isDestroyed) return;
    // Maintain rolling buffer for instant-start cushion
    this.audioBuffer.push(chunk);
    if (this.audioBuffer.length > this.maxBufferLength) {
      this.audioBuffer.shift();
    }

    if (this.clients.size === 0) return;
    this.stats.totalBytesOut += chunk.length;

    const deadClients = [];
    for (const client of this.clients) {
      // 1. Drop abandoned / dead client connections (>512 KB unsent backlog = ~22s frozen)
      if (client.writableLength > 512 * 1024) {
        deadClients.push(client);
        this.stats.droppedClients++;
        continue;
      }

      // 2. If client is temporarily congested/buffering (>64 KB unsent), skip chunk to prevent buffer bloat
      if (client.writableLength > 64 * 1024) {
        continue;
      }

      try {
        client.write(chunk);
      } catch (err) {
        deadClients.push(client);
      }
    }

    for (const client of deadClients) {
      this.clients.delete(client);
      this.clientMetadata.delete(client);
      try { client.end(); } catch (e) {}
    }
  }

  feedPCM(pcmChunk) {
    if (this.isDestroyed) return false;
    if (!this.pcmInputStream || this.pcmInputStream.destroyed) return false;
    if (this.silenceEngine) this.silenceEngine.stopFeed();
    try {
      return this.pcmInputStream.write(pcmChunk);
    } catch (e) {
      return false;
    }
  }

  resumeSilence() {
    if (!this.isDestroyed && this.silenceEngine) this.silenceEngine.startFeed();
  }

  overlayVoiceInSilence(pcmBuffer) {
    if (this.isDestroyed || !this.silenceEngine) return false;
    if (!this.silenceEngine.isFeeding) {
      this.silenceEngine.startFeed();
    }
    this.silenceEngine.overlayVoice(pcmBuffer);
    return true;
  }

  destroy() {
    this.isDestroyed = true;
    this.isRunning = false;

    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    if (this.silenceEngine) {
      try { this.silenceEngine.destroy(); } catch (e) {}
      this.silenceEngine = null;
    }

    // Gracefully close all client streams
    for (const client of this.clients) {
      try { client.end(); } catch (e) {}
    }
    this.clients.clear();
    this.clientMetadata.clear();
    this.audioBuffer = [];

    // Tear down input stream
    if (this.pcmInputStream) {
      try {
        if (!this.pcmInputStream.destroyed) this.pcmInputStream.destroy();
      } catch (e) {}
      this.pcmInputStream = null;
    }

    // Terminate FFmpeg encoder child process cleanly
    if (this.encoderProcess) {
      const proc = this.encoderProcess;
      this.encoderProcess = null;
      try {
        proc.removeAllListeners('close');
        proc.removeAllListeners('error');
        if (proc.stdin && !proc.stdin.destroyed) {
          try { proc.stdin.end(); } catch (e) {}
        }
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch (e) {}
    }
    console.log('🛑 [Encoder] Persistent MP3 Encoder destroyed.');
  }

  getHealth() {
    return {
      running: this.isRunning,
      pid: this.encoderProcess?.pid || null,
      activeListeners: this.clients.size,
      peakListeners: this.stats.peakListeners,
      totalBytesOutMB: (this.stats.totalBytesOut / 1024 / 1024).toFixed(2),
      isSendingSilence: this.silenceEngine?.isFeeding || false
    };
  }
}
