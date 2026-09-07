import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { SmartTitleParser } from '../utils/SmartTitleParser.js';

let MsEdgeTTS = null;
let OUTPUT_FORMAT = null;
try {
  const edgePkg = await import('msedge-tts');
  MsEdgeTTS = edgePkg.MsEdgeTTS;
  OUTPUT_FORMAT = edgePkg.OUTPUT_FORMAT;
} catch (e) {
  console.warn('⚠️ [TTSEngine] msedge-tts not installed or unavailable. Voice announcements will be skipped cleanly.');
}

export class TTSEngine {
  constructor() {
    this.cacheDir = path.join(CONFIG.CACHE_DIR, 'tts');
    this.voices = {
      chris: 'en-US-ChristopherNeural', // Classic deep radio DJ
      jenny: 'en-US-JennyNeural',       // Crisp modern female DJ
      ryan: 'en-GB-RyanNeural',         // British radio host
      sonia: 'en-GB-SoniaNeural',       // British female
      guy: 'en-US-GuyNeural',           // Casual friendly male
      aria: 'en-US-AriaNeural'          // Natural articulate female
    };
    this.currentElevenKeyIndex = 0;
    this.elevenLabsEnabled = true;
    this.init();
  }

  setElevenLabsEnabled(enabled) {
    this.elevenLabsEnabled = !!enabled;
    return this.elevenLabsEnabled;
  }

  getElevenLabsStatus() {
    const keys = this.getElevenLabsKeys();
    return {
      enabled: this.elevenLabsEnabled && keys.length > 0,
      configured: keys.length > 0,
      activeKeyIndex: this.currentElevenKeyIndex,
      totalKeys: keys.length
    };
  }

  getElevenLabsKeys() {
    const raw = CONFIG.ELEVENLABS_API_KEY || '';
    return raw.split(',').map(k => k.trim()).filter(Boolean);
  }

  init() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  getAvailableVoices() {
    return Object.keys(this.voices);
  }

  resolveVoice(key) {
    if (!key) return this.voices.chris;
    const lower = String(key).toLowerCase().trim();
    return this.voices[lower] || this.voices.chris;
  }

  getIntroText(metadata = {}) {
    const cleaned = SmartTitleParser.clean(metadata.title, metadata.artist);
    const title = cleaned.title;
    const artist = cleaned.artist ? `by ${cleaned.artist}` : '';
    const requester = metadata.requester && metadata.requester.toLowerCase() !== 'user'
      ? metadata.requester
      : null;
    const dedicatedTo = metadata.dedicatedTo ? String(metadata.dedicatedTo).replace(/^@/, '') : null;

    if (dedicatedTo && requester) {
      return `Now playing ${title} ${artist}, specially dedicated to ${dedicatedTo} by ${requester}. Turn it up!`.trim();
    }
    if (dedicatedTo) {
      return `Now playing ${title} ${artist}, with a special dedication to ${dedicatedTo}. Enjoy the vibes!`.trim();
    }

    if (metadata.isAutoplay) {
      return `Up next on the stream: ${title} ${artist}.`.trim();
    }

    if (requester) {
      return `Now playing ${title} ${artist}, requested by ${requester}.`.trim();
    }

    return `Now playing ${title} ${artist}.`.trim();
  }

  getNowPlayingText(metadata = {}) {
    const cleaned = SmartTitleParser.clean(metadata.title, metadata.artist);
    const title = cleaned.title;
    const artist = cleaned.artist ? `by ${cleaned.artist}` : '';
    const requester = metadata.requester && metadata.requester.toLowerCase() !== 'user'
      ? metadata.requester
      : null;

    if (requester) {
      return `You're listening to ${title} ${artist}, put on by ${requester}.`.trim();
    }

    return `You're listening to ${title} ${artist}.`.trim();
  }

  async synthesizeElevenLabs(text, voiceKey = 'adam') {
    const keys = this.getElevenLabsKeys();
    if (keys.length === 0) return null;

    const elevenVoiceMap = {
      // Classic Radio & Deep Hosts
      adam: 'pNInz6obpgDQGcFmaJgB',     // Classic deep radio DJ
      chris: 'pNInz6obpgDQGcFmaJgB',    // Alias to Adam
      brian: 'nPczCjzI2devNBz1zQrb',    // Deep resonant BBC radio narrator
      daniel: 'onwK4e9ZLuTAKqWW03F9',   // Deep authoritative news/radio broadcaster
      bill: 'pqHfZKP75CvOlQylNhV4',     // Trustworthy mature radio host
      arnold: 'VR6AewLTigWG4xSOukaG',   // Deep cinematic action narrator
      sam: 'yoZ06aMxZJJ28mfd3POQ',      // Dynamic raspy male DJ
      clyde: '2EiwWnXFnvU5JabPnv8n',    // Gritty character male
      paul: '5Q0t7uMcjKitnx2GQsvF',     // Authoritative reporter

      // Warm, Energetic & Pop Female Hosts
      rachel: '21m00Tcm4TlvDq8ikWAM',   // Warm energetic female DJ
      jenny: '21m00Tcm4TlvDq8ikWAM',    // Alias to Rachel
      bella: 'EXAVITQu4vr4xnSDxMaL',    // Expressive bright female DJ
      aria: 'EXAVITQu4vr4xnSDxMaL',     // Alias to Bella
      sarah: 'AZnzlk1XvdvUeBnXmlld',    // Confident modern station DJ
      jessica: 'cgSgspJ2msm6clMCkdW9',  // Expressive upbeat American female
      lily: 'pFZP5JQG7iQjIQuC4Bku',     // Warm velvety British female
      laura: 'FGY2WhTYpPnrIDTdsKH5',    // Sunny upbeat female
      matilda: 'XrExE9yKIg1WjnnlVkGX',  // Warm soothing female
      glinda: 'z9fAnlkpzviPz146aGWa',   // Warm lively female
      elli: 'MF3mGyEYCl7XYWbV9V6O',     // Playful British female
      sonia: 'MF3mGyEYCl7XYWbV9V6O',    // Alias to Elli
      freya: 'jsCqWAovK2LkecY7zXl4',    // Expressive young female
      serena: 'pMsXgVXv3BLzUgSXRplE',   // Articulate pleasant female
      nicole: 'piTKgcLEGmPE4e6mEKli',   // Gentle soft female
      gigi: 'jBpfuIE2acCO8z3wKNLl',     // Cute lively female

      // Energetic, Club & Dynamic Male Hosts
      liam: 'TX3LPaxmHKxFdv7VOQHJ',     // Young confident club DJ
      josh: 'TxGEqnHWrfWFTfGW9XjX',     // Young dynamic male
      antoni: 'ErXwobaYiN019PkySvjV',   // Professional dynamic host
      roger: 'CwhRBWXzGAHq8TQ4Fs17',    // Hype energetic radio announcer
      callum: 'N2lVS1w4EtoT3dr4eOWO',   // Intense character male
      fin: 'D38z5RcWu1voky8WS1ja',      // Energetic Irish male

      // Smooth, Chill & British Hosts
      george: 'JBFqnCBsd6RMkjVDRZzb',   // Warm British male
      ryan: 'JBFqnCBsd6RMkjVDRZzb',     // Alias to George
      charlie: 'IKne3meq5aSn9XLyUdCD',  // Casual relaxed male
      guy: 'IKne3meq5aSn9XLyUdCD',      // Alias to Charlie
      eric: 'cjVigY5qzO86Huf0OWal',     // Conversational friendly male
      river: 'SAz9YHcvj6GT2YYXdXww',    // Mellow late-night chillout host
      will: 'bIHbv24MWmeRgasZH58o',     // Warm friendly male
      michael: 'flq6f7yk4E4fJM5XTYuZ',  // Soft natural American male
      thomas: 'GBv7mTt0atIp3Br8iCZE',   // Calm storyteller male
      dave: 'CYw3kZ02Hs0563khs1Fj',     // Conversational British male
      james: 'ZQe5CZNOzWyzPSCn5a3c',    // Calm Australian male
      joseph: 'Zlb1dXrM653N07WRdFW3'    // Polite British male
    };

    const cleanKey = String(voiceKey || '').toLowerCase().trim();
    // Allow direct custom 20+ character Voice ID
    const voiceId = (voiceKey && voiceKey.length >= 15 && !cleanKey.includes(' '))
      ? voiceKey.trim()
      : (elevenVoiceMap[cleanKey] || CONFIG.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB');

    const modelId = CONFIG.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    const fetch = globalThis.fetch || (await import('node-fetch')).default;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const keyIndex = (this.currentElevenKeyIndex + attempt) % keys.length;
      const apiKey = keys[keyIndex];

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
          },
          body: JSON.stringify({
            text: text.slice(0, 300),
            model_id: modelId,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8
            }
          }),
          signal: AbortSignal.timeout(6000)
        });

        if (res.ok) {
          this.currentElevenKeyIndex = keyIndex;
          const arrayBuffer = await res.arrayBuffer();
          return Buffer.from(arrayBuffer);
        }

        const errText = await res.text().catch(() => '');
        console.warn(`⚠️ [TTSEngine] ElevenLabs Key #${keyIndex + 1}/${keys.length} failed (${res.status}): ${errText.slice(0, 80)}`);

        // If quota exceeded or unauthorized, rotate to next key
        if (res.status === 401 || res.status === 429 || errText.toLowerCase().includes('quota')) {
          console.warn(`🔄 [TTSEngine] Rotating to next ElevenLabs key in pool...`);
          continue;
        }

        throw new Error(`ElevenLabs HTTP ${res.status}: ${errText.slice(0, 80)}`);
      } catch (err) {
        if (attempt === keys.length - 1) throw err;
      }
    }
    return null;
  }

  async synthesizeGoogleTTS(text, voiceKey = 'chris') {
    const googleLangMap = {
      // US English
      chris: 'en-US',
      guy: 'en-US',
      jenny: 'en-US',
      aria: 'en-US',
      adam: 'en-US',
      josh: 'en-US',
      us: 'en-US',
      american: 'en-US',
      // British English
      ryan: 'en-GB',
      sonia: 'en-GB',
      george: 'en-GB',
      uk: 'en-GB',
      british: 'en-GB',
      // Australian English
      au: 'en-AU',
      australian: 'en-AU',
      // Indian English
      in: 'en-IN',
      indian: 'en-IN',
      // Other Languages & Accents
      ca: 'en-CA',
      canadian: 'en-CA',
      es: 'es-ES',
      spanish: 'es-ES',
      fr: 'fr-FR',
      french: 'fr-FR',
      hi: 'hi-IN',
      hindi: 'hi-IN',
      ja: 'ja-JP',
      japanese: 'ja-JP'
    };

    const cleanKey = String(voiceKey || '').toLowerCase().trim();
    // Allow direct BCP-47 tag like "en-AU" or "es-MX"
    const lang = (cleanKey.includes('-') && cleanKey.length <= 6)
      ? cleanKey
      : (googleLangMap[cleanKey] || 'en-US');

    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodeURIComponent(text.slice(0, 250))}`;
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!res.ok) throw new Error(`Google TTS HTTP error: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async synthesize(text, voiceKey = 'chris') {
    if (!text || typeof text !== 'string') throw new Error('Text is required');

    const hasElevenLabs = this.elevenLabsEnabled && this.getElevenLabsKeys().length > 0;
    const voicePrefix = hasElevenLabs ? '11labs' : 'gtts';
    const hash = crypto.createHash('md5').update(`${voicePrefix}_${voiceKey}_${text.trim()}`).digest('hex');
    const outputPath = path.join(this.cacheDir, `${hash}.mp3`);

    // 0. Cache HIT (Instant 0.0s replay, saves ElevenLabs characters & quota!)
    if (fs.existsSync(outputPath)) {
      try {
        const stats = fs.statSync(outputPath);
        if (stats.size > 1000) {
          return outputPath;
        }
      } catch (e) {}
    }

    // 1. Tier 1: ElevenLabs Ultra-Realistic AI DJ (if configured in .env)
    if (hasElevenLabs) {
      try {
        const audioBuffer = await this.synthesizeElevenLabs(text.trim(), voiceKey);
        if (audioBuffer && audioBuffer.length > 500) {
          fs.writeFileSync(outputPath, audioBuffer);
          return outputPath;
        }
      } catch (elErr) {
        console.warn(`⚠️ [TTSEngine] ElevenLabs error: ${elErr.message}, smoothly falling back to Google TTS...`);
      }
    }

    // 2. Tier 2: Lightning-fast Google TTS (Pure HTTPS, ultra-low latency, zero quota costs)
    try {
      const audioBuffer = await this.synthesizeGoogleTTS(text.trim(), voiceKey);
      if (audioBuffer && audioBuffer.length > 500) {
        fs.writeFileSync(outputPath, audioBuffer);
        return outputPath;
      }
    } catch (gErr) {
      console.warn(`⚠️ [TTSEngine] Google TTS failed: ${gErr.message}`);
    }

    return null;
  }
}

