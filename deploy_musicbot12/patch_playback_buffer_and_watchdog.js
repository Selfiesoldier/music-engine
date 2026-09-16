import fs from 'fs';

const targetPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(targetPath, 'utf8');

// Patch 1: feedPCMAudioRealtime TARGET_LEAD_MS
const targetRealtime = `    const TARGET_LEAD_MS = 250;
    const chunkSize = 8820; // 50ms of 44.1kHz 16-bit stereo PCM`;
const replaceRealtime = `    const TARGET_LEAD_MS = 2500; // 2.5s lead cushion prevents buffer starvation
    const chunkSize = 8820; // 50ms of 44.1kHz 16-bit stereo PCM`;

if (!content.includes(targetRealtime)) {
  console.error('Target 1 (feedPCMAudioRealtime) not found!');
  process.exit(1);
}
content = content.replace(targetRealtime, replaceRealtime);

// Patch 2: Streaming loop, watchdog, buffer size, and lead cushion in startStream
const targetStreamBlock = `  // Maximum PCM buffer: 10 seconds (~1.76 MB), resume at 3 seconds (~528 KB)
  const MAX_ACCUM_BYTES = CHUNK_SIZE * 200;
  const RESUME_ACCUM_BYTES = CHUNK_SIZE * 60;

  let lastPcmReceivedAt = Date.now();

  currentDecoder.stdout.on('data', (chunk) => {
    lastPcmReceivedAt = Date.now();
    pcmBuffer = pcmBuffer.length === 0 ? chunk : Buffer.concat([pcmBuffer, chunk]);
    totalBytesDecoded += chunk.length;

    if (!isDecoderPaused && pcmBuffer.length >= MAX_ACCUM_BYTES) {
      currentDecoder.stdout.pause();
      isDecoderPaused = true;
    }
  });`;

const replaceStreamBlock = `  // Maximum PCM buffer: 30 seconds (~5.29 MB), resume at 10 seconds (~1.76 MB)
  const MAX_ACCUM_BYTES = CHUNK_SIZE * 600;
  const RESUME_ACCUM_BYTES = CHUNK_SIZE * 200;

  let lastPcmReceivedAt = Date.now();

  currentDecoder.stdout.on('data', (chunk) => {
    lastPcmReceivedAt = Date.now();
    pcmBuffer = pcmBuffer.length === 0 ? chunk : Buffer.concat([pcmBuffer, chunk]);
    totalBytesDecoded += chunk.length;

    if (!isDecoderPaused && pcmBuffer.length >= MAX_ACCUM_BYTES) {
      currentDecoder.stdout.pause();
      isDecoderPaused = true;
    }
  });`;

if (!content.includes(targetStreamBlock)) {
  console.error('Target 2 (MAX_ACCUM_BYTES) not found!');
  process.exit(1);
}
content = content.replace(targetStreamBlock, replaceStreamBlock);

// Patch 3: startStream loop TARGET_LEAD_MS and watchdog
const targetLoop = `  const TARGET_LEAD_MS = 250;
  const pacingStartTime = Date.now();
  let bytesSent = 0;

  const expectedDurationSec = (metadata && metadata.durationSeconds) 
    ? Number(metadata.durationSeconds) 
    : (currentMetadata && currentMetadata.durationSeconds ? Number(currentMetadata.durationSeconds) : 0);
  const maxAllowedDurationMs = expectedDurationSec > 0 ? (expectedDurationSec + 8) * 1000 : 0;

  console.log(\`🔊 [Playing] Continuous 1.0x frame-accurate playback active!\`);

  // Stream in steady, frame-aligned 50ms chunks using self-correcting lead cushion
  while (thisStreamId === currentStreamId) {
    if (pcmBuffer.length >= CHUNK_SIZE) {
      const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
      pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
      streamManager.feedPCMAudio(chunk);
      bytesSent += CHUNK_SIZE;

      if (isDecoderPaused && pcmBuffer.length <= RESUME_ACCUM_BYTES) {
        if (currentDecoder && currentDecoder.stdout && !currentDecoder.stdout.destroyed) {
          currentDecoder.stdout.resume();
          isDecoderPaused = false;
        }
      }

      // Maintain an exact 250ms lead cushion ahead of wall-clock real time
      const audioDurationSentMs = (bytesSent / 176400) * 1000;
      const realTimeElapsedMs = Date.now() - pacingStartTime;
      const leadMs = audioDurationSentMs - realTimeElapsedMs;

      if (leadMs > TARGET_LEAD_MS) {
        const sleepMs = Math.max(1, leadMs - TARGET_LEAD_MS);
        await new Promise(r => setTimeout(r, sleepMs));
      }
    } else if (decoderFinished) {
      // Decoder has finished and buffer has less than CHUNK_SIZE remaining
      if (pcmBuffer.length >= 4) {
        const validLen = pcmBuffer.length - (pcmBuffer.length % 4);
        const chunk = pcmBuffer.subarray(0, validLen);
        streamManager.feedPCMAudio(chunk);
        bytesSent += validLen;
      }
      pcmBuffer = Buffer.alloc(0);
      break; // All audio completely fed to persistent encoder!
    } else {
      // 2. Decoder stall watchdog: if no new data arrived for 8s and buffer is low
      if (Date.now() - lastPcmReceivedAt > 8000) {
        console.warn(\`⚠️ [Decoder Watchdog] Decoder stalled with no new audio for 8s. Finishing track.\`);
        if (pcmBuffer.length >= 4) {
          const validLen = pcmBuffer.length - (pcmBuffer.length % 4);
          streamManager.feedPCMAudio(pcmBuffer.subarray(0, validLen));
          bytesSent += validLen;
        }
        pcmBuffer = Buffer.alloc(0);
        decoderFinished = true;
        break;
      }

      // Waiting for decoder to fill next 50ms chunk
      await new Promise(r => setTimeout(r, 10));
    }`;

const replaceLoop = `  const TARGET_LEAD_MS = 2500; // 2.5s lead cushion keeps audio smooth during CPU spikes and searches
  const pacingStartTime = Date.now();
  let bytesSent = 0;

  const expectedDurationSec = (metadata && metadata.durationSeconds) 
    ? Number(metadata.durationSeconds) 
    : (currentMetadata && currentMetadata.durationSeconds ? Number(currentMetadata.durationSeconds) : 0);
  const maxAllowedDurationMs = expectedDurationSec > 0 ? (expectedDurationSec + 8) * 1000 : 0;

  console.log(\`🔊 [Playing] Continuous 1.0x frame-accurate playback active (2.5s lead cushion)!\`);

  // Stream in steady, frame-aligned 50ms chunks using self-correcting lead cushion
  while (thisStreamId === currentStreamId) {
    if (pcmBuffer.length >= CHUNK_SIZE) {
      const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
      pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
      streamManager.feedPCMAudio(chunk);
      bytesSent += CHUNK_SIZE;

      if (isDecoderPaused && pcmBuffer.length <= RESUME_ACCUM_BYTES) {
        if (currentDecoder && currentDecoder.stdout && !currentDecoder.stdout.destroyed) {
          currentDecoder.stdout.resume();
          isDecoderPaused = false;
          lastPcmReceivedAt = Date.now(); // Reset timer upon resuming stdout
        }
      }

      // Maintain a steady 2500ms lead cushion ahead of wall-clock real time
      const audioDurationSentMs = (bytesSent / 176400) * 1000;
      const realTimeElapsedMs = Date.now() - pacingStartTime;
      const leadMs = audioDurationSentMs - realTimeElapsedMs;

      if (leadMs > TARGET_LEAD_MS) {
        const sleepMs = Math.max(1, leadMs - TARGET_LEAD_MS);
        await new Promise(r => setTimeout(r, sleepMs));
      }
    } else if (decoderFinished) {
      // Decoder has finished and buffer has less than CHUNK_SIZE remaining
      if (pcmBuffer.length >= 4) {
        const validLen = pcmBuffer.length - (pcmBuffer.length % 4);
        const chunk = pcmBuffer.subarray(0, validLen);
        streamManager.feedPCMAudio(chunk);
        bytesSent += validLen;
      }
      pcmBuffer = Buffer.alloc(0);
      break; // All audio completely fed to persistent encoder!
    } else {
      // 2. Decoder stall watchdog: only check if decoder is unpaused, not finished, and buffer is truly starved
      if (isDecoderPaused) {
        lastPcmReceivedAt = Date.now(); // Never count paused buffering time as a stall
      } else if (!decoderFinished && Date.now() - lastPcmReceivedAt > 15000) {
        console.warn(\`⚠️ [Decoder Watchdog] Decoder stalled with no new audio for 15s. Finishing track.\`);
        if (pcmBuffer.length >= 4) {
          const validLen = pcmBuffer.length - (pcmBuffer.length % 4);
          streamManager.feedPCMAudio(pcmBuffer.subarray(0, validLen));
          bytesSent += validLen;
        }
        pcmBuffer = Buffer.alloc(0);
        decoderFinished = true;
        break;
      }

      // Waiting for decoder to fill next 50ms chunk
      await new Promise(r => setTimeout(r, 10));
    }`;

if (!content.includes(targetLoop)) {
  console.error('Target 3 (targetLoop) not found!');
  process.exit(1);
}
content = content.replace(targetLoop, replaceLoop);

// Patch 4: MemoryGuard interval - run every 2 minutes and only GC if critical
const targetMemoryGuard = `// 🛡️ High-Frequency Memory Guard & Aggressive Garbage Collection
setInterval(() => {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch (e) {}
  }
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
  // Only log if RSS exceeds 100MB as an early warning
  if (mem.rss > 100 * 1024 * 1024) {
    console.warn(\`⚠️ [MemoryGuard] Elevated Node memory: RSS \${rssMb}MB, Heap \${heapMb}MB - running cleanup...\`);
    pruneStaleCacheFiles(currentLocalFilePath);
    if (typeof global.gc === 'function') global.gc();
  }
}, 30000);`;

const replaceMemoryGuard = `// 🛡️ Memory Guard - Periodically check memory without stalling the audio thread
setInterval(() => {
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
  // Only trigger GC and cache cleanup if memory is critically high (> 380MB RSS or > 160MB heap)
  if (mem.rss > 380 * 1024 * 1024 || mem.heapUsed > 160 * 1024 * 1024) {
    console.warn(\`⚠️ [MemoryGuard] Critically elevated Node memory: RSS \${rssMb}MB, Heap \${heapMb}MB - running cleanup...\`);
    pruneStaleCacheFiles(currentLocalFilePath);
    if (typeof global.gc === 'function') {
      try {
        global.gc();
      } catch (e) {}
    }
  }
}, 120000);`;

if (!content.includes(targetMemoryGuard)) {
  console.error('Target 4 (targetMemoryGuard) not found!');
  process.exit(1);
}
content = content.replace(targetMemoryGuard, replaceMemoryGuard);

// Write patched server.js
fs.writeFileSync(targetPath, content, 'utf8');
console.log('✅ All 4 patches successfully applied to server.js!');
