# Phase 7 Research: MP3 Frame Synchronization & Zero-Pause Transition Architecture

**Phase:** Phase 7 — Upstream Speech & TTS Normalization Pipeline  
**Date:** 2026-11-09  
**Status:** Complete ✅

---

## 1. Executive Summary & Root Cause Analysis

The reported issue in the Highrise audio streamer was an audible 500ms–1000ms pause or hiccup whenever a playing music track ended and transitioned to the idle background silence/lofi loop, as well as during speech/TTS announcements.

Our empirical investigation revealed that the root cause is **MPEG Layer 3 frame boundary violations**:
1. At 96 kbps CBR and 44.1 kHz stereo, MP3 frames are mathematically **313.469 bytes**.
2. Slicing with arbitrary byte counts (such as `CHUNK_SIZE = 1200` or a hardcoded `314`) cuts directly across frame headers (`0xFF 0xFB`).
3. When a song finishes at EOF, the final read delivers a truncated half-frame, immediately followed by silence frames starting with a new header. Client decoders flag a frame desync / CRC error, discard the corrupted packet, and mute for 500ms–1s while scanning for a valid sync sequence.

---

## 2. Mathematical & Empirical Frame Analysis

### MPEG-1 Layer 3 Frame Length Formula
$$\text{Frame Size (bytes)} = \left\lfloor \frac{144 \times \text{Bitrate}}{\text{Sample Rate}} \right\rfloor + \text{Padding Bit}$$

For our audio streamer:
- Bitrate = 96,000 bps
- Sample Rate = 44,100 Hz
$$\frac{144 \times 96000}{44100} = \frac{13824000}{44100} \approx 313.4693877$$

Therefore:
- When `Padding = 0`: Frame Size = **313 bytes**
- When `Padding = 1`: Frame Size = **314 bytes**

### Empirical Test on FFmpeg LAME Output
Testing a 2-second CBR 96k 44.1kHz stereo file produced:
- Total Frames: 78
- **313-byte frames:** 41 (52.6%)
- **314-byte frames:** 37 (47.4%)

### Why Hardcoding 314 Bytes Fails
If a fixed 314-byte chunk is read when a 313-byte frame is on disk:
- Chunk 1 takes the 313 bytes of Frame 1 + byte 0 of Frame 2 (`0xFF`).
- Chunk 2 starts at byte 1 of Frame 2 (`0xFB`), missing the sync word.
- Every unpadded frame drifts the read pointer by 1 byte, completely destroying frame synchronization within seconds.

---

## 3. Discovered Failure Modes in Current Codebase

### Failure Mode 1: Loop Wrap-Around Corruption (`cloud_persistentStreamManager.js`)
When `silenceOffset + CHUNK_SIZE > buffer.length`, the pointer resets to `0`. If the silence file is not an exact integer multiple of frames, the remainder (e.g. 450 bytes) is split, corrupting the frame boundary on every loop cycle (every 2–5 seconds).

### Failure Mode 2: EOF Half-Frame Cutoff (`cloud_audioPlayer.js`)
The last chunk read from an MP3 file at EOF is `fileSize % CHUNK_SIZE`. This trailing slice almost never aligns with the end of an MP3 frame. Blasting silence frames immediately afterwards causes decoders to mute while recovering from the partial frame.

### Failure Mode 3: Burst Buffer Mutation Bug (`cloud_audioPlayer.js`)
`readBuffer` is allocated once as `Buffer.allocUnsafe(1200)`. Slices pushed to `this.audioBuffer` via `broadcast()` share the same underlying memory. The next read tick mutates the buffer in place, corrupting the burst buffer for newly connected listeners.

### Failure Mode 4: TTS MPEG-2 Sample Rate Mismatch (`cache/tts/`)
Inspection of actual cached TTS MP3s revealed header `0xFF 0xF3` (MPEG-2 Layer 3 at 22.05 kHz or 24 kHz). Feeding MPEG-2 frames into an active MPEG-1 44.1 kHz stream causes browser decoders and Highrise voice clients to choke or freeze.

---

## 4. Architectural Fix Specification

### Plan 7.1: Pre-Parsed Frame Array for Silence Loop
1. Parse `silence_96k.mp3` once during `init()` into an array of discrete, intact `Buffer` frames.
2. In `startSilenceFeed()`, stream whole frames using an integer index `this.silenceFrameIndex++`.
3. Wrap-around seamlessly indexes back to `frame[0]`. Zero drift, zero sync loss.

### Plan 7.2: Clean EOF Frame Alignment & Buffer Isolation
1. In `cloud_audioPlayer.js`, detect the last complete MP3 frame boundary before EOF and discard any fractional trailing bytes.
2. Always clone audio chunks (`Buffer.from(slice)`) before pushing to the burst buffer.

### Plan 7.3: Strict 96k 44.1kHz TTS Transcoder & Fleet Deployment
1. Ensure TTS audio passed to `streamAnnouncementMp3` is normalized to MPEG-1 Layer 3 44.1kHz 96k CBR.
2. Deploy the hardened `persistentStreamManager.js` and `audioPlayer.js` to Room 1 (`00f50ae1`) and Room 2 (`4c1b3907`).
3. Verify live playback transitions with automated curl/health check script.
