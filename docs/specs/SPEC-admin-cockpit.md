# Spec: Unified Music Engine Admin Cockpit

## Objective
Replace the two disjointed, dated dashboards (`public/index.html` and `src/admin_dashboard.html`) with a single, production-grade, dark-glassmorphic Admin Cockpit. 
This unified interface provides real-time control over live audio playback, DJ speech synthesis, and backend server infrastructure across both **Room 1 (Pak Music)** and **Room 2 (KMR Music)** in one responsive, single-pane interface.

### Target User
- Exclusively the server administrator / room owner (authenticated via single admin password).

### Core Capabilities
1. **Header & Fleet Bar:**
   - Real-time room switcher: `[ 📻 Room 1: Pak Music ]` and `[ 📻 Room 2: KMR Music ]` with live status indicators (active listeners, current track, ping/latency).
   - Global fleet summary: total listeners, total streamed bandwidth, active cluster nodes.
   - Master lock/unlock authentication toggle.
2. **Player & DJ Control Center:**
   - Real-time track artwork, title, elapsed/total time scrubber, volume control (0–100%).
   - Direct audio controls: Play, Pause, Skip, Stop.
   - Audio DSP Filters: Normal, Bass Boost, Nightcore, Vaporwave, 8D Audio.
   - Live Highrise stream audio preview right in browser via HTML5 `<audio>` player connected to `http://<node>/stream`.
   - Studio AI / DJ announcement box with instant voice trigger and ElevenLabs/EdgeTTS toggle.
   - Drag-and-drop MP3 upload dropzone with automatic 96kbps CBR client-side/server-side validation.
3. **Queue & Search Panel:**
   - Multi-source search bar (YouTube, JioSaavn, Telegram Vault with 850+ cached songs).
   - Live draggable/manageable queue list with remove track and instant jump-to-track.
4. **Fleet Infrastructure & Diagnostic Drawer:**
   - Real-time node vitals: CPU %, RSS Memory MB, active socket clients, buffer burst size.
   - Operational controls: Clear Track Cache (`/clear-cache`), Drain Queue (`/drain-queue`), Force GC (`/gc`), and Reboot Node (`/power`).
   - Live stream log tailer with pause/resume auto-scroll.

---

## Tech Stack
- **Frontend Core:** Pure HTML5, Modern CSS3 (CSS Variables, Flexbox/Grid, Glassmorphic Backdrop Filters), Vanilla ES2022 JavaScript.
- **Iconography:** Lucide Icons (CDN/embedded SVG for zero network dependencies).
- **Audio Core:** HTML5 Audio API for stream playback and spectrum/visualizer telemetry.
- **Backend Communication:** REST API + Server-Sent Events (SSE) / 2.5s Polling fallback for real-time bi-directional status.
- **Server Platform:** Express.js static hosting from `public/` and `src/` on Node.js 18+.

---

## Commands
```powershell
# Syntax validation of frontend/backend files
node --check public/index.html
node --check src/server.js

# Test live endpoints for Room 1 & Room 2
node -e "http.get('http://92.118.206.166:30238/api/status', res => console.log('R1 Status:', res.statusCode))"
node -e "http.get('http://2.56.246.128:30289/api/status', res => console.log('R2 Status:', res.statusCode))"

# Deploy updated cockpit to cloud fleet
python scratch/deploy_streamers_phase7.py
```

---

## Project Structure
```
musicbot-engine/
├── docs/
│   ├── intent/
│   │   └── unified-admin-cockpit.md    → Confirmed Intent Document
│   └── specs/
│       └── SPEC-admin-cockpit.md       → This Specification Document
├── public/
│   ├── index.html                      → Master Unified Admin Cockpit (Consolidated)
│   ├── css/
│   │   └── cockpit.css                 → Glassmorphic design tokens, layout & responsive grid
│   └── js/
│       └── cockpit.js                  → State store, audio player, API client, SSE subscriber
└── src/
    ├── server.js                       → Express route bindings for unified dashboard & proxy endpoints
    └── persistentStreamManager.js      → Hardened frame-accurate streaming engine
```

---

## Code Style & Design Tokens
```css
:root {
  /* Surface palette */
  --bg-primary: #080a0f;
  --bg-secondary: #0f141c;
  --bg-card: rgba(18, 24, 38, 0.72);
  --bg-card-hover: rgba(26, 34, 52, 0.85);
  
  /* Glassmorphism */
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-glow: rgba(99, 102, 241, 0.15);
  --backdrop-blur: blur(16px);
  
  /* Brand Accents */
  --accent-primary: #6366f1;   /* Indigo */
  --accent-secondary: #a855f7; /* Purple */
  --accent-dj: #ec4899;        /* Pink */
  --status-green: #10b981;     /* Emerald */
  --status-amber: #f59e0b;     /* Amber */
  --status-red: #ef4444;       /* Rose */
  
  /* Typography */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```

---

## Boundaries
- **Always:**
  - Password-protect all destructive fleet actions (`/clear-cache`, `/drain-queue`, `/power`).
  - Keep all dependencies zero-build (runnable directly in browser without Vite/Webpack compilation).
  - Test responsiveness on mobile viewport (375px width) and desktop (1440px width).
  - Handle room switching gracefully without cutting off browser audio preview unless requested.
- **Ask First:**
  - Adding external npm packages to the cloud streamer runtime.
  - Changing authentication tokens or environment variable formats on live servers.
- **Never:**
  - Never expose raw API secret keys or panel credentials in client-side HTML/JS.
  - Never block the UI thread during large file uploads or playlist searches.
  - Never alter stream encoding parameters away from 96kbps CBR MPEG-1 Layer 3.

---

## Success Criteria
1. Single URL serves both music playback controls and infrastructure health management.
2. Room Switcher tab toggles between Room 1 and Room 2 in < 200ms with instant state sync.
3. Live audio preview plays cleanly in browser from `/stream` with volume and mute controls.
4. DJ announcement box successfully dispatches speech to the stream and resumes music smoothly.
5. Fleet management drawer displays real-time RAM, active listeners, and executes cache clearing with visual toast confirmation.
6. Mobile UI is fully usable with touch-friendly sliders and buttons without horizontal scroll bugs.

---

## Resolved Design Decisions
1. **Password**: Preserves existing `ADMIN_PASSWORD` authentication mechanism (session unlock cookie/token).
2. **Audio Auto-Preview**: Disabled by default. Toggling between rooms updates metadata, queue, and stats instantly, but the browser stream player remains paused until the user explicitly clicks Play.

