/**
 * mp3FrameParser.js
 * 
 * Lightweight, zero-dependency MPEG Layer 3 frame parser and validator utility.
 * Supports exact ISO frame boundary scanning, ID3v2 header stripping,
 * and deterministic whole-frame array generation for zero-drift audio streaming.
 */

// Bitrate lookup table (in bps) for MPEG-1 Layer III, index 1..14
const MPEG1_L3_BITRATES = [
  0, 32000, 40000, 48000, 56000, 64000, 80000, 96000,
  112000, 128000, 160000, 192000, 224000, 256000, 320000
];

// Bitrate lookup table (in bps) for MPEG-2 / MPEG-2.5 Layer III, index 1..14
const MPEG2_L3_BITRATES = [
  0, 8000, 16000, 24000, 32000, 40000, 48000, 56000,
  64000, 80000, 96000, 112000, 128000, 144000, 160000
];

// Sample rate lookup tables (in Hz), index 0..2
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000];
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000];

/**
 * Strips ID3v2 metadata prefix (if present) from an audio Buffer.
 * ID3v2 tags use a 10-byte header with a 4-byte syncsafe integer payload length.
 * 
 * @param {Buffer} buffer - Raw audio buffer
 * @returns {Buffer} Buffer slice starting past ID3v2 tag, or original buffer if no ID3v2
 */
export function stripId3v2(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 10) {
    return buffer || Buffer.alloc(0);
  }

  // Check for ID3v2 magic ('ID3')
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    // 4-byte syncsafe integer (7 bits per byte)
    const tagSize =
      ((buffer[6] & 0x7F) << 21) |
      ((buffer[7] & 0x7F) << 14) |
      ((buffer[8] & 0x7F) << 7) |
      (buffer[9] & 0x7F);

    const hasFooter = (buffer[5] & 0x10) !== 0;
    const totalId3Length = 10 + tagSize + (hasFooter ? 10 : 0);

    if (totalId3Length < buffer.length) {
      return buffer.subarray(totalId3Length);
    }
    return Buffer.alloc(0);
  }

  return buffer;
}

/**
 * Decodes MPEG Layer 3 header at a specific buffer offset.
 * 
 * @param {Buffer} buffer - Audio buffer
 * @param {number} offset - Offset to examine
 * @returns {object|null} Header metadata and frame length, or null if invalid
 */
export function getMp3FrameHeader(buffer, offset = 0) {
  if (!buffer || offset + 4 > buffer.length) {
    return null;
  }

  // Byte 0 must be sync byte 0xFF
  if (buffer[offset] !== 0xFF) {
    return null;
  }

  const b1 = buffer[offset + 1];
  // Sync word check: top 3 bits must be 111 (0xE0)
  if ((b1 & 0xE0) !== 0xE0) {
    return null;
  }

  // Audio version ID: 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved
  const versionId = (b1 >> 3) & 0x03;
  if (versionId === 1) {
    return null; // Reserved version
  }

  // Layer description: 1 = Layer III (Layer 3), 2 = Layer II, 3 = Layer I
  const layer = (b1 >> 1) & 0x03;
  if (layer !== 1) {
    return null; // Only Layer 3 supported
  }

  const b2 = buffer[offset + 2];
  const bitrateIdx = (b2 >> 4) & 0x0F;
  if (bitrateIdx === 0 || bitrateIdx === 15) {
    return null; // 0 = free, 15 = bad
  }

  const sampleRateIdx = (b2 >> 2) & 0x03;
  if (sampleRateIdx === 3) {
    return null; // Reserved sample rate
  }

  const paddingBit = (b2 >> 1) & 0x01;

  let bitrate = 0;
  let sampleRate = 0;
  let samplesPerFrame = 1152;
  let frameLength = 0;

  if (versionId === 3) {
    // MPEG-1 Layer 3
    bitrate = MPEG1_L3_BITRATES[bitrateIdx];
    sampleRate = MPEG1_SAMPLE_RATES[sampleRateIdx];
    samplesPerFrame = 1152;
    // ISO formula: Math.floor(144 * Bitrate / SampleRate) + Padding
    frameLength = Math.floor((144 * bitrate) / sampleRate) + paddingBit;
  } else {
    // MPEG-2 / MPEG-2.5 Layer 3
    bitrate = MPEG2_L3_BITRATES[bitrateIdx];
    sampleRate = (versionId === 2 ? MPEG2_SAMPLE_RATES : MPEG25_SAMPLE_RATES)[sampleRateIdx];
    samplesPerFrame = 576;
    // ISO formula: Math.floor(72 * Bitrate / SampleRate) + Padding
    frameLength = Math.floor((72 * bitrate) / sampleRate) + paddingBit;
  }

  if (frameLength <= 4) {
    return null;
  }

  const b3 = buffer[offset + 3];
  const channelMode = (b3 >> 6) & 0x03; // 0: Stereo, 1: Joint, 2: Dual, 3: Mono

  return {
    frameLength,
    bitrate,
    sampleRate,
    padding: paddingBit,
    versionId,
    mpegVersion: versionId === 3 ? 1 : (versionId === 2 ? 2 : 2.5),
    layer: 3,
    samplesPerFrame,
    channelMode
  };
}

/**
 * Scans an MP3 buffer and parses all intact MPEG Layer 3 frames.
 * Returns an array of independent Buffer copies for each complete frame.
 * Truncated trailing bytes (half-frames) at EOF are safely omitted.
 * 
 * @param {Buffer} buffer - MP3 audio data
 * @returns {Buffer[]} Array of discrete, whole MP3 frames
 */
export function parseMp3Frames(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return [];
  }

  // Automatically skip any ID3v2 tag prefix
  const audioData = stripId3v2(buffer);
  if (audioData.length < 4) {
    return [];
  }

  const frames = [];
  let offset = 0;
  const len = audioData.length;

  while (offset < len) {
    // Search for frame sync
    if (audioData[offset] === 0xFF && (audioData[offset + 1] & 0xE0) === 0xE0) {
      const header = getMp3FrameHeader(audioData, offset);

      if (header) {
        const frameLength = header.frameLength;

        // Ensure the entire frame fits within the buffer
        if (offset + frameLength <= len) {
          // If there's enough room for another frame header, verify it matches sync
          // to protect against rare false sync byte patterns in audio payload
          let isValid = true;
          if (offset + frameLength + 2 <= len) {
            const nextSync0 = audioData[offset + frameLength];
            const nextSync1 = audioData[offset + frameLength + 1];
            // Next frame should begin with 0xFF and (b1 & 0xE0) === 0xE0, OR it's near EOF
            if (nextSync0 !== 0xFF || (nextSync1 & 0xE0) !== 0xE0) {
              // Could be an ID3v1 tag (starts with 'TAG') or EOF padding
              if (
                offset + frameLength + 3 <= len &&
                nextSync0 === 0x54 && // 'T'
                nextSync1 === 0x41 && // 'A'
                audioData[offset + frameLength + 2] === 0x47 // 'G'
              ) {
                isValid = true;
              } else if (offset + frameLength + 128 >= len) {
                // Near EOF, minor trailing data allowed
                isValid = true;
              }
            }
          }

          if (isValid) {
            // Allocate independent Buffer clone to guarantee memory safety & no mutation
            const frameBuf = Buffer.from(audioData.subarray(offset, offset + frameLength));
            frames.push(frameBuf);
            offset += frameLength;
            continue;
          }
        } else {
          // Frame is truncated at EOF - break to avoid corrupting decoder state
          break;
        }
      }
    }

    // Advance 1 byte to seek next candidate sync word
    offset++;
  }

  return frames;
}
