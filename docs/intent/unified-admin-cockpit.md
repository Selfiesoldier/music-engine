# Statement of Intent: Unified Music Engine Admin Cockpit

- **Outcome:** A unified, dark-glassmorphic Admin Cockpit dashboard merging full live music playback & DJ controls with real-time server fleet vitals into one neatly developed interface.
- **User:** Exclusively the administrator (password-protected, single-session unlock).
- **Why now:** Existing dashboards are fragmented across separate URLs (`public/index.html` and `src/admin_dashboard.html`), look dated, and make it awkward to manage songs, audio filters, and server health during live Highrise events.
- **Success:** One sleek, mobile-ready URL where the admin can switch between **Room 1 (Pak Music)** and **Room 2 (KMR Music)** with one tap, search/queue/play songs, trigger DJ speech announcements, and monitor/restart server nodes with real-time feedback.
- **Constraint:** Zero heavy build steps (runs as self-contained modern HTML5/CSS/JS served directly by the Express engine on port 30238/30289/30195) with instant live telemetry.
- **Out of scope:** Public/guest user accounts, complex RBAC, or modifying Highrise bot game-room code.

