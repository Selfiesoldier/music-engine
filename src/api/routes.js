import express from 'express';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';
import { AudioFilters } from '../audio/AudioFilters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SFX_DIR = path.resolve(__dirname, '../../assets/sfx');


export function createRouter(context) {
  const router = express.Router();
  const {
    encoder,
    pacer,
    downloader,
    queueManager,
    ttsEngine,
    transitionManager,
    tunnelManager,
    wsServer,
    economyManager
  } = context;

  // 🛡️ API Key Authentication Middleware
  const requireAuth = (req, res, next) => {
    if (!CONFIG.API_SECRET) return next();

    const authHeader = req.headers['authorization'];
    let token = null;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.headers['x-api-key']) {
      token = String(req.headers['x-api-key']).trim();
    } else if (req.query && (req.query.token || req.query.apiKey)) {
      token = String(req.query.token || req.query.apiKey).trim();
    }

    if (!token || token !== CONFIG.API_SECRET) {
      return res.status(401).json({
        error: 'Unauthorized: Invalid or missing API key',
        hint: 'Pass header "Authorization: Bearer <key>" or "x-api-key: <key>"'
      });
    }

    next();
  };

  // Auth Status & Verification Endpoints
  router.get('/api/auth/status', (req, res) => {
    res.json({
      authRequired: Boolean(CONFIG.API_SECRET)
    });
  });

  router.get('/api/auth/verify', requireAuth, (req, res) => {
    res.json({ status: 'ok', authenticated: true });
  });

  // ==========================================
  // PUBLIC ENDPOINTS (No API Key Required)
  // ==========================================

  // 1. Live Continuous MP3 Audio Stream
  router.get('/stream', (req, res) => {
    encoder.addClient(req, res);
  });

  // Helper to resolve public URL dynamically if running behind reverse proxy
  const resolvePublicUrl = (req) => {
    let url = tunnelManager ? tunnelManager.getPublicUrl() : null;
    if (!url && req) {
      const host = req.get('x-forwarded-host') || req.get('host');
      const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
      if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
        url = `${proto}://${host}`;
        if (tunnelManager) tunnelManager.setPublicUrl(url);
      }
    }
    return url;
  };

  // 2. Fast Status Snapshot (Highrise Bot & Dashboard polling)
  router.get('/current', (req, res) => {
    const track = pacer.currentTrack || queueManager.preparingTrack;
    const pubUrl = resolvePublicUrl(req);
    res.json({
      title: track ? track.title : (queueManager.isPreparing ? 'Preparing track...' : 'Waiting for song...'),
      isPlaying: pacer.isPlaying,
      isPreparing: queueManager.isPreparing,
      filter: queueManager.activeFilter,
      volume: queueManager.volume,
      djConfig: queueManager.getDjConfig(),
      transitionStatus: transitionManager ? transitionManager.getStatus() : null,
      customTtsPending: context.customTtsQueue ? context.customTtsQueue.length : 0,
      publicUrl: pubUrl,
      publicStreamUrl: pubUrl ? `${pubUrl}/stream` : (tunnelManager ? tunnelManager.getStreamUrl() : null),
      metadata: track,
      startTime: pacer.playbackStartTime,
      serverElapsed: pacer.getElapsedMs(),
      queueLength: queueManager.size(),
      streamHealth: encoder.getHealth(),
      authRequired: Boolean(CONFIG.API_SECRET)
    });
  });

  // Real-time Event Stream (SSE)
  router.get('/api/events', (req, res) => {
    wsServer.addSSEClient(req, res);
  });

  // Diagnostic endpoint to debug yt-dlp on Render
  router.get('/api/debug-download', async (req, res) => {
    try {
      const isVersionOnly = req.query.versionOnly === 'true' || req.query.fast === 'true';
      const bin = downloader.resolvedYtdlpPath;
      
      let binStat = null;
      let headSample = '';
      try {
        if (fs.existsSync(bin)) {
          const st = fs.statSync(bin);
          binStat = { size: st.size, mode: st.mode.toString(8) };
          headSample = fs.readFileSync(bin, { encoding: 'utf-8', flag: 'r' }).slice(0, 150);
        }
      } catch (e) {
        binStat = { error: e.message };
      }

      // Test 1: Run python3 directly
      const python3Version = await new Promise((res) => {
        try {
          const p = spawn('python3', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
          let o = '';
          const t = setTimeout(() => { try { p.kill(); } catch (e) {} res({ timeout: true }); }, 3000);
          p.stdout.on('data', d => o += d.toString());
          p.on('close', c => { clearTimeout(t); res({ code: c, out: o.trim() }); });
          p.on('error', e => { clearTimeout(t); res({ error: e.message }); });
        } catch (e) { res({ error: e.message }); }
      });

      // Test 2: Run yt-dlp directly
      const directYtdlp = await new Promise((res) => {
        try {
          const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
          let o = '';
          let err = '';
          const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} res({ timeout: true, out: o.trim(), err: err.trim() }); }, 4000);
          p.stdout.on('data', d => o += d.toString());
          p.stderr.on('data', d => err += d.toString());
          p.on('close', c => { clearTimeout(t); res({ code: c, out: o.trim(), err: err.trim() }); });
          p.on('error', e => { clearTimeout(t); res({ error: e.message }); });
        } catch (e) { res({ error: e.message }); }
      });

      const envInfo = {
        platform: process.platform,
        nodeVersion: process.version,
        ffmpeg: CONFIG.FFMPEG_PATH,
        ffmpegExists: fs.existsSync(CONFIG.FFMPEG_PATH),
        ytdlpPath: bin,
        ytdlpStat: binStat,
        ytdlpHead: headSample.slice(0, 80),
        hasCookies: Boolean(downloader.cookieShield.findMasterCookieFile())
      };

      if (isVersionOnly) {
        return res.json({
          ok: true,
          env: envInfo,
          python3: python3Version,
          directYtdlp: directYtdlp
        });
      }

      const q = req.query.q || 'Kaun Talha';
      const meta = await downloader.resolveMetadata(q);
      let dlResult = null;
      try {
        const dlPath = await downloader._executeDownload(meta, false);
        dlResult = { success: true, dlPath };
      } catch (dlErr) {
        dlResult = { success: false, error: dlErr.message };
      }

      res.json({
        ok: true,
        env: envInfo,
        python3: python3Version,
        directYtdlp: directYtdlp,
        metadata: meta,
        downloadAttempt: dlResult
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stack: e.stack });
    }
  });

  // Dedicated test download endpoint with real-time stdout/stderr capture
  router.get('/api/test-download', async (req, res) => {
    try {
      const videoId = req.query.id || 'dQw4w9WgXcQ';
      const bin = downloader.resolvedYtdlpPath;
      const tempPath = `/tmp/test_${Date.now()}.m4a`;
      const args = [
        '-f', 'ba/b/best',
        '--no-warnings',
        '--extractor-args', 'youtube:player_client=android',
        '-o', tempPath,
        `https://youtube.com/watch?v=${videoId}`
      ];

      const t0 = Date.now();
      const result = await new Promise((resolve) => {
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const t = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) {}
          resolve({ timeout: true, stdout, stderr, elapsedSec: (Date.now() - t0) / 1000 });
        }, 20000);

        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', code => {
          clearTimeout(t);
          const exists = fs.existsSync(tempPath);
          const size = exists ? fs.statSync(tempPath).size : 0;
          try { if (exists) fs.unlinkSync(tempPath); } catch (e) {}
          resolve({ code, stdout, stderr, fileCreated: exists, fileSize: size, elapsedSec: (Date.now() - t0) / 1000 });
        });
        proc.on('error', err => {
          clearTimeout(t);
          resolve({ error: err.message, elapsedSec: (Date.now() - t0) / 1000 });
        });
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // 3. Queue status
  router.get('/api/queue', (req, res) => {
    res.json({
      currentlyPlaying: pacer.currentTrack,
      isPlaying: pacer.isPlaying,
      queue: queueManager.getQueue(),
      queueLength: queueManager.size()
    });
  });

  // 8. Available Filters
  router.get('/api/filters', (req, res) => {
    res.json({
      activeFilter: queueManager.activeFilter,
      available: AudioFilters.getAvailableFilters()
    });
  });

  // 9. DJ Voice Configuration Status
  router.get('/api/tts/status', (req, res) => {
    res.json({
      ...queueManager.getDjConfig(),
      availableVoices: ttsEngine ? ttsEngine.getAvailableVoices() : []
    });
  });

  // 12. Public Tunnel Info (Highrise integration endpoint)
  router.get('/api/tunnel', (req, res) => {
    const pubUrl = resolvePublicUrl(req);
    const streamUrl = pubUrl ? `${pubUrl}/stream` : (tunnelManager ? tunnelManager.getStreamUrl() : null);
    res.json({
      active: Boolean(pubUrl),
      publicUrl: pubUrl,
      streamUrl: streamUrl
    });
  });

  // 13. Health Check
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      health: encoder.getHealth(),
      dj: queueManager.getDjConfig(),
      transition: transitionManager ? transitionManager.getStatus() : null,
      customTtsQueueLength: context.customTtsQueue?.length || 0,
      authRequired: Boolean(CONFIG.API_SECRET),
      tunnel: {
        active: Boolean(tunnelManager?.getPublicUrl()),
        publicUrl: tunnelManager ? tunnelManager.getPublicUrl() : null,
        streamUrl: tunnelManager ? tunnelManager.getStreamUrl() : null
      }
    });
  });

  // 14. Real-time Lyrics Search (Free LRCLIB API)
  router.get('/api/lyrics', async (req, res) => {
    try {
      const query = (req.query.q || req.query.query || '').trim();
      let trackName = '';
      let artistName = '';

      if (query) {
        trackName = query;
      } else if (pacer.currentTrack) {
        trackName = pacer.currentTrack.title || '';
        artistName = pacer.currentTrack.artist || '';
      }

      if (!trackName) {
        return res.status(400).json({ error: 'No query provided and no track currently playing' });
      }

      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${trackName} ${artistName}`.trim())}`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'HighriseMusicEngine/3.0' }
      });

      if (!searchRes.ok) {
        return res.status(404).json({ error: 'Lyrics not found' });
      }

      const results = await searchRes.json();
      if (!Array.isArray(results) || results.length === 0) {
        return res.status(404).json({ error: 'Lyrics not found for this track' });
      }

      const best = results[0];
      res.json({
        title: best.trackName,
        artist: best.artistName,
        album: best.albumName,
        plainLyrics: best.plainLyrics || null,
        syncedLyrics: best.syncedLyrics || null,
        instrumental: best.instrumental || false
      });
    } catch (e) {
      res.status(500).json({ error: 'Lyrics service error: ' + e.message });
    }
  });

  // ==========================================
  // PROTECTED CONTROL ENDPOINTS (API Key Required)
  // ==========================================

  // 4. Play / Queue Track
  router.post('/api/play', requireAuth, async (req, res) => {
    const { query, isAutoplay = false, requester = 'User', userId = null, dedicatedTo = null, maxDuration = 0, isExempt = false } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Query is required' });

    const isAuto = Boolean(isAutoplay);
    const isDedicated = Boolean(dedicatedTo);
    const exempt = Boolean(isExempt);

    // 💰 Economy Check (If userId is provided and not autoplay)
    let economyCheck = null;
    if (economyManager && userId && !isAuto) {
      economyCheck = economyManager.checkSongRequest(userId, isDedicated, exempt);
      if (!economyCheck.allowed) {
        return res.status(402).json({
          error: economyCheck.error,
          cost: economyCheck.cost,
          balance: economyCheck.balance,
          needed: economyCheck.needed,
          isVip: false
        });
      }
    }

    // 🛡️ Guard 1: Autoplay MUST NEVER interrupt an active track, preparing track, or non-empty queue
    if (isAuto && (pacer.isPlaying || queueManager.isPreparing || queueManager.size() > 0)) {
      return res.status(409).json({
        error: 'Autoplay rejected: active track, preparation, or user queue in progress.',
        isPlaying: pacer.isPlaying,
        isPreparing: queueManager.isPreparing,
        queueLength: queueManager.size()
      });
    }

    try {
      const metadata = await downloader.resolveMetadata(query);
      if (!metadata) return res.status(404).json({ error: 'Song not found' });

      metadata.requester = requester;
      metadata.userId = userId ? String(userId) : null;
      metadata.isAutoplay = isAuto;
      metadata.dedicatedTo = dedicatedTo ? String(dedicatedTo).trim().replace(/^@/, '') : null;

      // Duration limit guard
      const maxDur = Number(maxDuration) || 0;
      if (maxDur > 0 && metadata.durationSeconds && metadata.durationSeconds > maxDur) {
        return res.status(400).json({
          error: 'Song exceeds maximum allowed duration limit',
          duration: metadata.duration,
          durationSeconds: metadata.durationSeconds,
          maxDuration: maxDur,
          title: metadata.title
        });
      }

      // 🛡️ Guard 2: Post-resolution check for autoplay (in case state changed during metadata fetch)
      if (isAuto && (pacer.isPlaying || queueManager.isPreparing || queueManager.size() > 0)) {
        return res.status(409).json({
          error: 'Autoplay rejected: playback started while resolving metadata.'
        });
      }

      // 👑 User Priority: Purge any lingering autoplay tracks from queue so human requests play next
      if (!metadata.isAutoplay) {
        queueManager.purgeAutoplayTracks();
      }

      // 💰 Deduct tickets once track is accepted for queue/playback
      if (economyManager && userId && !isAuto) {
        economyManager.chargeSongRequest(userId, isDedicated, metadata.title, exempt);
      }

      const economyStatus = (economyManager && userId && !isAuto) ? {
        ticketsDeducted: economyCheck ? economyCheck.cost : 0,
        balance: economyManager.getBalance(userId).tickets,
        newBalance: economyManager.getBalance(userId).tickets,
        isVip: economyManager.isUserVip(userId),
        isExempt: Boolean(economyCheck?.isExempt)
      } : null;

      // If actively playing or preparing a track, queue it behind the current track
      if (pacer.isPlaying || queueManager.isPreparing) {
        const pos = queueManager.add(metadata);
        wsServer.broadcast('queue_updated', { queue: queueManager.getQueue() });
        downloader.downloadTrack(metadata).catch(() => {});
        return res.json({ status: 'queued', position: pos, metadata, economy: economyStatus });
      }

      // If idle but queue already has songs, add to queue and kick off playback immediately!
      if (queueManager.size() > 0) {
        const pos = queueManager.add(metadata);
        wsServer.broadcast('queue_updated', { queue: queueManager.getQueue() });
        downloader.downloadTrack(metadata).catch(() => {});
        res.json({ status: 'playing', metadata: queueManager.peek() || metadata, economy: economyStatus });
        context.playNext(); // 🚀 Kick off playback of the queue!
        return;
      }

      // Completely idle with empty queue: start playback immediately
      res.json({ status: 'playing', metadata, economy: economyStatus });
      context.playNext(metadata);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Skip Track
  router.post('/api/skip', requireAuth, (req, res) => {
    const currentTitle = pacer.currentTrack?.title || queueManager.preparingTrack?.title || 'Unknown';
    queueManager.isPreparing = false;
    queueManager.preparingTrack = null;
    if (downloader && typeof downloader.abortAll === 'function') {
      downloader.abortAll();
    }
    pacer.stopCurrentStream();
    context.playNext();
    res.json({ status: 'skipped', skippedTrack: currentTitle });
  });

  // 6. Stop Track & Clear Queue
  router.post('/api/stop', requireAuth, (req, res) => {
    queueManager.clear();
    queueManager.isPreparing = false;
    queueManager.preparingTrack = null;
    if (downloader && typeof downloader.abortAll === 'function') {
      downloader.abortAll();
    }
    pacer.stopCurrentStream();
    wsServer.broadcast('playback_stopped');
    res.json({ status: 'stopped', message: 'Playback stopped and queue cleared' });
  });

  // 7. Toggle / Set Audio Filter
  router.post('/api/filter', requireAuth, (req, res) => {
    const { filter } = req.body || {};
    const available = AudioFilters.getAvailableFilters();
    if (!filter || !available.includes(filter.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid filter', available });
    }

    const applied = queueManager.setFilter(filter);
    wsServer.broadcast('filter_changed', { filter: applied });

    if (pacer.isPlaying && pacer.currentTrack) {
      const track = pacer.currentTrack;
      context.playTrackDirectly(track, applied);
    }

    res.json({ status: 'success', activeFilter: applied });
  });

  // ==========================================
  // TTS 1: Song Intro TTS Toggle
  // ==========================================

  router.post('/api/tts/intro', requireAuth, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled === 'boolean') {
      queueManager.djIntroEnabled = enabled;
    } else {
      queueManager.djIntroEnabled = !queueManager.djIntroEnabled;
    }
    wsServer.broadcast('dj_config_updated', queueManager.getDjConfig());
    res.json({ status: 'success', introEnabled: queueManager.djIntroEnabled });
  });

  router.get('/api/tts/intro', (req, res) => {
    res.json({ introEnabled: queueManager.djIntroEnabled, voice: queueManager.djVoice });
  });

  // DJ Voice Configuration
  router.post('/api/tts/config', requireAuth, (req, res) => {
    const { enabled, voice } = req.body || {};
    const updated = queueManager.setDjConfig(enabled, voice);
    wsServer.broadcast('dj_config_updated', updated);
    res.json({ status: 'success', config: updated });
  });

  // ElevenLabs Toggle & Status
  router.get('/api/tts/elevenlabs', (req, res) => {
    res.json(ttsEngine.getElevenLabsStatus());
  });

  router.post('/api/tts/elevenlabs', requireAuth, (req, res) => {
    const { enabled } = req.body || {};
    let newState = typeof enabled === 'boolean' ? enabled : !ttsEngine.elevenLabsEnabled;
    ttsEngine.setElevenLabsEnabled(newState);
    const status = ttsEngine.getElevenLabsStatus();
    wsServer.broadcast('elevenlabs_status_updated', status);
    res.json({ status: 'success', elevenlabs: status });
  });

  // ==========================================
  // TTS 2: Custom TTS (Queues between songs if playing; immediate if idle)
  // ==========================================

  router.post('/api/tts/custom', requireAuth, async (req, res) => {
    const { text, voice, requester = 'User' } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text string is required' });
    }

    const result = await context.queueOrSpeakCustomTts(text, voice, requester);
    res.json(result);
  });

  router.get('/api/tts/custom/queue', (req, res) => {
    res.json({
      queueLength: context.customTtsQueue ? context.customTtsQueue.length : 0,
      queue: context.customTtsQueue || []
    });
  });

  router.post('/api/tts/custom/clear', requireAuth, (req, res) => {
    const cleared = context.customTtsQueue ? context.customTtsQueue.splice(0, context.customTtsQueue.length) : [];
    res.json({ status: 'success', clearedCount: cleared.length });
  });

  // Standalone/ducked immediate announcement
  router.post('/api/announce-current', requireAuth, async (req, res) => {
    const track = pacer.currentTrack;
    if (!track) {
      return res.json({
        isPlaying: false,
        message: 'No song is currently playing on the stream.',
        spoken: false
      });
    }

    const speechText = ttsEngine.getNowPlayingText(track);
    context.speakAnnouncement(speechText, req.body?.voice);

    res.json({
      isPlaying: true,
      title: track.title,
      artist: track.artist,
      requester: track.requester || 'User',
      speechText,
      spoken: true
    });
  });

  router.post('/api/tts/speak', requireAuth, async (req, res) => {
    const { text, voice } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text string is required' });
    }

    const cleanText = text.slice(0, 300);
    const success = await context.speakAnnouncement(cleanText, voice);
    res.json({ status: success ? 'speaking' : 'error', text: cleanText });
  });

  // ==========================================
  // TTS 3: Transition TTS (Plays during silence as station bumpers)
  // ==========================================

  router.get('/api/tts/transition', (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    res.json(transitionManager.getStatus());
  });

  router.post('/api/tts/transition/toggle', requireAuth, (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    const { enabled } = req.body || {};
    const newState = transitionManager.toggle(enabled);
    wsServer.broadcast('transition_config_updated', transitionManager.getStatus());
    res.json({ status: 'success', enabled: newState });
  });

  router.post('/api/tts/transition/add', requireAuth, (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    const { phrase } = req.body || {};
    if (!phrase || typeof phrase !== 'string') {
      return res.status(400).json({ error: 'Phrase string is required' });
    }
    const success = transitionManager.addPhrase(phrase);
    if (!success) {
      return res.status(400).json({ error: 'Could not add phrase' });
    }
    res.json({
      status: 'success',
      added: phrase.trim(),
      phrases: transitionManager.getPhrases()
    });
  });

  router.post('/api/tts/transition/remove', requireAuth, (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    const { index, phrase } = req.body || {};
    let removed = null;
    if (index !== undefined && !isNaN(Number(index))) {
      removed = transitionManager.removePhrase(Number(index));
    } else if (phrase && typeof phrase === 'string') {
      const list = transitionManager.getPhrases();
      const matchIdx = list.findIndex(p => p.toLowerCase() === phrase.toLowerCase().trim());
      if (matchIdx !== -1) {
        removed = transitionManager.removePhrase(matchIdx + 1);
      }
    }

    if (!removed) {
      return res.status(404).json({ error: 'Transition phrase not found at specified index or text' });
    }

    res.json({
      status: 'success',
      removed,
      phrases: transitionManager.getPhrases()
    });
  });

  router.post('/api/tts/transition/set', requireAuth, (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    const { phrase } = req.body || {};
    if (!phrase || typeof phrase !== 'string') {
      return res.status(400).json({ error: 'Phrase string is required' });
    }
    const success = transitionManager.setSinglePhrase(phrase);
    res.json({
      status: 'success',
      activePhrase: phrase.trim(),
      phrases: transitionManager.getPhrases()
    });
  });

  router.post('/api/tts/transition/clear', requireAuth, (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    transitionManager.clearPhrases();
    res.json({ status: 'success', phrases: [] });
  });

  router.post('/api/tts/transition/reset', requireAuth, (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    const phrases = transitionManager.resetDefaults();
    res.json({ status: 'success', phrases });
  });

  router.post('/api/tts/transition/test', requireAuth, async (req, res) => {
    if (!transitionManager) return res.status(503).json({ error: 'Transition manager not initialized' });
    const phrase = transitionManager.getRandomPhrase();
    if (!phrase) {
      return res.status(400).json({ error: 'No transition phrase configured' });
    }
    const audioFile = await ttsEngine.synthesize(phrase, queueManager.djVoice);
    await pacer.overlaySpeech(audioFile);
    res.json({ status: 'playing', phrase, voice: queueManager.djVoice });
  });

  // 15. Set Volume Level (0 - 200%)
  router.post('/api/volume', requireAuth, (req, res) => {
    const { volume } = req.body || {};
    if (volume === undefined || isNaN(Number(volume))) {
      return res.status(400).json({ error: 'Volume number (0-200) is required' });
    }

    const applied = queueManager.setVolume(Number(volume));
    wsServer.broadcast('volume_changed', { volume: applied });

    if (pacer.isPlaying && pacer.currentTrack) {
      context.playTrackDirectly(pacer.currentTrack, queueManager.activeFilter);
    }

    res.json({ status: 'success', volume: applied });
  });


  // 16. Soundboard / Live DJ SFX Drops
  const SFX_MAP = {
    'airhorn': 'airhorn.mp3',
    'horn': 'airhorn.mp3',
    'scratch': 'scratch.mp3',
    'cheer': 'cheer.mp3',
    'applause': 'cheer.mp3',
    'bassdrop': 'bassdrop.mp3',
    'drop': 'bassdrop.mp3',
    'boom': 'bassdrop.mp3',
    'drumroll': 'drumroll.mp3',
    'roll': 'drumroll.mp3'
  };

  router.get('/api/sfx', (req, res) => {
    res.json({
      available: ['airhorn', 'scratch', 'cheer', 'bassdrop', 'drumroll']
    });
  });

  router.post('/api/sfx', requireAuth, async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        error: 'SFX name is required',
        available: ['airhorn', 'scratch', 'cheer', 'bassdrop', 'drumroll']
      });
    }

    const key = name.toLowerCase().trim();
    const fileName = SFX_MAP[key];
    if (!fileName) {
      return res.status(404).json({
        error: `Unknown SFX: "${name}"`,
        available: ['airhorn', 'scratch', 'cheer', 'bassdrop', 'drumroll']
      });
    }

    const sfxPath = path.join(SFX_DIR, fileName);
    if (!fs.existsSync(sfxPath)) {
      return res.status(404).json({ error: `SFX file missing on server: ${fileName}` });
    }

    console.log(`🎛️ [SFX Drop] "${key}" triggered over stream!`);
    const played = await pacer.overlaySpeech(sfxPath, false);
    wsServer.broadcast('sfx_triggered', { name: key, file: fileName });
    res.json({ status: played ? 'success' : 'error', sfx: key });
  });

  // ==========================================
  // 17. ECONOMY & TICKET SYSTEM ENDPOINTS
  // ==========================================

  // Economy System Configuration
  router.get('/api/economy/config', (req, res) => {
    res.json({
      currency: 'tickets',
      goldRate: '1 gold = 1 ticket',
      songCost: CONFIG.SONG_COST_TICKETS || 1,
      dedicationCost: CONFIG.DEDICATION_COST_TICKETS || 3,
      vipTiers: [
        { tier: 1, goldOrTickets: 100, days: 7, label: '7 Days VIP' },
        { tier: 2, goldOrTickets: 200, days: 15, label: '15 Days VIP' },
        { tier: 3, goldOrTickets: 300, days: 60, label: '2 Months (60 Days) VIP' }
      ],
      dailyMinTickets: CONFIG.DAILY_MIN_TICKETS || 1,
      dailyMaxTickets: CONFIG.DAILY_MAX_TICKETS || 10
    });
  });

  // Get User Balance & VIP Status
  router.get('/api/economy/balance/:userId', (req, res) => {
    if (!economyManager) return res.status(503).json({ error: 'Economy manager not available' });
    const { userId } = req.params;
    const balance = economyManager.getBalance(userId);
    if (!balance) return res.status(404).json({ error: 'User not found' });
    res.json(balance);
  });

  // Process Gold Tip: 1 Gold = 1 Ticket
  router.post('/api/economy/tip', requireAuth, (req, res) => {
    if (!economyManager) return res.status(503).json({ error: 'Economy manager not available' });
    const { userId, goldAmount, gold, username } = req.body || {};
    const amount = Number(goldAmount !== undefined ? goldAmount : gold);

    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Valid goldAmount number is required' });
    }

    const result = economyManager.processTip(userId, amount, username);
    if (!result.success) return res.status(400).json(result);

    wsServer.broadcast('economy_tip_received', result);
    res.json(result);
  });

  // Admin Give Points / Tickets (Specific user or all users)
  router.post('/api/economy/give', requireAuth, (req, res) => {
    if (!economyManager) return res.status(503).json({ error: 'Economy manager not available' });
    const { userId, target, amount, reason = 'admin_gift', username = '' } = req.body || {};
    const qty = Math.max(1, parseInt(amount || '0', 10));

    if (!qty || qty <= 0) {
      return res.status(400).json({ error: 'Valid amount greater than 0 is required' });
    }

    // Give to all users if target === 'all'
    if (target === 'all' || userId === 'all') {
      const userIds = Object.keys(economyManager.data.users);
      let count = 0;
      for (const uid of userIds) {
        economyManager.addTickets(uid, qty, reason);
        count++;
      }
      wsServer.broadcast('economy_tickets_gifted_all', { amount: qty, recipientCount: count });
      return res.json({ success: true, target: 'all', count, amount: qty });
    }

    // Give to specific user
    const targetId = String(userId || target).trim();
    if (!targetId) {
      return res.status(400).json({ error: 'Target userId is required' });
    }

    const newBal = economyManager.addTickets(targetId, qty, reason, username);
    wsServer.broadcast('economy_tickets_gifted', { userId: targetId, username, amount: qty, newBalance: newBal });
    res.json({ success: true, userId: targetId, amount: qty, newBalance: newBal, balance: newBal });
  });

  // Claim Daily Reward: 1 to 10 random tickets every 24h
  router.post('/api/economy/daily', requireAuth, (req, res) => {
    if (!economyManager) return res.status(503).json({ error: 'Economy manager not available' });
    const { userId, username } = req.body || {};

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const result = economyManager.claimDaily(userId, username);
    if (result.cooldown) {
      return res.status(429).json(result);
    }
    if (!result.success) {
      return res.status(400).json(result);
    }

    wsServer.broadcast('economy_daily_claimed', {
      userId,
      username: username || userId,
      reward: result.reward,
      newBalance: result.newBalance
    });
    res.json(result);
  });

  // Admin VIP Set/Toggle
  router.post('/api/economy/vip/set', requireAuth, (req, res) => {
    if (!economyManager) return res.status(503).json({ error: 'Economy manager not available' });
    const { userId, isVip = true, durationDays = 0, username } = req.body || {};

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const result = economyManager.setVip(userId, isVip, durationDays, username);
    wsServer.broadcast('economy_vip_updated', result);
    res.json({ status: 'success', ...result });
  });

  // Buy VIP Pass using Tickets (Tiers: 100 tickets -> 7d, 200 -> 15d, 300 -> 60d)
  router.post('/api/economy/vip/buy', requireAuth, (req, res) => {
    if (!economyManager) return res.status(503).json({ error: 'Economy manager not available' });
    const { userId, tier = null, costTickets = null, durationDays = null } = req.body || {};

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const selection = tier !== null ? tier : (costTickets !== null ? costTickets : 100);
    const result = economyManager.buyVip(userId, selection, durationDays);
    if (!result.success) {
      return res.status(400).json(result);
    }

    wsServer.broadcast('economy_vip_purchased', result);
    res.json(result);
  });

  // Leaderboard (Top Tippers / Ticket Holders)
  router.get('/api/economy/leaderboard', (req, res) => {
    if (!economyManager) return res.status(503).json({ error: 'Economy manager not available' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
    res.json({
      leaderboard: economyManager.getLeaderboard(limit)
    });
  });

  return router;

}
