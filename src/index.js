import v8 from 'v8';
try {
  v8.setFlagsFromString('--max-old-space-size=160');
} catch (e) {}

// Automatic low-memory container watchdog
setInterval(() => {
  try {
    const mem = process.memoryUsage();
    if (global.gc && mem.heapUsed > 120 * 1024 * 1024) {
      global.gc();
    }
  } catch (e) {}
}, 20000);

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { CONFIG } from './config.js';
import { PersistentEncoder } from './audio/PersistentEncoder.js';
import { AudioPacer } from './audio/AudioPacer.js';
import { TrackDownloader } from './download/TrackDownloader.js';
import { QueueManager } from './queue/QueueManager.js';
import { TTSEngine } from './tts/TTSEngine.js';
import { TransitionManager } from './tts/TransitionManager.js';
import { EngineWebSocket } from './api/WebSocketServer.js';
import { TunnelManager } from './network/TunnelManager.js';
import { EconomyManager } from './economy/EconomyManager.js';
import { createRouter } from './api/routes.js';

// 1. Initialize Core Engine Modules
const encoder = new PersistentEncoder();
const pacer = new AudioPacer(encoder);
const downloader = new TrackDownloader();
const queueManager = new QueueManager();
const ttsEngine = new TTSEngine();
const transitionManager = new TransitionManager();
const tunnelManager = new TunnelManager(CONFIG.PORT);
const economyManager = new EconomyManager();

// Custom TTS Queue (plays between songs, never appears in music queue)
const customTtsQueue = [];

// 2. Startup Temp Cleanup
const startupCleanStats = downloader.audioCache.cleanTransients();
if (startupCleanStats.count > 0) {
  console.log(`🧹 [Startup Cleanup] Wiped ${startupCleanStats.count} incomplete download fragment(s) (${(startupCleanStats.bytes / 1024).toFixed(1)} KB) from cache/ on boot.`);
} else {
  console.log('✨ [Startup Cleanup] Cache directory clean (0 incomplete download fragments).');
}

// 3. Setup HTTP & WebSocket Servers
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(CONFIG.ROOT_DIR, 'public')));

const server = http.createServer(app);
const wsServer = new EngineWebSocket(server);

// 4. Orchestration Context
const context = {
  encoder,
  pacer,
  downloader,
  queueManager,
  ttsEngine,
  transitionManager,
  tunnelManager,
  wsServer,
  customTtsQueue,
  economyManager,

  // Custom TTS handler
  async queueOrSpeakCustomTts(text, voice = null, requester = 'User') {
    const selectedVoice = voice || queueManager.djVoice;
    const cleanText = String(text).trim().slice(0, 300);
    const item = {
      id: `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text: cleanText,
      voice: selectedVoice,
      requester,
      timestamp: Date.now()
    };

    // If a song is actively playing, queue it to play immediately when the song ends
    if (pacer.isPlaying) {
      customTtsQueue.push(item);
      console.log(`🎙️ [Custom TTS Queued] "${cleanText}" by ${requester} (Queue pos: ${customTtsQueue.length})`);
      wsServer.broadcast('custom_tts_queued', { item, queueLength: customTtsQueue.length });
      return { status: 'queued', position: customTtsQueue.length, item };
    }

    // Idle: speak immediately!
    console.log(`🎙️ [Custom TTS Immediate] "${cleanText}" by ${requester}`);
    try {
      const audioFile = await ttsEngine.synthesize(cleanText, selectedVoice);
      wsServer.broadcast('custom_tts_speaking', { item });
      await pacer.playSnippet(audioFile);
      return { status: 'speaking', item };
    } catch (err) {
      console.error('❌ [Custom TTS Error]:', err.message);
      return { status: 'error', error: err.message };
    }
  },

  async playNext(immediateTrack = null) {
    const track = immediateTrack || queueManager.getNext();
    if (!track) {
      queueManager.isPreparing = false;
      queueManager.preparingTrack = null;
      pacer.stopCurrentStream();
      wsServer.broadcast('queue_empty');
      return;
    }

    queueManager.isPreparing = true;
    queueManager.preparingTrack = track;
    wsServer.broadcast('track_preparing', { metadata: track });

    // 1. Start downloading the track in the background immediately!
    const downloadPromise = downloader.downloadTrack(track);

    // 1.5. Pre-synthesize DJ intro in parallel with download!
    let introPromise = null;
    if (queueManager.djIntroEnabled) {
      try {
        const introText = ttsEngine.getIntroText(track);
        introPromise = ttsEngine.synthesize(introText, queueManager.djVoice)
          .then(file => ({ file, text: introText }))
          .catch(() => null);
      } catch (e) {}
    }

    try {
      // 2. Play pending custom user TTS if explicitly requested via /tts
      if (customTtsQueue.length > 0) {
        const pendingTts = customTtsQueue.shift();
        try {
          console.log(`🎙️ [Custom TTS Between Songs] "${pendingTts.text}" (Voice: ${pendingTts.voice}, Requester: ${pendingTts.requester})`);
          wsServer.broadcast('custom_tts_speaking', { item: pendingTts });
          const audioFile = await ttsEngine.synthesize(pendingTts.text, pendingTts.voice);
          await pacer.overlaySpeech(audioFile, true);
        } catch (err) {
          console.error('❌ [Custom TTS Error]:', err.message);
        }
      }

      // 3. Await audio download
      const trackFilePath = await downloadPromise;

      wsServer.broadcast('track_started', {
        metadata: track,
        filter: queueManager.activeFilter
      });

      queueManager.isPreparing = false;
      queueManager.preparingTrack = null;
      queueManager.lastError = null;

      // 4. ⚡ Instant 0.0s Transitions: Pre-fetch next track in queue in background!
      const nextTrack = queueManager.peek();
      if (nextTrack) {
        console.log(`⚡ [Pre-fetch] Background caching next queued track: "${nextTrack.title}"...`);
        downloader.downloadTrack(nextTrack).catch(() => {});
      }

      // 5. Radio-Style DJ Intro: Speak OVER the opening beats of the song with music ducking!
      if (introPromise) {
        introPromise.then(intro => {
          if (intro?.file) {
            console.log(`🎙️ [DJ Intro Overlay] "${intro.text}" (Voice: ${queueManager.djVoice})`);
            wsServer.broadcast('dj_speaking', {
              text: intro.text,
              voice: queueManager.djVoice,
              mode: 'intro'
            });
            pacer.overlaySpeech(intro.file, false);
          }
        }).catch(() => {});
      }

      const finishedNaturally = await pacer.playTrack(
        trackFilePath,
        track,
        queueManager.activeFilter,
        queueManager.volume
      );

      if (finishedNaturally) {
        wsServer.broadcast('track_finished', { metadata: track });
        // Transition automatically to next song
        context.playNext();
      }
    } catch (err) {
      console.error(`❌ [Engine] Track preparation failed for "${track.title}":`, err.message);
      queueManager.lastError = { message: err.message, track: track.title, time: new Date().toISOString() };
      queueManager.isPreparing = false;
      queueManager.preparingTrack = null;
      wsServer.broadcast('track_error', { error: err.message, metadata: track });
      // Recover and advance
      setTimeout(() => context.playNext(), 2000);
    }
  },

  async speakAnnouncement(text, voice = null) {
    const selectedVoice = voice || queueManager.djVoice;
    try {
      const audioFile = await ttsEngine.synthesize(text, selectedVoice);
      wsServer.broadcast('dj_speaking', {
        text,
        voice: selectedVoice,
        mode: pacer.isPlaying ? 'ducked' : 'standalone'
      });
      return await pacer.overlaySpeech(audioFile);
    } catch (e) {
      console.error('❌ [TTS] Announcement failed:', e.message);
      return false;
    }
  },

  async playTrackDirectly(track, filter) {
    try {
      const trackFilePath = await downloader.downloadTrack(track);
      pacer.playTrack(trackFilePath, track, filter, queueManager.volume);
    } catch (e) {}
  }
};

// 5. Silence Transition TTS Loop
let isTransitioning = false;
setInterval(async () => {
  try {
    if (
      transitionManager.enabled &&
      !pacer.isPlaying &&
      !queueManager.isPreparing &&
      queueManager.size() === 0 &&
      !isTransitioning
    ) {
      const now = Date.now();
      if (now - transitionManager.lastTransitionTime >= transitionManager.intervalSeconds * 1000) {
        const phrase = transitionManager.getRandomPhrase();
        if (phrase) {
          isTransitioning = true;
          transitionManager.lastTransitionTime = now;
          console.log(`📻 [Transition TTS] "${phrase}" (Voice: ${queueManager.djVoice})`);
          wsServer.broadcast('transition_tts_speaking', {
            phrase,
            voice: queueManager.djVoice
          });
          const audioFile = await ttsEngine.synthesize(phrase, queueManager.djVoice);
          await pacer.overlaySpeech(audioFile);
          isTransitioning = false;
        }
      }
    }
  } catch (err) {
    isTransitioning = false;
    console.warn('⚠️ [Transition TTS Loop Error]:', err.message);
  }
}, 8000);

// 5.5. Ori Host / Pterodactyl Container Memory Guardian (prevents OOM on 512MB hosts)
setInterval(() => {
  try {
    downloader.audioCache.cleanTransients();
    if (typeof global.gc === 'function') {
      const heapBefore = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      global.gc();
      const heapAfter = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      if (heapBefore - heapAfter > 4) {
        console.log(`🧹 [Memory Guardian] GC collected ${heapBefore - heapAfter} MB (Heap: ${heapAfter} MB)`);
      }
    }
  } catch (e) {}
}, 5 * 60 * 1000);

// 5.6. Continuous Server Health & Listener Heartbeat Logger
setInterval(() => {
  try {
    const listenerCount = encoder.clients ? encoder.clients.size : 0;
    const peakListeners = encoder.stats ? encoder.stats.peakListeners : 0;
    const statusText = pacer.isPlaying
      ? `▶️ Playing: "${pacer.currentTrack?.title || 'Unknown'}" [${Math.floor(pacer.getElapsedMs() / 1000)}s]`
      : queueManager.isPreparing
        ? `⏳ Preparing: "${queueManager.preparingTrack?.title || 'Unknown'}"`
        : '💤 Idle (waiting for requests)';
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`📻 [Server Status] ${statusText} | Active Listeners: ${listenerCount} (Peak: ${peakListeners}) | Queue: ${queueManager.size()} | Memory: ${heapMb} MB`);
  } catch (e) {}
}, 30000);

// 6. Attach REST API Routes
app.use('/', createRouter(context));

// 7. Start Engine
server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  encoder.start();
  console.log(`\n======================================================`);
  console.log(`🚀 Highrise Music Engine v3.0 running on port ${CONFIG.PORT}`);
  console.log(`📻 Stream URL:  http://localhost:${CONFIG.PORT}/stream`);
  console.log(`🎛️ Dashboard:   http://localhost:${CONFIG.PORT}`);
  console.log(`⚡ WebSocket:   ws://localhost:${CONFIG.PORT}/ws`);
  console.log(`🎙️ DJ Voice:    ${queueManager.djVoice.toUpperCase()} (Intros: ${queueManager.djIntroEnabled ? 'ON' : 'OFF'})`);
  console.log(`📻 Transition:  ${transitionManager.enabled ? 'ON' : 'OFF'} (${transitionManager.phrases.length} phrases)`);
  console.log(`======================================================\n`);

  tunnelManager.start();

  // Auto-resume playback if server booted with songs pending in queue
  if (!pacer.isPlaying && queueManager.size() > 0) {
    console.log(`▶️ [Startup] Auto-resuming playback for ${queueManager.size()} queued song(s)...`);
    context.playNext();
  }
});

// 8. Robust Graceful Shutdown & Process Cleanup
let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) {
    console.log(`⚠️ [Engine] Subsequent ${signal} received. Forcing immediate termination.`);
    process.exit(1);
  }
  isShuttingDown = true;
  console.log(`[Engine] Received ${signal}. Initiating graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    console.warn('⚠️ [Engine] Teardown exceeded 2500ms safety timeout. Forcing exit.');
    process.exit(0);
  }, 2500);
  forceExitTimer.unref();

  try {
    if (server) {
      server.close(() => {
        console.log('🛑 [HTTP] HTTP server stopped accepting connections.');
      });
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    }

    wsServer.destroy();
    tunnelManager.stop();
    pacer.destroy();
    downloader.destroy();
    encoder.destroy();
    queueManager.saveState();
    transitionManager.saveState();
    economyManager.saveState();
    downloader.audioCache.cleanTransients();

    console.log('✅ [Engine] All child processes and resources cleanly terminated. Exiting 0.\n');
  } catch (err) {
    console.error('❌ [Engine] Error during graceful shutdown:', err);
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(0);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

process.on('uncaughtException', (err) => {
  console.error('🚨 [Fatal Uncaught Exception]:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 [Unhandled Promise Rejection]:', reason);
});