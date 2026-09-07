import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

export class SilenceEngine {
  constructor(inputStream) {
    this.inputStream = inputStream;
    this.isFeeding = false;
    this.timerId = null;

    // 16-bit stereo PCM @ 44.1kHz: 44100 * 2 channels * 2 bytes = 176,400 bytes/sec
    const bytesPerSec = CONFIG.SAMPLE_RATE * CONFIG.CHANNELS * 2;
    this.chunkSize = Math.floor((bytesPerSec * 50) / 1000); // Exactly 8,820 bytes (50ms)
    this.targetLeadMs = 250; // 250ms lead cushion to absorb any timer jitter

    // Fallback static zero buffer
    this.SILENCE_50MS = Buffer.alloc(this.chunkSize, 0);

    // Seamless Intermission Background Music Loop
    this.transitionPcm = null;
    this.readOffset = 0;
    this.startTime = 0;
    this.bytesSent = 0;

    // Voice Overlay (Ducking transition music during speech)
    this.voiceQueue = Buffer.alloc(0);
    this.duckMultiplier = 1.0;

    this.loadTransitionTrack();
  }

  loadTransitionTrack() {
    try {
      const pcmPath = path.join(CONFIG.ROOT_DIR, 'assets', 'transition.pcm');
      if (fs.existsSync(pcmPath)) {
        const raw = fs.readFileSync(pcmPath);
        // Load max 20s of lofi loop (~3.5 MB) to preserve RAM in low-memory containers
        const maxBytes = 20 * 176400;
        const targetLen = Math.min(raw.length, maxBytes);
        const alignedLen = targetLen - (targetLen % this.chunkSize);
        this.transitionPcm = Buffer.allocUnsafe(alignedLen);
        raw.copy(this.transitionPcm, 0, 0, alignedLen);
        console.log(`☕ [TransitionEngine] Loaded seamless Lofi loop (${(this.transitionPcm.length / 1024 / 1024).toFixed(2)} MB, aligned to ${this.chunkSize} bytes)`);
      }
    } catch (e) {
      this.transitionPcm = null;
    }
  }

  get hasVoice() {
    return Boolean(this.voiceQueue && this.voiceQueue.length > 0);
  }

  get remainingVoiceDurationMs() {
    return this.voiceQueue ? (this.voiceQueue.length / 176400) * 1000 : 0;
  }

  overlayVoice(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length === 0) return;
    const alignedLen = pcmBuffer.length - (pcmBuffer.length % 4);
    if (alignedLen <= 0) return;
    const alignedBuffer = Buffer.allocUnsafe(alignedLen);
    pcmBuffer.copy(alignedBuffer, 0, 0, alignedLen);
    this.voiceQueue = this.voiceQueue.length === 0
      ? alignedBuffer
      : Buffer.concat([this.voiceQueue, alignedBuffer]);
  }

  startFeed() {
    if (this.isFeeding) return;
    this.isFeeding = true;
    this.startTime = Date.now();
    this.bytesSent = 0;

    const tick = () => {
      if (!this.isFeeding || !this.inputStream || this.inputStream.destroyed) return;

      try {
        const realElapsedMs = Date.now() - this.startTime;
        const audioDurationSentMs = (this.bytesSent / 176400) * 1000;
        const leadMs = audioDurationSentMs - realElapsedMs;

        // Keep a healthy ~250ms lead cushion ahead of wall-clock time
        if (leadMs < this.targetLeadMs) {
          const chunksNeeded = Math.min(8, Math.max(1, Math.ceil((this.targetLeadMs - leadMs) / 50)));

          for (let i = 0; i < chunksNeeded; i++) {
            let chunk = this.SILENCE_50MS;
            if (this.transitionPcm && this.transitionPcm.length >= this.chunkSize) {
              chunk = this.transitionPcm.subarray(this.readOffset, this.readOffset + this.chunkSize);
              this.readOffset += this.chunkSize;
              if (this.readOffset >= this.transitionPcm.length) {
                this.readOffset = 0; // Seamless loop wrap-around
              }
            }

            // Smooth Ducking & Voice Mixing
            if (this.voiceQueue.length > 0 || this.duckMultiplier < 1.0) {
              const targetDuck = this.voiceQueue.length > 0 ? 0.25 : 1.0;
              if (this.duckMultiplier > targetDuck) {
                this.duckMultiplier = Math.max(targetDuck, this.duckMultiplier - 0.15);
              } else if (this.duckMultiplier < targetDuck) {
                this.duckMultiplier = Math.min(targetDuck, this.duckMultiplier + 0.15);
              }

              const chunkLen = chunk.length;
              // Safe 4-byte aligned voice length check
              const maxVoiceBytes = this.voiceQueue.length - (this.voiceQueue.length % 4);
              const voiceLen = Math.min(chunkLen, maxVoiceBytes);
              const mixed = Buffer.alloc(chunkLen);

              for (let s = 0; s < chunkLen; s += 2) {
                const musicSample = chunk.readInt16LE(s);
                const voiceSample = (s + 1 < voiceLen) ? this.voiceQueue.readInt16LE(s) : 0;
                const mixedVal = Math.max(-32768, Math.min(32767,
                  Math.round((musicSample * this.duckMultiplier) + voiceSample)
                ));
                mixed.writeInt16LE(mixedVal, s);
              }

              if (voiceLen > 0) {
                if (this.voiceQueue.length <= voiceLen) {
                  this.voiceQueue = Buffer.alloc(0);
                } else {
                  const remLen = this.voiceQueue.length - voiceLen;
                  const newBuf = Buffer.allocUnsafe(remLen);
                  this.voiceQueue.copy(newBuf, 0, voiceLen, this.voiceQueue.length);
                  this.voiceQueue = newBuf;
                }
              }
              chunk = mixed;
            }

            try {
              this.inputStream.write(chunk);
              this.bytesSent += this.chunkSize;
            } catch (e) {
              break;
            }
          }
        }
      } catch (err) {
        console.error('⚠️ [SilenceEngine Tick Error]:', err.message);
      } finally {
        if (this.isFeeding && this.inputStream && !this.inputStream.destroyed) {
          this.timerId = setTimeout(tick, 40);
        }
      }
    };

    tick();
  }

  stopFeed() {
    this.isFeeding = false;
    this.voiceQueue = Buffer.alloc(0);
    this.duckMultiplier = 1.0;
    this.startTime = 0;
    this.bytesSent = 0;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  destroy() {
    this.stopFeed();
  }
}
