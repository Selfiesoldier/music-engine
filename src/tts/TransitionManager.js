import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

export class TransitionManager {
  constructor() {
    this.stateFilePath = path.join(CONFIG.ROOT_DIR, 'transition_state.json');
    this.enabled = true;
    this.intervalSeconds = 50; // Every 50 seconds of idle room
    this.phrases = [
      "hola amigo purchase our new bot at paul sanif",
      "You're listening to Highrise 24/7 Radio! Keep the party going!",
      "Highrise Radio! Non-stop beats and pure vibes.",
      "Stay on the dance floor, more music is coming right up!",
      "Shoutout to everyone in the room! Drop your favorite emote and vibe.",
      "Highrise live stream, spinning the freshest tracks in the metaverse. Type !play to request your favorite song!"
    ];
    this.lastTransitionTime = 0;
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.enabled === 'boolean') this.enabled = parsed.enabled;
        if (typeof parsed.intervalSeconds === 'number') this.intervalSeconds = parsed.intervalSeconds;
        if (Array.isArray(parsed.phrases) && parsed.phrases.length > 0) {
          this.phrases = parsed.phrases;
        }
      }
    } catch (e) {
      console.warn('[TransitionManager] Failed to load transition_state.json, using defaults.');
    }
  }

  saveState() {
    try {
      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify(
          {
            enabled: this.enabled,
            intervalSeconds: this.intervalSeconds,
            phrases: this.phrases
          },
          null,
          2
        )
      );
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (e) {
      console.error('[TransitionManager] Failed to save transition_state.json:', e.message);
    }
  }

  toggle(enabled) {
    if (typeof enabled === 'boolean') {
      this.enabled = enabled;
    } else {
      this.enabled = !this.enabled;
    }
    this.saveState();
    return this.enabled;
  }

  getPhrases() {
    return [...this.phrases];
  }

  addPhrase(phrase) {
    if (!phrase || typeof phrase !== 'string') return false;
    const clean = phrase.trim();
    if (!clean) return false;
    // Don't add exact duplicates
    if (!this.phrases.some(p => p.toLowerCase() === clean.toLowerCase())) {
      this.phrases.push(clean);
      this.saveState();
    }
    return true;
  }

  removePhrase(index) {
    const idx = Number(index) - 1; // 1-based index
    if (idx >= 0 && idx < this.phrases.length) {
      const removed = this.phrases.splice(idx, 1);
      this.saveState();
      return removed[0];
    }
    return null;
  }

  getRandomPhrase() {
    if (this.phrases.length === 0) return null;
    const idx = Math.floor(Math.random() * this.phrases.length);
    return this.phrases[idx];
  }

  setSinglePhrase(phrase) {
    if (!phrase || typeof phrase !== 'string') return false;
    const clean = phrase.trim();
    if (!clean) return false;
    this.phrases = [clean];
    this.saveState();
    return true;
  }

  clearPhrases() {
    this.phrases = [];
    this.saveState();
    return true;
  }

  resetDefaults() {
    this.phrases = [
      "hola amigo purchase our new bot at paul sanif",
      "You're listening to Highrise 24/7 Radio! Keep the party going!",
      "Highrise Radio! Non-stop beats and pure vibes.",
      "Stay on the dance floor, more music is coming right up!",
      "Shoutout to everyone in the room! Drop your favorite emote and vibe.",
      "Highrise live stream, spinning the freshest tracks in the metaverse. Type !play to request your favorite song!"
    ];
    this.saveState();
    return this.phrases;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      intervalSeconds: this.intervalSeconds,
      phraseCount: this.phrases.length,
      phrases: this.phrases
    };
  }
}
