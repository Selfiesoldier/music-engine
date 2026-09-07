import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

export class TunnelManager {
  constructor(port = CONFIG.PORT) {
    this.port = port;
    this.process = null;
    this.publicUrl = process.env.CUSTOM_URL || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null;
    this.urlFilePath = path.join(CONFIG.ROOT_DIR, 'public_url.txt');
    this.isStarting = false;
    this.isShuttingDown = false;
    this.reconnectTimer = null;
    this.resolvedBin = this.resolveBinary();
  }

  setPublicUrl(url) {
    if (url && url !== this.publicUrl) {
      this.publicUrl = url.replace(/\/+$/, '');
      this.saveUrl(this.publicUrl);
    }
  }

  resolveBinary() {
    const candidates = [
      path.join(CONFIG.ROOT_DIR, 'cloudflared.exe'),
      path.join(CONFIG.ROOT_DIR, 'cloudflared'),
      'cloudflared.exe',
      'cloudflared',
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared'
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'cloudflared';
  }

  async start() {
    if (this.isShuttingDown) return null;

    // 1. If custom URL already provided in .env or Render, use that directly
    if (this.getPublicUrl()) {
      const pub = this.getPublicUrl();
      console.log(`\n🌐 [Network] Public HTTPS URL active: ${pub}`);
      this.saveUrl(pub);
      return pub;
    }

    // Check if cloudflared binary exists before attempting spawn
    const hasBin = fs.existsSync(this.resolvedBin);
    if (!hasBin && process.platform !== 'win32') {
      console.log('ℹ️ [Cloudflare Tunnel] cloudflared binary not found in environment, skipping auto-tunnel.');
      return null;
    }

    // 2. Launch Cloudflare Quick Tunnel
    console.log('🚀 [Cloudflare Tunnel] Starting public HTTPS tunnel...');
    return new Promise((resolve) => {
      try {
        this.process = spawn(this.resolvedBin, [
          'tunnel',
          '--url', `http://localhost:${this.port}`,
          '--no-autoupdate'
        ]);

        const onData = (data) => {
          const text = data.toString();
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
          if (match && !this.publicUrl) {
            this.publicUrl = match[0];
            this.saveUrl(this.publicUrl);
            console.log(`\n======================================================`);
            console.log(`🌐 PUBLIC CLOUDFLARE TUNNEL ONLINE!`);
            console.log(`📡 Highrise Room Stream: ${this.publicUrl}/stream`);
            console.log(`📊 Public Dashboard:     ${this.publicUrl}`);
            console.log(`======================================================\n`);
            resolve(this.publicUrl);
          }
        };

        this.process.stdout.on('data', onData);
        this.process.stderr.on('data', onData);

        this.process.on('error', (err) => {
          if (this.isShuttingDown) return;
          console.warn('⚠️ [Cloudflare Tunnel] Process error:', err.message);
          resolve(null);
        });

        this.process.on('close', (code) => {
          if (this.isShuttingDown) return;
          if (this.publicUrl) {
            console.warn(`⚠️ [Cloudflare Tunnel] Tunnel closed (code: ${code}). Reconnecting in 3s...`);
            this.publicUrl = null;
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.start(), 3000);
          }
        });

        // 15s fallback timeout
        setTimeout(() => {
          if (!this.publicUrl) resolve(null);
        }, 15000);
      } catch (e) {
        console.warn('⚠️ [Cloudflare Tunnel] Could not launch cloudflared:', e.message);
        resolve(null);
      }
    });
  }

  saveUrl(url) {
    try {
      fs.writeFileSync(this.urlFilePath, url, 'utf8');
    } catch (e) {}
  }

  getPublicUrl() {
    return this.publicUrl || process.env.RENDER_EXTERNAL_URL || null;
  }

  getStreamUrl() {
    const pub = this.getPublicUrl();
    return pub ? `${pub}/stream` : `http://localhost:${this.port}/stream`;
  }

  stop() {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.process) {
      const p = this.process;
      this.process = null;
      try {
        p.removeAllListeners('close');
        p.removeAllListeners('error');
        p.removeAllListeners('data');
        if (!p.killed) {
          p.kill('SIGKILL');
        }
      } catch (e) {}
    }
    console.log('🛑 [Cloudflare Tunnel] Tunnel process stopped.');
  }
}
