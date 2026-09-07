import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

export class QueueManager {
  constructor() {
    this.queue = [];
    this.currentTrack = null;
    this.history = [];
    this.isPreparing = false;
    this.preparingTrack = null;
    this.activeFilter = 'normal';
    this.volume = 100;
    this.djIntroEnabled = true;
    this.djVoice = 'chris';
    this.stateFilePath = path.join(CONFIG.ROOT_DIR, 'queue_state.json');
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.queue = parsed;
        }
      }
    } catch (e) {}
  }

  saveState() {
    try {
      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.queue, null, 2));
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (e) {}
  }

  add(trackItem, toFront = false) {
    if (toFront) {
      this.queue.unshift(trackItem);
    } else {
      this.queue.push(trackItem);
    }
    this.saveState();
    return this.queue.length;
  }

  getNext() {
    const next = this.queue.shift();
    this.saveState();
    return next || null;
  }

  clear() {
    this.queue = [];
    this.isPreparing = false;
    this.preparingTrack = null;
    this.saveState();
  }

  getQueue() {
    return this.queue.map((item, index) => ({
      position: index + 1,
      ...item
    }));
  }

  size() {
    return this.queue.length;
  }

  purgeAutoplayTracks() {
    const originalLen = this.queue.length;
    this.queue = this.queue.filter(track => !track.isAutoplay);
    if (this.queue.length !== originalLen) {
      this.saveState();
      console.log(`🧹 [QueueManager] Purged ${originalLen - this.queue.length} autoplay track(s) for user request priority.`);
    }
  }

  setFilter(filterName) {
    this.activeFilter = filterName.toLowerCase();
    return this.activeFilter;
  }

  setDjConfig(enabled, voice) {
    if (typeof enabled === 'boolean') this.djIntroEnabled = enabled;
    if (voice && typeof voice === 'string') {
      const clean = voice.toLowerCase().trim();
      const ALLOWED = new Set([
        // Classic & Deep Hosts
        'adam', 'chris', 'brian', 'daniel', 'bill', 'arnold', 'sam', 'clyde', 'paul',
        // Female Hosts
        'rachel', 'jenny', 'bella', 'aria', 'sarah', 'jessica', 'lily', 'laura', 'matilda', 'glinda', 'elli', 'sonia', 'freya', 'serena', 'nicole', 'gigi',
        // Energetic & Dynamic Hosts
        'liam', 'josh', 'antoni', 'roger', 'callum', 'fin',
        // Smooth, Chill & British Hosts
        'george', 'ryan', 'charlie', 'guy', 'eric', 'river', 'will', 'michael', 'thomas', 'dave', 'james', 'joseph',
        // Google TTS Accents
        'us', 'american', 'uk', 'british', 'au', 'australian', 'in', 'indian',
        'es', 'spanish', 'fr', 'french', 'hi', 'hindi'
      ]);
      if (ALLOWED.has(clean) || (voice.length >= 15 && !clean.includes(' '))) {
        this.djVoice = clean;
      }
    }
    return { enabled: this.djIntroEnabled, voice: this.djVoice };
  }

  getDjConfig() {
    return { enabled: this.djIntroEnabled, voice: this.djVoice };
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(200, vol));
    return this.volume;
  }
}
