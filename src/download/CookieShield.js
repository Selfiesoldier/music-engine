import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

export class CookieShield {
  constructor() {
    this.masterPath = null;
    this.runtimePath = path.join(CONFIG.CACHE_DIR, 'active_runtime_cookies.txt');
  }

  isValidCookieFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stats = fs.statSync(filePath);
      if (stats.size < 500) return false;

      // Quick header / content verification
      const head = fs.readFileSync(filePath, { encoding: 'utf-8', flag: 'r' }).slice(0, 1000);
      return head.includes('youtube') || head.includes('Netscape') || head.includes('.google.com');
    } catch (e) {
      return false;
    }
  }

  findMasterCookieFile() {
    const searchDirs = [
      CONFIG.ROOT_DIR,
      path.resolve(CONFIG.ROOT_DIR, '..'),
      path.join(CONFIG.ROOT_DIR, '..', 'musicbot-main'),
      process.cwd()
    ];

    const targetNames = [
      'cookies.master.txt',
      'www.youtube.com_cookies.txt',
      'cookies.txt',
      'cookies .txt'
    ];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;

      // 1. Explicit priority names
      for (const name of targetNames) {
        const fullPath = path.join(dir, name);
        if (this.isValidCookieFile(fullPath)) {
          this.masterPath = fullPath;
          console.log(`🛡️ [CookieShield] Found authenticated master cookies: ${name} (${(fs.statSync(fullPath).size / 1024).toFixed(1)} KB)`);
          return this.masterPath;
        }
      }

      // 2. Scan for any valid cookie file
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.toLowerCase().includes('cookie') && file.endsWith('.txt')) {
            const fullPath = path.join(dir, file);
            if (this.isValidCookieFile(fullPath)) {
              this.masterPath = fullPath;
              console.log(`🛡️ [CookieShield] Found authenticated cookie file: ${file} (${(fs.statSync(fullPath).size / 1024).toFixed(1)} KB)`);
              return this.masterPath;
            }
          }
        }
      } catch (e) {}
    }

    return null;
  }

  getYtdlpCookieArgs() {
    const master = this.findMasterCookieFile();
    if (!master) {
      console.warn('⚠️ [CookieShield] No valid cookie jar found. Operating in unauthenticated mode.');
      return [];
    }

    try {
      if (!fs.existsSync(CONFIG.CACHE_DIR)) {
        fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });
      }

      // Copy pristine master to disposable runtime path to prevent yt-dlp from corrupting it
      fs.copyFileSync(master, this.runtimePath);
      return ['--cookies', this.runtimePath];
    } catch (err) {
      console.error('❌ [CookieShield] Error isolating runtime cookies:', err.message);
      return [];
    }
  }
}
