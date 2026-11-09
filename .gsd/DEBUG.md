# Debug Session: Cockpit Login JSON Error & URL Playback Fallback Bug

## Symptom 1: Login JSON Parse Error
**Error:** `login error: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
**When:** Occurred when logging into the Admin Cockpit from the browser.
**Root Cause:**
1. Cross-origin requests between Room 1 (`http://92.118.206.166:30238`), Room 2 (`http://2.56.246.128:30289`), and the Central Controller (`http://2.56.246.119:30195`) lacked CORS and preflight (`OPTIONS`) handling headers.
2. The Central Controller was missing the `/api/auth/verify` and `/api/auth/status` endpoints, returning an Express HTML 404 error (`<!DOCTYPE html>...`).
3. `cockpit.js` executed `res.json()` directly on the response without validating `res.ok` or using safe text parsing, throwing the browser `SyntaxError: Unexpected token '<'`.

**Fix Applied:**
1. Added universal CORS middleware with explicit `Access-Control-Allow-Origin: *`, allowed headers, and `OPTIONS` 200 handler across `server.js` on Central Controller, Room 1, and Room 2.
2. Added `/api/auth/verify`, `/api/auth/login`, and `/api/auth/status` to the Central Controller and audio streamer servers.
3. Updated `doLogin()` in `public/js/cockpit.js` with safe text parsing and automated fallback to `/api/login` so HTML responses can never throw a JSON syntax alert.

---

## Symptom 2: Direct URL Playback Resolves as "Requested Track" & Plays Random Song
**Error:** When requesting a song via direct URL, the system said *"Now playing: Requested Track, by Unknown Artist"* in TTS and played a random song.
**Root Cause:**
1. **URL Handling in `cachedYts`:** When a direct YouTube URL (`https://youtu.be/...`, `https://www.youtube.com/watch?v=...&si=...`) was passed to `cachedYts(url)`, it executed a raw text query in `yt-search`. For shortened or query-parameterized URLs, `yt-search` either returned 0 results or matched random trending videos instead of extracting the video ID.
2. **Metadata Fallback Defaulting:** When `metadata` failed to resolve, the Central Controller defaulted `songItem.title` to `'Requested Track'` and `artist` to `'Unknown Artist'`.
3. **Downloader Router Query Poisoning:** In `downloadTrackToFile`, the router computed `cleanSearch = cleanQueryForWorker(rawTitle, artist)` which evaluated to `'Requested Track'`. The fallback downloader (JioSaavn or SoundCloud) then searched for the literal string `"Requested Track"`, downloading and playing whatever random track matched.
4. **Cockpit Search Payload:** `cockpit.js` passed `{ source: trimmed }` instead of `{ url: trimmed, source: trimmed, q: trimmed }`.

**Fix Applied:**
1. Implemented `extractYouTubeVideoId(input)` supporting all YouTube formats (`youtu.be`, `watch?v=`, `embed`, `shorts`, `si=` share parameters, and raw 11-char IDs).
2. Implemented `resolveTrackMetadata(queryOrUrl)` which resolves the exact video metadata via `yts({ videoId })`, extracting the true title, author/artist, duration, thumbnail, and clean URL.
3. Updated `/play`, `/api/play`, `/insert`, `/api/insert`, `/resolve`, and `/api/resolve` on the Central Controller to resolve links via `resolveTrackMetadata`.
4. Updated `public/js/cockpit.js` to dispatch full payload `{ url, source, q }`.

---

## Verification & Proof

### 1. Auth Endpoint Verification across Fleet
- `http://2.56.246.119:30195/api/auth/verify` -> **HTTP 200** `{"success": true, "authenticated": true, "token": "changeme"}`
- `http://92.118.206.166:30238/api/auth/verify` -> **HTTP 200** `{"success": true, "authenticated": true, "token": "changeme"}`
- `http://2.56.246.128:30289/api/auth/verify` -> **HTTP 200** `{"success": true, "authenticated": true, "token": "changeme"}`

### 2. URL Metadata Resolution Test
- Input link: `https://youtu.be/dQw4w9WgXcQ`
  - **Resolved Title:** `Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)`
  - **Resolved Artist:** `Rick Astley`
  - **Resolved Duration:** `3:33` (213s)
  - **Resolved Video ID:** `dQw4w9WgXcQ`
- Input link: `https://www.youtube.com/watch?v=k2qgadSvNyU`
  - **Resolved Title:** `Dua Lipa - New Rules (Official Music Video)`
  - **Resolved Artist:** `Dua Lipa`
  - **Resolved Duration:** `3:45` (225s)

### 3. Live Playback & Queue Test via API
- Dispatched `POST /api/play` with `{"url": "https://youtu.be/dQw4w9WgXcQ"}` to Room 1:
  ```json
  {
    "status": "playing",
    "room": "room1",
    "url": "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "queuedTitle": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
    "currentTitle": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
    "currentMetadata": {
      "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
      "artist": "Rick Astley",
      "duration": "3:33"
    }
  }
  ```
- Confirmed live on `http://92.118.206.166:30238/current`:
  `title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)"`, `isPlaying: true`.
