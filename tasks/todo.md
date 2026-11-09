# Task List: Unified Music Engine Admin Cockpit

## Phase 1: Foundation & Cockpit Layout

- [x] Task 1: Cockpit Layout & Glassmorphism Design System
  - **Acceptance:** Full-page dark glassmorphic layout shell with CSS variables, navigation header, status banner, room tab bar, and mobile responsive grid.
  - **Verify:** `node --check public/index.html` and visual layout check.
  - **Files:** `public/index.html`, `public/css/cockpit.css`
  - **Scope:** Medium (2 files)

- [x] Task 2: Dual-Room State Store & Authentication Guard
  - **Acceptance:** Session password modal authenticates against `/api/auth/verify`. Reactive JavaScript state manager handles switching active room (`room1` vs `room2`), polling endpoints every 2.5s and updating room tab badges.
  - **Verify:** Open dashboard in browser, enter password, click room switcher tabs.
  - **Files:** `public/js/cockpit.js`
  - **Scope:** Medium (1 file)

## Checkpoint 1: Foundation
- [x] Responsive layout renders cleanly on 375px mobile and 1440px desktop viewports.
- [x] Admin password modal locks/unlocks dashboard correctly.
- [x] Toggling room tabs switches active room context without page reload.

---

## Phase 2: Player, Audio Preview & DJ Console

- [x] Task 3: Live Player Card & DSP Audio Filters
  - **Acceptance:** Live track artwork, title, artist, elapsed/total time scrubber, volume slider, Play, Pause, Skip, Stop buttons, and 5 DSP filter buttons (Normal, Bass Boost, Nightcore, Vaporwave, 8D Audio).
  - **Verify:** Click filters, observe `/api/filter` network calls; inspect scrub bar animation.
  - **Files:** `public/index.html`, `public/css/cockpit.css`, `public/js/cockpit.js`
  - **Scope:** Medium (3 files)

- [x] Task 4: In-Browser Radio Stream Preview (Play-on-Demand)
  - **Acceptance:** Built-in HTML5 audio element connected to active room's `/stream`. Remains paused on room switch until user explicitly clicks Play. Includes volume and mute toggle.
  - **Verify:** Switch room tabs; verify audio stays paused until Play button is clicked; verify audio plays clean stream.
  - **Files:** `public/js/cockpit.js`, `public/index.html`
  - **Scope:** Small (2 files)

- [x] Task 5: DJ Speech Synthesizer & MP3 Upload Dropzone
  - **Acceptance:** Text input for instant DJ voice announcements (`/api/tts/speak`), toggle for ElevenLabs / EdgeTTS, and drag-and-drop MP3 file dropzone with upload progress bar.
  - **Verify:** Submit test announcement; drag an MP3 file into dropzone.
  - **Files:** `public/index.html`, `public/js/cockpit.js`, `public/css/cockpit.css`
  - **Scope:** Medium (3 files)

## Checkpoint 2: Playback & DJ Core
- [x] Player controls trigger `/api/play`, `/api/skip`, `/api/stop` on the target room.
- [x] Radio stream preview plays cleanly on demand.
- [x] TTS speech triggers announcement and resumes music cleanly.

---

## Phase 3: Search, Queue & Fleet Operations

- [x] Task 6: Unified Multi-Source Search & Queue Manager
  - **Acceptance:** Instant search bar supporting YouTube, JioSaavn, and Telegram Cloud Vault (850+ songs). Renders live queue with artwork, track duration, drag/jump controls, and delete buttons.
  - **Verify:** Search for song, click Add to Queue, verify queue list updates in real-time.
  - **Files:** `public/index.html`, `public/js/cockpit.js`
  - **Scope:** Medium (2 files)

- [x] Task 7: Fleet Health & Operator Drawer
  - **Acceptance:** Real-time RAM/CPU gauges, active listeners count, burst buffer size indicator. Action buttons for Clear Cache, Drain Queue, GC, and Restart Container with confirmation modal and feedback toast.
  - **Verify:** Click Clear Cache, verify confirmation modal pops up and toast confirms completion.
  - **Files:** `public/index.html`, `public/js/cockpit.js`, `src/server.js`
  - **Scope:** Medium (3 files)

## Checkpoint 3: Feature Complete
- [x] Search returns results and appends to live queue.
- [x] Cache clearing and queue draining execute and return visual toast feedback.
- [x] All controls operate seamlessly across both Room 1 and Room 2.

---

## Phase 4: Cloud Fleet Deployment & Live Verification

- [x] Task 8: Cloud Deployment & Live Fleet Verification
  - **Acceptance:** Upload consolidated cockpit assets (`public/index.html`, `public/css/cockpit.css`, `public/js/cockpit.js`, and `src/server.js`) to Room 1 (`00f50ae1`) and Room 2 (`4c1b3907`). Verify live HTTP status and end-to-end functionality.
  - **Verify:** Automated deployment script verifies both nodes serve new cockpit with status 200.
  - **Files:** `scratch/deploy_cockpit.py`
  - **Scope:** Small (1 file)

## Checkpoint 4: Deployed & Live
- [x] Both containers serve new Admin Cockpit at `/` and `/admin`.
- [x] All live controls operational on Ori Host servers.
- [x] **Studio DJ Speech Synthesizer (ZERO CPU SPEECH) Fully Verified:**
  - `POST /api/tts/speak` synthesizes via Termux Residential Bridge (96kbps CBR 44.1kHz stereo MP3).
  - 0% CPU overhead / ZERO FFmpeg on live audio streaming nodes.
  - Smooth music ducking/pause, frame-by-frame speech delivery to `/stream`, and seamless music resumption.
  - Verified on Room 1 (`92.118.206.166:30238`) and Room 2 (`2.56.246.128:30289`).


