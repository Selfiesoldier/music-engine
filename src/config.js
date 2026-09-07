import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Load environment variables
dotenv.config({ path: path.join(ROOT_DIR, '.env') });
dotenv.config();

let resolvedFfmpegPath = null;
function resolveFFmpeg() {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;

  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    resolvedFfmpegPath = process.env.FFMPEG_PATH;
    return resolvedFfmpegPath;
  }

  if (ffmpegStatic && typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) {
    try {
      if (process.platform !== 'win32') fs.chmodSync(ffmpegStatic, 0o755);
      resolvedFfmpegPath = ffmpegStatic;
      return resolvedFfmpegPath;
    } catch (e) {}
  }

  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) {
      resolvedFfmpegPath = out;
      return resolvedFfmpegPath;
    }
  } catch (e) {}

  const commonUnixPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
  for (const p of commonUnixPaths) {
    if (fs.existsSync(p)) {
      resolvedFfmpegPath = p;
      return resolvedFfmpegPath;
    }
  }

  resolvedFfmpegPath = 'ffmpeg';
  return resolvedFfmpegPath;
}

export const CONFIG = {
  ROOT_DIR,
  PORT: parseInt(process.env.PORT || process.env.SERVER_PORT || '30060', 10),
  HOST: process.env.HOST || '0.0.0.0',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin',
  API_SECRET: process.env.API_SECRET || process.env.API_KEY || '',
  SESSION_SECRET: process.env.SESSION_SECRET || 'musicbot_engine_secure_secret',
  
  // Audio specs
  BITRATE: process.env.AUDIO_BITRATE || '192k',
  SAMPLE_RATE: parseInt(process.env.AUDIO_SAMPLE_RATE || '44100', 10),
  CHANNELS: parseInt(process.env.AUDIO_CHANNELS || '2', 10),
  INITIAL_BURST_CHUNKS: parseInt(process.env.INITIAL_BURST_CHUNKS || '8', 10),
  MAX_BURST_BUFFER: parseInt(process.env.MAX_BURST_BUFFER_CHUNKS || '25', 10),
  
  // Storage & Cache
  CACHE_DIR: path.resolve(ROOT_DIR, process.env.CACHE_DIR || 'cache'),
  MAX_CACHE_SIZE_MB: parseInt(process.env.MAX_CACHE_SIZE_MB || '512', 10),
  MAX_TRACK_DURATION_SEC: parseInt(process.env.MAX_TRACK_DURATION_SEC || '900', 10),
  
  // Binary & Cookie paths
  FFMPEG_PATH: resolveFFmpeg(),
  COOKIES_FILE: process.env.COOKIES_FILE || 'cookies.master.txt',

  // Economy & VIP Settings
  SONG_COST_TICKETS: parseInt(process.env.SONG_COST_TICKETS || '1', 10),
  DEDICATION_COST_TICKETS: parseInt(process.env.DEDICATION_COST_TICKETS || '3', 10),
  VIP_COST_TICKETS: parseInt(process.env.VIP_COST_TICKETS || '50', 10),
  VIP_DURATION_DAYS: parseInt(process.env.VIP_DURATION_DAYS || '30', 10),
  DAILY_MIN_TICKETS: parseInt(process.env.DAILY_MIN_TICKETS || '1', 10),
  DAILY_MAX_TICKETS: parseInt(process.env.DAILY_MAX_TICKETS || '10', 10),

  // ElevenLabs Voice Integration
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB', // Adam (Classic DJ)
  ELEVENLABS_MODEL_ID: process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5' // Ultra-low latency model (~75ms)
};
