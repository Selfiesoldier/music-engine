import { spawn } from 'child_process';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { AudioFilters } from './AudioFilters.js';

export class AudioPacer {
  constructor(encoder) {
    this.encoder = encoder;
    this.currentStreamId = 0;
    this.activeDecoder = null;
    this.isPlaying = false;
    this.isDestroyed = false;
    this.currentTrack = null;
    this.playbackStartTime = 0;
    this.voiceQueue = Buffer.alloc(0);
    this.duckMultiplier = 1.0;
  }

  stopCurrentStream() {
    this.currentStreamId++;
    this.isPlaying = false;
    this.currentTrack = null;
    this.playbackStartTime = 0;
    this.voiceQueue = Buffer.alloc(0);
    this.duckMultiplier = 1.0;

    if (this.activeDecoder) {
      const d = this.activeDecoder;
      this.activeDecoder = null;
      try {
        d.removeAllListeners('close');
        d.removeAllListeners('error');
        d.removeAllListeners('data');
        if (d.stdout && !d.stdout.destroyed) {
          d.stdout.destroy();
        }
        if (!d.killed) {
          d.kill('SIGKILL');
        }
      } catch (e) {}
    }

    if (!this.isDestroyed) {
      this.encoder.resumeSilence();
    }
  }

  destroy() {
    this.isDestroyed = true;
    this.stopCurrentStream();
    console.log('🛑 [AudioPacer] Audio Pacer destroyed.');
  }

  async waitForSpeechToFinish(timeoutMs = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const voiceActiveInSilence = this.encoder && this.encoder.silenceEngine && this.encoder.silenceEngine.hasVoice;
      const voiceActiveInPacer = this.voiceQueue && this.voiceQueue.length > 0;
      if (!voiceActiveInSilence && !voiceActiveInPacer) {
        await new Promise(r => setTimeout(r, 200));
        return true;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }

  // Plays a standalone audio snippet (e.g. DJ intro or sound effect)
  async playSnippet(filePath) {
    if (this.isDestroyed || !filePath || !fs.existsSync(filePath)) return false;

    this.stopCurrentStream();
    const thisStreamId = ++this.currentStreamId;

    const CHUNK_SIZE = 8820; // 50ms of 44.1kHz 16-bit stereo PCM
    const ffmpegArgs = [
      '-threads', '1',
      '-vn', '-sn', '-dn',
      '-i', filePath,
      '-f', 's16le',
      '-ar', String(CONFIG.SAMPLE_RATE),
      '-ac', String(CONFIG.CHANNELS),
      'pipe:1'
    ];

    const decoder = spawn(CONFIG.FFMPEG_PATH, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    this.activeDecoder = decoder;

    const chunkQueue = [];
    let remainder = null;
    let decoderFinished = false;
    const MAX_SNIPPET_CHUNKS = 25;
    let isPaused = false;

    decoder.stdout.on('data', (data) => {
      let offset = 0;
      let available = data.length;

      if (remainder && remainder.length > 0) {
        const needed = CHUNK_SIZE - remainder.length;
        if (available >= needed) {
          const fullChunk = Buffer.allocUnsafe(CHUNK_SIZE);
          remainder.copy(fullChunk, 0);
          data.copy(fullChunk, remainder.length, 0, needed);
          chunkQueue.push(fullChunk);
          offset += needed;
          available -= needed;
          remainder = null;
        } else {
          remainder = Buffer.concat([remainder, data]);
          return;
        }
      }

      while (available >= CHUNK_SIZE) {
        const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
        data.copy(chunk, 0, offset, offset + CHUNK_SIZE);
        chunkQueue.push(chunk);
        offset += CHUNK_SIZE;
        available -= CHUNK_SIZE;
      }

      if (available > 0) {
        remainder = Buffer.allocUnsafe(available);
        data.copy(remainder, 0, offset, offset + available);
      }

      if (!isPaused && chunkQueue.length >= MAX_SNIPPET_CHUNKS) {
        decoder.stdout.pause();
        isPaused = true;
      }
    });

    decoder.stdout.on('end', () => { decoderFinished = true; });
    decoder.on('close', () => { decoderFinished = true; });
    decoder.on('error', () => { decoderFinished = true; });

    const pacingStartTime = Date.now();
    let bytesSent = 0;

    while (thisStreamId === this.currentStreamId && !this.isDestroyed) {
      if (chunkQueue.length > 0) {
        const chunk = chunkQueue.shift();
        this.encoder.feedPCM(chunk);
        bytesSent += CHUNK_SIZE;

        if (isPaused && chunkQueue.length <= 10) {
          if (decoder.stdout && !decoder.stdout.destroyed) {
            decoder.stdout.resume();
            isPaused = false;
          }
        }

        const audioDurationSentMs = (bytesSent / 176400) * 1000;
        const realTimeElapsedMs = Date.now() - pacingStartTime;
        const leadMs = audioDurationSentMs - realTimeElapsedMs;
        if (leadMs > 150) {
          await new Promise(r => setTimeout(r, leadMs - 150));
        }
      } else if (decoderFinished) {
        if (remainder && remainder.length >= 4) {
          const validLen = remainder.length - (remainder.length % 4);
          const chunk = Buffer.allocUnsafe(validLen);
          remainder.copy(chunk, 0, 0, validLen);
          this.encoder.feedPCM(chunk);
          bytesSent += validLen;
        }
        remainder = null;
        const remainingMs = ((bytesSent / 176400) * 1000) - (Date.now() - pacingStartTime);
        if (remainingMs > 0) {
          await new Promise(r => setTimeout(r, remainingMs + 100));
        }
        break;
      } else {
        await new Promise(r => setTimeout(r, 15));
      }
    }

    if (this.activeDecoder === decoder) {
      this.activeDecoder = null;
    }
    if (!decoder.killed) {
      try { decoder.kill('SIGKILL'); } catch (e) {}
    }

    if (!this.isPlaying && !this.isDestroyed) {
      this.encoder.resumeSilence();
    }

    return true;
  }

  // Prepares speech audio buffer for smooth ducked overlay
  async overlaySpeech(filePath, awaitCompletion = false) {
    if (this.isDestroyed || !filePath || !fs.existsSync(filePath)) return false;

    const ffmpegArgs = [
      '-threads', '1',
      '-vn', '-sn', '-dn',
      '-i', filePath,
      '-f', 's16le',
      '-ar', String(CONFIG.SAMPLE_RATE),
      '-ac', String(CONFIG.CHANNELS),
      'pipe:1'
    ];

    const proc = spawn(CONFIG.FFMPEG_PATH, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    const pcmData = await new Promise((resolve) => {
      const parts = [];
      proc.stdout.on('data', (d) => parts.push(d));
      proc.on('close', () => resolve(Buffer.concat(parts)));
      proc.on('error', () => resolve(null));
    });

    if (!pcmData || pcmData.length === 0) return false;

    const validLen = pcmData.length - (pcmData.length % 4);
    if (validLen <= 0) return false;
    const cleanPcm = Buffer.allocUnsafe(validLen);
    pcmData.copy(cleanPcm, 0, 0, validLen);
    const durationMs = (validLen / 176400) * 1000;

    // If song is currently playing, duck music in AudioPacer
    if (this.isPlaying) {
      this.voiceQueue = this.voiceQueue.length === 0
        ? cleanPcm
        : Buffer.concat([this.voiceQueue, cleanPcm]);
      if (awaitCompletion) {
        await new Promise(r => setTimeout(r, durationMs + 200));
      }
      return true;
    }

    // If silence / transition loop is active, duck transition lofi music!
    if (this.encoder && typeof this.encoder.overlayVoiceInSilence === 'function') {
      this.encoder.overlayVoiceInSilence(cleanPcm);
      if (awaitCompletion) {
        await new Promise(r => setTimeout(r, durationMs + 350));
      }
      return true;
    }

    return await this.playSnippet(filePath);
  }

  // Mix a 50ms music PCM chunk with any queued voice PCM (ducking music to 25%)
  mixDuckedChunk(musicChunk) {
    if (this.voiceQueue.length === 0 && this.duckMultiplier >= 1.0) {
      return musicChunk;
    }

    // Target duck level: 0.25 when voice is playing, 1.0 when idle
    const targetDuck = this.voiceQueue.length > 0 ? 0.25 : 1.0;
    if (this.duckMultiplier > targetDuck) {
      this.duckMultiplier = Math.max(targetDuck, this.duckMultiplier - 0.15);
    } else if (this.duckMultiplier < targetDuck) {
      this.duckMultiplier = Math.min(targetDuck, this.duckMultiplier + 0.15);
    }

    const chunkLen = musicChunk.length;
    const maxVoiceBytes = this.voiceQueue.length - (this.voiceQueue.length % 4);
    const voiceLen = Math.min(chunkLen, maxVoiceBytes);
    const mixed = Buffer.alloc(chunkLen);

    for (let i = 0; i < chunkLen; i += 2) {
      const musicSample = musicChunk.readInt16LE(i);
      const voiceSample = (i + 1 < voiceLen) ? this.voiceQueue.readInt16LE(i) : 0;
      
      const mixedSample = Math.max(-32768, Math.min(32767,
        Math.round((musicSample * this.duckMultiplier) + voiceSample)
      ));
      mixed.writeInt16LE(mixedSample, i);
    }

    if (voiceLen > 0) {
      if (this.voiceQueue.length <= voiceLen) {
        this.voiceQueue = Buffer.alloc(0);
      } else {
        const remainingLen = this.voiceQueue.length - voiceLen;
        const newBuf = Buffer.allocUnsafe(remainingLen);
        this.voiceQueue.copy(newBuf, 0, voiceLen, this.voiceQueue.length);
        this.voiceQueue = newBuf;
      }
    }

    return mixed;
  }

  async playTrack(filePath, metadata = {}, filterType = 'normal', volume = 100) {
    if (this.isDestroyed) return false;
    this.stopCurrentStream();
    const thisStreamId = ++this.currentStreamId;

    const CHUNK_SIZE = 8820; // 50ms of 44.1kHz 16-bit stereo PCM
    const TARGET_LEAD_MS = 600; // 600ms responsive lead cushion (under 100 KB memory)
    const MAX_QUEUED_CHUNKS = 30; // 30 chunks * 50ms = 1.5s max buffer (~264 KB)
    const RESUME_QUEUED_CHUNKS = 12; // 12 chunks = 600ms resume threshold

    const filterArgs = AudioFilters.getFilterArgs(filterType, volume);
    const ffmpegArgs = [
      '-threads', '1',
      '-vn', '-sn', '-dn',
      '-i', filePath,
      '-f', 's16le',
      '-ar', String(CONFIG.SAMPLE_RATE),
      '-ac', String(CONFIG.CHANNELS),
      ...filterArgs,
      'pipe:1'
    ];

    const decoder = spawn(CONFIG.FFMPEG_PATH, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.activeDecoder = decoder;

    const chunkQueue = [];
    let remainder = null;
    let isDecoderPaused = false;
    let decoderFinished = false;
    let lastDataTime = Date.now();
    let decoderStderr = '';

    if (decoder.stderr) {
      decoder.stderr.on('data', d => {
        decoderStderr += d.toString();
        if (decoderStderr.length > 1000) decoderStderr = decoderStderr.slice(-1000);
      });
    }

    decoder.stdout.on('data', (data) => {
      lastDataTime = Date.now();
      let offset = 0;
      let available = data.length;

      if (remainder && remainder.length > 0) {
        const needed = CHUNK_SIZE - remainder.length;
        if (available >= needed) {
          const fullChunk = Buffer.allocUnsafe(CHUNK_SIZE);
          remainder.copy(fullChunk, 0);
          data.copy(fullChunk, remainder.length, 0, needed);
          chunkQueue.push(fullChunk);
          offset += needed;
          available -= needed;
          remainder = null;
        } else {
          remainder = Buffer.concat([remainder, data]);
          return;
        }
      }

      while (available >= CHUNK_SIZE) {
        const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
        data.copy(chunk, 0, offset, offset + CHUNK_SIZE);
        chunkQueue.push(chunk);
        offset += CHUNK_SIZE;
        available -= CHUNK_SIZE;
      }

      if (available > 0) {
        remainder = Buffer.allocUnsafe(available);
        data.copy(remainder, 0, offset, offset + available);
      }

      if (!isDecoderPaused && chunkQueue.length >= MAX_QUEUED_CHUNKS) {
        decoder.stdout.pause();
        isDecoderPaused = true;
      }
    });

    decoder.stdout.on('end', () => { decoderFinished = true; });
    decoder.on('close', () => { decoderFinished = true; });
    decoder.on('error', (err) => {
      decoderFinished = true;
      console.error('❌ [AudioPacer] Decoder process error:', err.message);
    });

    // Initial pre-buffer: build a crisp 800ms cushion (16 chunks = 141 KB)
    const PRE_BUFFER_CHUNKS = 16;
    while (chunkQueue.length < PRE_BUFFER_CHUNKS && !decoderFinished) {
      if (thisStreamId !== this.currentStreamId || this.isDestroyed) {
        if (!decoder.killed) { try { decoder.kill('SIGKILL'); } catch (e) {} }
        return false;
      }
      await new Promise(r => setTimeout(r, 10));
    }

    if (thisStreamId !== this.currentStreamId || this.isDestroyed) {
      if (!decoder.killed) { try { decoder.kill('SIGKILL'); } catch (e) {} }
      return false;
    }
    if (chunkQueue.length === 0 && decoderFinished) {
      console.warn('⚠️ [AudioPacer] Decoder produced 0 bytes. Stderr:', decoderStderr.slice(-300) || 'None');
      return false;
    }

    // Playback active!
    this.isPlaying = true;
    this.currentTrack = metadata;
    this.playbackStartTime = Date.now();
    const pacingStartTime = Date.now();
    let bytesSent = 0;

    const expectedDurationSec = Number(metadata.durationSeconds || 0);
    const maxAllowedDurationMs = expectedDurationSec > 0 ? (expectedDurationSec + 8) * 1000 : 0;

    console.log(`🎵 [AudioPacer] Now playing: "${metadata.title || filePath}" (Filter: ${filterType})`);

    // Frame-aligned ultra-low memory pacing loop
    while (thisStreamId === this.currentStreamId && !this.isDestroyed) {
      if (chunkQueue.length > 0) {
        const chunk = chunkQueue.shift();
        const mixedChunk = this.mixDuckedChunk(chunk);
        this.encoder.feedPCM(mixedChunk);
        bytesSent += CHUNK_SIZE;

        if (isDecoderPaused && chunkQueue.length <= RESUME_QUEUED_CHUNKS) {
          if (decoder.stdout && !decoder.stdout.destroyed) {
            decoder.stdout.resume();
            isDecoderPaused = false;
          }
        }

        const audioDurationSentMs = (bytesSent / 176400) * 1000;
        const realTimeElapsedMs = Date.now() - pacingStartTime;
        const leadMs = audioDurationSentMs - realTimeElapsedMs;

        if (leadMs > TARGET_LEAD_MS) {
          await new Promise(r => setTimeout(r, leadMs - TARGET_LEAD_MS));
        }
      } else if (decoderFinished) {
        if (remainder && remainder.length >= 4) {
          const validLen = remainder.length - (remainder.length % 4);
          const chunk = Buffer.allocUnsafe(validLen);
          remainder.copy(chunk, 0, 0, validLen);
          const mixedChunk = this.mixDuckedChunk(chunk);
          this.encoder.feedPCM(mixedChunk);
          bytesSent += validLen;
        }
        remainder = null;
        break; // Track playback complete!
      } else {
        if (Date.now() - lastDataTime > 8000) {
          console.warn('⚠️ [AudioPacer] Decoder stalled for 8s. Ending track smoothly.');
          if (remainder && remainder.length >= 4) {
            const validLen = remainder.length - (remainder.length % 4);
            const chunk = Buffer.allocUnsafe(validLen);
            remainder.copy(chunk, 0, 0, validLen);
            this.encoder.feedPCM(this.mixDuckedChunk(chunk));
            bytesSent += validLen;
          }
          remainder = null;
          decoderFinished = true;
          break;
        }
        await new Promise(r => setTimeout(r, 10));
      }

      // Hard duration ceiling watchdog
      const realTimeElapsedMs = Date.now() - pacingStartTime;
      if (maxAllowedDurationMs > 0 && realTimeElapsedMs > maxAllowedDurationMs) {
        console.warn(`⏱️ [AudioPacer] Track exceeded duration ceiling (${expectedDurationSec}s). Finishing track.`);
        break;
      }
    }

    // Teardown local decoder cleanly
    if (this.activeDecoder === decoder) {
      this.activeDecoder = null;
    }
    if (!decoder.killed) {
      try { decoder.kill('SIGKILL'); } catch (e) {}
    }

    if (thisStreamId !== this.currentStreamId || this.isDestroyed) return false;

    // Await remaining cushion so final notes finish playing
    const totalTrackDurationMs = (bytesSent / 176400) * 1000;
    const remainingPlayTimeMs = Math.max(0, Math.min(2000, totalTrackDurationMs - (Date.now() - pacingStartTime)));
    if (remainingPlayTimeMs > 0) {
      await new Promise(r => setTimeout(r, remainingPlayTimeMs));
    }

    if (thisStreamId !== this.currentStreamId || this.isDestroyed) return false;

    console.log(`✅ [AudioPacer] Track completed: "${metadata.title || filePath}"`);
    this.isPlaying = false;
    this.playbackStartTime = 0;
    this.encoder.resumeSilence();
    return true; // Finished naturally!
  }

  getElapsedMs() {
    if (!this.isPlaying || this.playbackStartTime === 0) return 0;
    return Math.max(0, Date.now() - this.playbackStartTime);
  }
}
