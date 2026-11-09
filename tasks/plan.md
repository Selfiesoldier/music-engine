# Implementation Plan: Unified Music Engine Admin Cockpit

## Overview
Consolidate the fragmented player console (`public/index.html`) and cluster ops dashboard (`src/admin_dashboard.html`) into a single, high-fidelity, dark-glassmorphic Admin Cockpit. The cockpit gives the admin unified, 1-tap control over live room playback, DJ announcements, and backend fleet vitals across Room 1 (`00f50ae1`) and Room 2 (`4c1b3907`) without external build tools.

## Architecture Decisions
1. **Zero-Build Vanilla Architecture:** Single self-contained HTML/CSS/JS architecture served by Express on port 30238 (Room 1) and 30289 (Room 2). No Vite or Webpack required, allowing instant cloud deployment via Pterodactyl Files API.
2. **Dual-Room Reactive State Store:** A lightweight reactive state object in `cockpit.js` that tracks both Room 1 and Room 2 status. Switching room tabs dynamically repoints audio preview, playback actions, and queue queries to the active room's endpoint in < 100ms.
3. **Explicit Audio Preview Binding:** Radio stream audio does not auto-play on room switch; it only streams when the admin explicitly clicks the browser player Play button.
4. **Unified API Gateway in `server.js`:** Express routes proxy and bind both local player endpoints (`/api/play`, `/api/skip`, `/api/tts/speak`) and admin operations (`/health`, `/clear-cache`, `/drain-queue`, `/gc`) behind session authentication.

---

## Task Breakdown & Phases

### Phase 1: Foundation & Cockpit Layout
- **Task 1: Cockpit Layout & Glassmorphism Design System**
  - Modern dark-glass CSS tokens, responsive shell (sidebar/header/main grid), Lucide embedded SVG icons.
- **Task 2: Dual-Room State Store & Authentication Guard**
  - Session password unlock, Room 1 (Pak Music) / Room 2 (KMR Music) tab switcher with live status pills.

### Checkpoint 1: Foundation
- [ ] Responsive layout renders cleanly on 375px mobile and 1440px desktop viewports.
- [ ] Admin password modal locks/unlocks dashboard correctly.
- [ ] Toggling room tabs switches active room context without page reload.

---

### Phase 2: Player, Audio Preview & DJ Console
- **Task 3: Live Player Card & DSP Audio Filters**
  - Album art, track title, animated scrub bar, volume slider, Play/Pause/Skip/Stop controls, and 5 DSP filter buttons (Normal, Bass Boost, Nightcore, Vaporwave, 8D Audio).
- **Task 4: In-Browser Radio Stream Preview (Play-on-Demand)**
  - HTML5 audio preview bound to active room's `/stream`. Audio stays paused until user clicks Play.
- **Task 5: DJ Speech Synthesizer & MP3 Upload Dropzone**
  - Instant text-to-speech announcement dispatch, voice model selector, and drag-and-drop 96kbps MP3 upload.

### Checkpoint 2: Playback & DJ Core
- [ ] Player controls trigger `/api/play`, `/api/skip`, `/api/stop` on the target room.
- [ ] Radio stream preview plays cleanly on demand.
- [ ] TTS speech triggers announcement and resumes music cleanly.

---

### Phase 3: Search, Queue & Fleet Operations
- **Task 6: Unified Multi-Source Search & Queue Manager**
  - Real-time search across YouTube, JioSaavn, and Telegram Cloud Vault (850+ songs). Drag/reorder queue list with delete buttons.
- **Task 7: Fleet Health & Operator Drawer**
  - RAM/CPU usage gauges, active listeners, burst buffer indicator, Clear Cache, Drain Queue, GC, and container reboot triggers with confirmation modals.

### Checkpoint 3: Feature Complete
- [ ] Search returns results and appends to live queue.
- [ ] Cache clearing and queue draining execute and return visual toast feedback.
- [ ] All controls operate seamlessly across both Room 1 and Room 2.

---

### Phase 4: Cloud Fleet Deployment & Live Verification
- **Task 8: Cloud Deployment & Live Fleet Verification**
  - Upload consolidated cockpit to Room 1 (`00f50ae1`) and Room 2 (`4c1b3907`).
  - Verify live HTTP status and end-to-end functionality on production Ori Host containers.

### Checkpoint 4: Deployed & Live
- [ ] Both containers serve new Admin Cockpit at `/` and `/admin`.
- [ ] Zero console errors on Chrome DevTools.

---

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Cross-Origin requests if accessing Room 2 from Room 1 dashboard | High | Implement backend Express reverse-proxy route in `server.js` (`/api/room2/*`) so browser always makes same-origin requests. |
| In-browser audio preview autoplay blocked by browser policy | Med | User already specified audio stays paused until explicit click, matching browser autoplay rules. |
| Mobile viewport horizontal overflow | Med | Strict CSS `overflow-x: hidden`, flex-wrap containers, touch-target sizing (min 44px). |

