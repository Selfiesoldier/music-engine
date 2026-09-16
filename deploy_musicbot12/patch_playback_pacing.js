import fs from 'fs';

const filePath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(filePath, 'utf8');

const targetStr = `  // Stream in steady, frame-aligned 50ms chunks using self-correcting lead cushion
  while (thisStreamId === currentStreamId) {
    // 1. If decoder has finished, drain remaining audio and EXIT cleanly
    if (decoderFinished) {
      if (pcmBuffer.length >= CHUNK_SIZE) {
        const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
        pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
        streamManager.feedPCMAudio(chunk);
        bytesSent += CHUNK_SIZE;
      } else {
        // Flush remaining audio aligned to 4 bytes (16-bit stereo frame = 4 bytes)
        if (pcmBuffer.length >= 4) {
          const validLen = pcmBuffer.length - (pcmBuffer.length % 4);
          const chunk = pcmBuffer.subarray(0, validLen);
          streamManager.feedPCMAudio(chunk);
          bytesSent += validLen;
        }
        pcmBuffer = Buffer.alloc(0);
        break; // All audio completely finished!
      }
    } else if (pcmBuffer.length >= CHUNK_SIZE) {
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
        const sleepMs = leadMs - TARGET_LEAD_MS;
        await new Promise(r => setTimeout(r, sleepMs));
      }
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
    }

    // 3. Duration limit watchdog: if playback exceeded expected duration + grace period
    const realTimeElapsedMs = Date.now() - pacingStartTime;
    if (maxAllowedDurationMs > 0 && realTimeElapsedMs > maxAllowedDurationMs) {
      console.warn(\`⏰ [Duration Watchdog] Song reached duration limit (\${expectedDurationSec}s + grace). Finishing track gracefully.\`);
      break;
    }
  }

  // Ensure decoder process is terminated immediately after loop
  if (currentDecoder) {
    try {
      if (currentDecoder.stdout && !currentDecoder.stdout.destroyed) currentDecoder.stdout.destroy();
      if (!currentDecoder.killed) currentDecoder.kill('SIGKILL');
    } catch (e) {}
    currentDecoder = null;
  }

  // If track was skipped or superseded, abort cleanly
  if (thisStreamId !== currentStreamId) {
    try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch (e) {}
    return;
  }

  // All bytes fed to persistent encoder. Await remaining lead cushion so listeners hear final notes.
  const totalTrackDurationMs = (bytesSent / 176400) * 1000;
  const remainingPlayTimeMs = Math.max(0, Math.min(2000, totalTrackDurationMs - (Date.now() - pacingStartTime)));
  if (remainingPlayTimeMs > 0) {
    await new Promise(r => setTimeout(r, remainingPlayTimeMs));
  }`;

const replacementStr = `  // Stream in steady, frame-aligned 50ms chunks using self-correcting lead cushion
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
    }

    // 3. Duration limit watchdog: if playback exceeded expected duration + grace period
    const realTimeElapsedMs = Date.now() - pacingStartTime;
    if (maxAllowedDurationMs > 0 && realTimeElapsedMs > maxAllowedDurationMs) {
      console.warn(\`⏰ [Duration Watchdog] Song reached duration limit (\${expectedDurationSec}s + grace). Finishing track gracefully.\`);
      break;
    }
  }

  // Ensure decoder process is terminated immediately after loop
  if (currentDecoder) {
    try {
      if (currentDecoder.stdout && !currentDecoder.stdout.destroyed) currentDecoder.stdout.destroy();
      if (!currentDecoder.killed) currentDecoder.kill('SIGKILL');
    } catch (e) {}
    currentDecoder = null;
  }

  // If track was skipped or superseded, abort cleanly
  if (thisStreamId !== currentStreamId) {
    try { if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch (e) {}
    return;
  }

  // All bytes fed to persistent encoder. Await remaining lead cushion so listeners hear final notes.
  const totalTrackDurationMs = (bytesSent / 176400) * 1000;
  const remainingPlayTimeMs = Math.max(0, totalTrackDurationMs - (Date.now() - pacingStartTime));
  if (remainingPlayTimeMs > 0) {
    await new Promise(r => setTimeout(r, Math.min(remainingPlayTimeMs, 3000)));
  }`;

if (!content.includes(targetStr)) {
  console.error('Target string not found in server.js!');
  process.exit(1);
}

content = content.replace(targetStr, replacementStr);
fs.writeFileSync(filePath, content, 'utf8');
console.log('✅ Successfully patched server.js playback pacing loop!');
