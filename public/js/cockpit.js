/**
 * MUSIC ENGINE ADMIN COCKPIT — JAVASCRIPT STATE ENGINE
 * Dual-room reactive store, authenticated actions, audio preview, and telemetry.
 */

// Fleet Configuration
const FLEET_CONFIG = {
  room1: {
    id: 'room1',
    name: 'Room 1 (Pak Music)',
    station: 'pakmusic',
    endpoint: window.location.port === '30238' ? '' : 'http://92.118.206.166:30238',
    streamUrl: window.location.port === '30238' ? '/stream' : 'http://92.118.206.166:30238/stream'
  },
  room2: {
    id: 'room2',
    name: 'Room 2 (KMR Music)',
    station: 'kmrmusic',
    endpoint: window.location.port === '30289' ? '' : 'http://2.56.246.128:30289',
    streamUrl: window.location.port === '30289' ? '/stream' : 'http://2.56.246.128:30289/stream'
  }
};

class CockpitState {
  constructor() {
    this.activeRoomId = 'room1';
    this.token = localStorage.getItem('cockpit_auth_token') || '';
    this.isAuthenticated = false;
    this.pollInterval = null;

    // Room Telemetry Store
    this.telemetry = {
      room1: {
        healthy: false,
        isPlaying: false,
        isSilence: true,
        currentTrack: null,
        elapsedSeconds: 0,
        durationSeconds: 0,
        volume: 100,
        listeners: 0,
        burstBufferKB: '0',
        activeFilter: 'normal',
        queue: []
      },
      room2: {
        healthy: false,
        isPlaying: false,
        isSilence: true,
        currentTrack: null,
        elapsedSeconds: 0,
        durationSeconds: 0,
        volume: 100,
        listeners: 0,
        burstBufferKB: '0',
        activeFilter: 'normal',
        queue: []
      }
    };

    // Browser Live Audio Preview (Play-on-demand)
    this.audioPreview = new Audio();
    this.audioPreview.preload = 'none';
    this.isPreviewPlaying = false;
  }

  get activeRoom() {
    return FLEET_CONFIG[this.activeRoomId];
  }

  get activeData() {
    return this.telemetry[this.activeRoomId];
  }

  async init() {
    this.bindEvents();
    await this.checkAuth();
    await this.pollFleetData();

    // Start background telemetry polling loop (2.5 seconds)
    this.pollInterval = setInterval(() => this.pollFleetData(), 2500);

    // Initial UI render
    this.render();
  }

  bindEvents() {
    // Room Switcher tabs
    document.querySelectorAll('.room-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const targetId = tab.dataset.room;
        if (targetId && targetId !== this.activeRoomId) {
          this.switchRoom(targetId);
        }
      });
    });

    // Audio Preview Controls
    const previewBtn = document.getElementById('previewPlayBtn');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => this.toggleAudioPreview());
    }

    // Auth Trigger
    const authBtn = document.getElementById('authStatusBtn');
    if (authBtn) {
      authBtn.addEventListener('click', () => {
        if (!this.isAuthenticated) {
          this.openAuthModal();
        } else if (confirm('Log out of Admin Cockpit?')) {
          this.logout();
        }
      });
    }

    // Search Input Enter key
    const searchInput = document.getElementById('musicSearchInput');
    if (searchInput) {
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleSearch(searchInput.value);
          searchInput.value = '';
        }
      });
    }

    // Audio preview state sync
    this.audioPreview.addEventListener('play', () => {
      this.isPreviewPlaying = true;
      this.updatePreviewUI();
    });
    this.audioPreview.addEventListener('pause', () => {
      this.isPreviewPlaying = false;
      this.updatePreviewUI();
    });
    this.audioPreview.addEventListener('error', (e) => {
      console.warn('Audio stream preview error:', e);
      this.isPreviewPlaying = false;
      this.updatePreviewUI();
    });
  }

  switchRoom(roomId) {
    if (!FLEET_CONFIG[roomId]) return;
    this.activeRoomId = roomId;

    // Explicit Rule: In-browser radio stream pauses on room switch until user explicitly clicks play
    if (this.isPreviewPlaying) {
      this.audioPreview.pause();
      this.audioPreview.src = '';
      this.isPreviewPlaying = false;
    }

    this.render();
  }

  toggleAudioPreview() {
    if (this.isPreviewPlaying) {
      this.audioPreview.pause();
    } else {
      const streamUrl = this.activeRoom.streamUrl + (this.activeRoom.streamUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
      this.audioPreview.src = streamUrl;
      this.audioPreview.play().catch(err => {
        console.warn('Audio preview play blocked or interrupted:', err.message);
        this.showToast('Could not play stream audio: ' + err.message, 'error');
      });
    }
  }

  updatePreviewUI() {
    const btn = document.getElementById('previewPlayBtn');
    const label = document.getElementById('previewStationName');
    if (label) label.textContent = this.activeRoom.station.toUpperCase();
    if (btn) {
      btn.innerHTML = this.isPreviewPlaying ? '⏸️ Stop Radio' : '▶️ Listen to Radio';
      btn.style.background = this.isPreviewPlaying ? 'var(--status-amber)' : 'var(--accent-primary)';
    }
  }

  async checkAuth() {
    try {
      const res = await this.apiReq('/api/auth/status');
      if (res && res.authenticated) {
        this.isAuthenticated = true;
      }
    } catch (_) {
      this.isAuthenticated = false;
    }
    this.updateAuthBadge();
  }

  async doLogin(password) {
    if (!password || !password.trim()) {
      alert('Please enter an admin password.');
      return;
    }
    const cleanPass = password.trim();
    try {
      // 1. Try active room's /api/auth/verify endpoint
      let res = await fetch(`${this.activeRoom.endpoint}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: cleanPass })
      }).catch(() => null);

      // 2. If endpoint returned 404 or failed, fallback to /api/login
      if (!res || !res.ok) {
        const fallbackRes = await fetch(`${this.activeRoom.endpoint}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: cleanPass })
        }).catch(() => null);
        if (fallbackRes && (fallbackRes.ok || fallbackRes.status === 401)) {
          res = fallbackRes;
        }
      }

      if (!res) {
        alert('Could not connect to ' + this.activeRoom.name + '. Please check server connectivity.');
        return;
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        alert(`Authentication failed (HTTP ${res.status}): Server returned non-JSON response.`);
        return;
      }

      if (data && data.success) {
        this.token = data.token || cleanPass;
        localStorage.setItem('cockpit_auth_token', this.token);
        this.isAuthenticated = true;
        this.closeModal();
        this.showToast('Unlocked Admin Cockpit successfully!', 'success');
        this.updateAuthBadge();
      } else {
        alert('Invalid Admin Password. Please try again.');
      }
    } catch (e) {
      alert('Login error: ' + e.message);
    }
  }

  logout() {
    this.token = '';
    this.isAuthenticated = false;
    localStorage.removeItem('cockpit_auth_token');
    this.updateAuthBadge();
    this.showToast('Logged out of Admin Cockpit', 'info');
  }

  updateAuthBadge() {
    const badge = document.getElementById('authStatusBtn');
    if (!badge) return;
    if (this.isAuthenticated) {
      badge.classList.add('unlocked');
      badge.innerHTML = '🔒 Admin Unlocked';
    } else {
      badge.classList.remove('unlocked');
      badge.innerHTML = '🔑 Unlock Admin';
    }
  }

  async pollFleetData() {
    await Promise.all([
      this.fetchRoomStatus('room1'),
      this.fetchRoomStatus('room2')
    ]);
    this.render();
  }

  async fetchRoomStatus(roomId) {
    const cfg = FLEET_CONFIG[roomId];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(`${cfg.endpoint}/api/status`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const p = data.player || {};
        const s = data.stream || {};

        this.telemetry[roomId] = {
          healthy: true,
          isPlaying: p.isPlaying || false,
          isSilence: s.isSendingSilence || false,
          currentTrack: p.currentTrack || null,
          elapsedSeconds: (p.currentTrack && p.currentTrack.elapsedSeconds) || 0,
          durationSeconds: (p.currentTrack && p.currentTrack.durationSeconds) || 0,
          volume: p.volume || 100,
          listeners: s.activeListeners || 0,
          burstBufferKB: s.burstBufferKB || '0',
          activeFilter: p.activeFilter || 'normal',
          queue: data.queue || []
        };
      } else {
        this.telemetry[roomId].healthy = false;
      }
    } catch (_) {
      this.telemetry[roomId].healthy = false;
    }
  }

  async apiReq(endpoint, method = 'GET', body = null) {
    const headers = { 'Accept': 'application/json' };
    if (this.token) {
      headers['Authorization'] = 'Bearer ' + this.token;
      headers['x-admin-key'] = this.token;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const options = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    };

    const res = await fetch(`${this.activeRoom.endpoint}${endpoint}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async sendPlayback(action, extra = {}) {
    if (!this.isAuthenticated) {
      this.openAuthModal();
      return;
    }
    try {
      await this.apiReq(`/api/${action}`, 'POST', extra);
      this.showToast(`Action dispatched: ${action}`, 'success');
      setTimeout(() => this.pollFleetData(), 400);
    } catch (e) {
      this.showToast(`Action failed: ${e.message}`, 'error');
    }
  }

  async setFilter(filterName) {
    await this.sendPlayback('filter', { filter: filterName });
    this.activeData.activeFilter = filterName;
    this.render();
  }

  async handleSearch(query) {
    if (!query || !query.trim()) return;
    if (!this.isAuthenticated) {
      this.openAuthModal();
      return;
    }

    const trimmed = query.trim();
    this.showToast(`Resolving & queuing "${trimmed}" to ${this.activeRoom.name}...`, 'info');

    try {
      // Send url, source, and q so all routers and central controller recognize it
      const payload = {
        url: trimmed,
        source: trimmed,
        q: trimmed
      };
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        payload.title = trimmed;
      }

      const res = await this.apiReq('/api/play', 'POST', payload);
      const queuedName = res?.queuedTitle || res?.currentTitle || trimmed;
      this.showToast(`✅ Queued: "${queuedName}"!`, 'success');
      setTimeout(() => this.pollFleetData(), 500);
    } catch (e) {
      this.showToast('Failed to queue: ' + e.message, 'error');
    }
  }

  async announceSpeech(text) {
    if (!text || !text.trim()) return;
    if (!this.isAuthenticated) {
      this.openAuthModal();
      return;
    }
    try {
      this.showToast('Synthesizing speech announcement (ZERO CPU)...', 'info');
      const res = await this.apiReq('/api/tts/speak', 'POST', { text });
      const sec = res && res.durationMs ? Math.round(res.durationMs / 1000) : 4;
      this.showToast(`📢 DJ Speech broadcasting live on Highrise! (~${sec}s, ZERO CPU)`, 'success');
    } catch (e) {
      this.showToast('DJ Speech failed: ' + e.message, 'error');
    }
  }

  async clearCache() {
    if (!confirm('Clear all downloaded track cache on ' + this.activeRoom.name + '?')) return;
    try {
      await this.apiReq('/clear-cache', 'POST');
      this.showToast('Cache cleared successfully!', 'success');
    } catch (e) {
      this.showToast('Failed to clear cache: ' + e.message, 'error');
    }
  }

  async drainQueue() {
    if (!confirm('Drain and clear playback queue on ' + this.activeRoom.name + '?')) return;
    try {
      await this.apiReq('/drain-queue', 'POST');
      this.showToast('Queue drained successfully!', 'success');
    } catch (e) {
      this.showToast('Failed to drain queue: ' + e.message, 'error');
    }
  }

  async forceGc() {
    try {
      await this.apiReq('/gc', 'POST');
      this.showToast('Garbage collection triggered!', 'success');
    } catch (e) {
      this.showToast('GC failed: ' + e.message, 'error');
    }
  }

  render() {
    // 1. Update Room Switcher Active State
    document.querySelectorAll('.room-tab').forEach(tab => {
      const rId = tab.dataset.room;
      tab.classList.toggle('active', rId === this.activeRoomId);

      // Update badge
      const badge = tab.querySelector('.room-listener-badge');
      const pulse = tab.querySelector('.room-pulse');
      if (badge && this.telemetry[rId]) {
        badge.textContent = `${this.telemetry[rId].listeners} live`;
      }
      if (pulse && this.telemetry[rId]) {
        pulse.style.background = this.telemetry[rId].healthy ? 'var(--status-green)' : 'var(--status-red)';
      }
    });

    const d = this.activeData;

    // 2. Update Now Playing Card
    const titleEl = document.getElementById('currentTrackTitle');
    const artistEl = document.getElementById('currentTrackArtist');
    const thumbEl = document.getElementById('currentTrackThumb');
    const timeElapsedEl = document.getElementById('timeElapsed');
    const timeTotalEl = document.getElementById('timeTotal');
    const scrubFill = document.getElementById('scrubFill');

    if (d.currentTrack && d.isPlaying) {
      if (titleEl) titleEl.textContent = d.currentTrack.title || 'Unknown Title';
      if (artistEl) artistEl.textContent = d.currentTrack.artist || 'Highrise Audio Streamer';
      if (thumbEl && d.currentTrack.thumbnail) thumbEl.src = d.currentTrack.thumbnail;

      const elSec = d.elapsedSeconds || 0;
      const totSec = d.durationSeconds || 0;
      if (timeElapsedEl) timeElapsedEl.textContent = this.formatTime(elSec);
      if (timeTotalEl) timeTotalEl.textContent = totSec > 0 ? this.formatTime(totSec) : '--:--';
      if (scrubFill) {
        const pct = totSec > 0 ? Math.min(100, (elSec / totSec) * 100) : 100;
        scrubFill.style.width = pct + '%';
      }
    } else {
      if (titleEl) titleEl.textContent = d.isSilence ? 'Silence Stream (No Track Playing)' : 'Stream Idle';
      if (artistEl) artistEl.textContent = this.activeRoom.name;
      if (thumbEl) thumbEl.src = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300';
      if (timeElapsedEl) timeElapsedEl.textContent = '0:00';
      if (timeTotalEl) timeTotalEl.textContent = '0:00';
      if (scrubFill) scrubFill.style.width = '0%';
    }

    // 3. Update Audio Filters
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === d.activeFilter);
    });

    // 4. Update Vitals
    const ramEl = document.getElementById('vitalRam');
    const burstEl = document.getElementById('vitalBurst');
    const listenEl = document.getElementById('vitalListeners');
    if (ramEl) ramEl.textContent = d.healthy ? 'Healthy' : 'Offline';
    if (burstEl) burstEl.textContent = d.burstBufferKB + ' KB';
    if (listenEl) listenEl.textContent = d.listeners;

    this.updatePreviewUI();
  }

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  showToast(message, type = 'info') {
    let toast = document.getElementById('cockpitToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'cockpitToast';
      toast.style.position = 'fixed';
      toast.style.bottom = '24px';
      toast.style.right = '24px';
      toast.style.zIndex = '9999';
      toast.style.padding = '12px 20px';
      toast.style.borderRadius = '8px';
      toast.style.color = '#fff';
      toast.style.fontWeight = '600';
      toast.style.fontSize = '13px';
      toast.style.boxShadow = '0 8px 24px rgba(0,0,0,0.5)';
      toast.style.transition = 'all 0.3s ease';
      document.body.appendChild(toast);
    }
    toast.style.background = type === 'error' ? 'var(--status-red)' : type === 'success' ? 'var(--status-green)' : 'var(--accent-primary)';
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }, 3000);
  }

  openAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) modal.classList.add('open');
  }

  closeModal() {
    const modal = document.getElementById('authModal');
    if (modal) modal.classList.remove('open');
  }
}

// Global instantiation
window.cockpit = new CockpitState();
window.addEventListener('DOMContentLoaded', () => window.cockpit.init());
