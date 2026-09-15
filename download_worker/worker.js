import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Port configuration (Pterodactyl passes PORT or SERVER_PORT)
const rawPort = process.env.PORT || process.env.SERVER_PORT || 3000;
const PORT = parseInt(String(rawPort).trim(), 10) || 3000;


// Resolve yt-dlp path (cross-platform)
function getYTPath() {
  if (process.platform === 'win32') {
    const localExe = path.join(__dirname, 'yt-dlp.exe');
    if (fs.existsSync(localExe)) return localExe;
  }
  const localLinux = path.join(__dirname, 'yt-dlp');
  if (fs.existsSync(localLinux)) {
    try {
      fs.chmodSync(localLinux, 0o755);
      console.log(`[Worker] 🔒 Granted executable permissions (755) to: ${localLinux}`);
    } catch (e) {
      console.warn(`[Worker] ⚠️ Could not chmod yt-dlp: ${e.message}`);
    }
    return localLinux;
  }
  return 'yt-dlp';
}

const YTDLP_PATH = getYTPath();
try {
  if (fs.existsSync(YTDLP_PATH)) {
    fs.chmodSync(YTDLP_PATH, 0o755);
  }
} catch (_) {}

const CACHE_DIR = path.join(__dirname, 'cache');
const MAX_CACHED_TRACKS = parseInt(process.env.MAX_CACHE_TRACKS, 10) || 100;
const MAX_CACHE_SIZE_BYTES = (parseInt(process.env.MAX_CACHE_MB, 10) || 400) * 1024 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Music Engine Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
  :root {
    --bg: #080b14;
    --bg2: #0d1120;
    --bg3: #111827;
    --glass: rgba(255,255,255,0.04);
    --glass-border: rgba(255,255,255,0.08);
    --accent: #7c3aed;
    --accent2: #6d28d9;
    --accent-glow: rgba(124,58,237,0.3);
    --green: #10b981;
    --green-dim: rgba(16,185,129,0.15);
    --red: #ef4444;
    --red-dim: rgba(239,68,68,0.15);
    --yellow: #f59e0b;
    --yellow-dim: rgba(245,158,11,0.15);
    --blue: #3b82f6;
    --blue-dim: rgba(59,130,246,0.15);
    --text: #f1f5f9;
    --text-dim: #94a3b8;
    --text-muted: #475569;
    --radius: 16px;
    --radius-sm: 10px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Inter', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Background grid */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(124,58,237,0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(124,58,237,0.03) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }

  /* Login Screen */
  #login-screen {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    background: var(--bg);
  }

  .login-card {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: 24px;
    padding: 48px 40px;
    width: 360px;
    backdrop-filter: blur(20px);
    text-align: center;
    box-shadow: 0 0 60px rgba(124,58,237,0.15);
  }

  .login-card .logo {
    width: 64px;
    height: 64px;
    background: linear-gradient(135deg, var(--accent), #a855f7);
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    margin: 0 auto 20px;
    box-shadow: 0 0 30px var(--accent-glow);
  }

  .login-card h2 {
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 6px;
  }

  .login-card p {
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 28px;
  }

  .login-card input {
    width: 100%;
    padding: 14px 16px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--glass-border);
    background: rgba(255,255,255,0.05);
    color: var(--text);
    font-size: 14px;
    font-family: 'JetBrains Mono', monospace;
    margin-bottom: 14px;
    outline: none;
    transition: border-color 0.2s;
  }

  .login-card input:focus { border-color: var(--accent); }

  .login-card .btn-login {
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, var(--accent), #a855f7);
    color: white;
    font-weight: 600;
    font-size: 15px;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 0.2s, transform 0.1s;
  }

  .login-card .btn-login:hover { opacity: 0.9; transform: translateY(-1px); }
  .login-card .btn-login:active { transform: translateY(0); }

  .login-error {
    color: var(--red);
    font-size: 13px;
    margin-top: 10px;
    display: none;
  }

  /* Main App */
  #app { display: none; position: relative; z-index: 1; }

  /* Topbar */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 100;
    background: rgba(8,11,20,0.85);
    backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--glass-border);
    padding: 0 24px;
    height: 64px;
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .topbar-logo {
    display: flex;
    align-items: center;
    gap: 12px;
    font-weight: 700;
    font-size: 16px;
  }

  .topbar-logo .icon {
    width: 36px;
    height: 36px;
    background: linear-gradient(135deg, var(--accent), #a855f7);
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    box-shadow: 0 0 16px var(--accent-glow);
  }

  .server-tabs {
    display: flex;
    gap: 4px;
    margin-left: 16px;
    flex: 1;
  }

  .server-tab {
    padding: 6px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.2s;
    color: var(--text-dim);
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .server-tab.active {
    background: rgba(124,58,237,0.15);
    border-color: rgba(124,58,237,0.3);
    color: var(--text);
  }

  .server-tab .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .server-tab .status-dot.online { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .server-tab .status-dot.offline { background: var(--red); }

  .topbar-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .live-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--green);
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
  }

  .btn-logout {
    padding: 7px 14px;
    border-radius: 8px;
    border: 1px solid var(--glass-border);
    background: var(--glass);
    color: var(--text-dim);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-logout:hover { border-color: var(--red); color: var(--red); }

  /* Main Layout */
  .main {
    padding: 24px;
    max-width: 1400px;
    margin: 0 auto;
    display: grid;
    gap: 20px;
  }

  /* Cards */
  .card {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    padding: 24px;
    backdrop-filter: blur(10px);
    transition: border-color 0.2s;
  }

  .card:hover { border-color: rgba(255,255,255,0.12); }

  .card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
  }

  .stat-card {
    background: var(--bg2);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-sm);
    padding: 20px;
    position: relative;
    overflow: hidden;
    transition: transform 0.2s, border-color 0.2s;
  }

  .stat-card:hover { transform: translateY(-2px); border-color: rgba(255,255,255,0.14); }

  .stat-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.5;
  }

  .stat-label {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 500;
    margin-bottom: 8px;
  }

  .stat-value {
    font-size: 30px;
    font-weight: 800;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1;
    margin-bottom: 4px;
  }

  .stat-sub {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'JetBrains Mono', monospace;
  }

  .stat-icon {
    position: absolute;
    top: 20px;
    right: 20px;
    font-size: 22px;
    opacity: 0.3;
  }

  /* Progress bar */
  .progress-bar {
    height: 6px;
    border-radius: 99px;
    background: rgba(255,255,255,0.06);
    margin-top: 10px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: 99px;
    transition: width 0.6s ease;
    background: linear-gradient(90deg, var(--accent), #a855f7);
  }

  .progress-fill.green { background: linear-gradient(90deg, var(--green), #34d399); }
  .progress-fill.red { background: linear-gradient(90deg, var(--red), #f87171); }
  .progress-fill.yellow { background: linear-gradient(90deg, var(--yellow), #fcd34d); }

  /* Queue Slots */
  .queue-slots {
    display: flex;
    gap: 6px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .queue-slot {
    width: 32px;
    height: 10px;
    border-radius: 4px;
    background: rgba(255,255,255,0.06);
    transition: all 0.3s;
  }

  .queue-slot.active { background: var(--accent); box-shadow: 0 0 8px var(--accent-glow); }
  .queue-slot.queued { background: var(--yellow); opacity: 0.6; }

  /* Two column grid */
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
  @media (max-width: 900px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }

  /* Clients Table */
  .table-wrap { overflow-x: auto; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th {
    text-align: left;
    padding: 10px 14px;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--glass-border);
  }

  td {
    padding: 12px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    vertical-align: middle;
  }

  tr:hover td { background: rgba(255,255,255,0.02); }

  tr:last-child td { border-bottom: none; }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 600;
    font-family: 'Inter', sans-serif;
  }

  .badge-green { background: var(--green-dim); color: var(--green); }
  .badge-yellow { background: var(--yellow-dim); color: var(--yellow); }
  .badge-red { background: var(--red-dim); color: var(--red); }
  .badge-blue { background: var(--blue-dim); color: var(--blue); }
  .badge-purple { background: rgba(124,58,237,0.15); color: #a78bfa; }

  /* Logs */
  .log-container {
    height: 320px;
    overflow-y: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    line-height: 1.7;
    background: var(--bg2);
    border-radius: var(--radius-sm);
    padding: 14px;
    scroll-behavior: smooth;
  }

  .log-container::-webkit-scrollbar { width: 4px; }
  .log-container::-webkit-scrollbar-track { background: transparent; }
  .log-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }

  .log-line { display: flex; gap: 12px; margin-bottom: 2px; }
  .log-time { color: var(--text-muted); flex-shrink: 0; }
  .log-msg.success { color: var(--green); }
  .log-msg.error { color: var(--red); }
  .log-msg.warn { color: var(--yellow); }
  .log-msg.info { color: var(--blue); }
  .log-msg.cache { color: #a78bfa; }
  .log-msg.default { color: var(--text-dim); }

  /* Cache Files */
  .cache-list {
    height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cache-list::-webkit-scrollbar { width: 4px; }
  .cache-list::-webkit-scrollbar-track { background: transparent; }
  .cache-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }

  .cache-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--bg2);
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
  }

  .cache-item-name {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  .cache-item-meta {
    display: flex;
    gap: 12px;
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: 11px;
  }

  /* Controls */
  .controls-grid {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .control-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    background: var(--bg2);
    border-radius: var(--radius-sm);
    gap: 12px;
  }

  .control-label {
    font-size: 13px;
    font-weight: 500;
  }

  .control-desc {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .control-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  input[type="range"] {
    -webkit-appearance: none;
    width: 120px;
    height: 6px;
    border-radius: 3px;
    background: rgba(255,255,255,0.1);
    outline: none;
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), #a855f7);
    cursor: pointer;
    box-shadow: 0 0 8px var(--accent-glow);
  }

  .range-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 700;
    min-width: 20px;
    text-align: center;
  }

  /* Buttons */
  .btn {
    padding: 9px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

  .btn-primary {
    background: linear-gradient(135deg, var(--accent), #a855f7);
    color: white;
    box-shadow: 0 4px 16px var(--accent-glow);
  }

  .btn-danger {
    background: var(--red-dim);
    color: var(--red);
    border: 1px solid rgba(239,68,68,0.2);
  }

  .btn-danger:hover { background: rgba(239,68,68,0.25); }

  .btn-ghost {
    background: var(--glass);
    color: var(--text-dim);
    border: 1px solid var(--glass-border);
  }

  .btn-ghost:hover { color: var(--text); border-color: rgba(255,255,255,0.14); }

  .btn-yellow {
    background: var(--yellow-dim);
    color: var(--yellow);
    border: 1px solid rgba(245,158,11,0.2);
  }

  /* Cross-Server Monitor */
  .server-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }

  .server-monitor-card {
    background: var(--bg2);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-sm);
    padding: 16px;
    transition: all 0.2s;
  }

  .server-monitor-card:hover { border-color: rgba(255,255,255,0.14); transform: translateY(-1px); }

  .server-monitor-card .smh {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .server-monitor-card .smh .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .server-monitor-card .smh .dot.online { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .server-monitor-card .smh .dot.offline { background: var(--red); }

  .server-monitor-card .smh .name { font-weight: 600; font-size: 14px; flex: 1; }
  .server-monitor-card .smh .tag { font-size: 11px; color: var(--text-muted); }

  .server-monitor-stats {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    margin-bottom: 12px;
  }

  .sm-stat { text-align: center; }
  .sm-stat .v { font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 700; }
  .sm-stat .l { font-size: 10px; color: var(--text-muted); }

  .add-server-form {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  .add-server-form input {
    flex: 1;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid var(--glass-border);
    background: var(--bg2);
    color: var(--text);
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    outline: none;
    transition: border-color 0.2s;
  }

  .add-server-form input:focus { border-color: var(--accent); }

  /* Toast */
  .toast-container {
    position: fixed;
    bottom: 24px;
    right: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    pointer-events: none;
  }

  .toast {
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 500;
    backdrop-filter: blur(20px);
    animation: slideIn 0.3s ease;
    pointer-events: all;
  }

  .toast.success { background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.3); color: var(--green); }
  .toast.error { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: var(--red); }
  .toast.info { background: rgba(124,58,237,0.15); border: 1px solid rgba(124,58,237,0.3); color: #a78bfa; }

  @keyframes slideIn {
    from { opacity: 0; transform: translateX(20px); }
    to { opacity: 1; transform: translateX(0); }
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    backdrop-filter: blur(6px);
    z-index: 500;
    display: none;
    align-items: center;
    justify-content: center;
  }

  .modal-overlay.active { display: flex; }

  .modal {
    background: var(--bg3);
    border: 1px solid var(--glass-border);
    border-radius: 20px;
    padding: 32px;
    width: 380px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }

  .modal h3 { font-size: 18px; font-weight: 700; margin-bottom: 10px; }
  .modal p { font-size: 14px; color: var(--text-dim); margin-bottom: 24px; line-height: 1.6; }

  .modal .modal-btns { display: flex; gap: 10px; justify-content: center; }

  /* Uptime counter */
  #uptime-display { font-family: 'JetBrains Mono', monospace; }

  /* Empty state */
  .empty {
    text-align: center;
    padding: 40px;
    color: var(--text-muted);
    font-size: 13px;
  }

  /* Membar */
  .mem-bars {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
  }

  .mem-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .mem-label {
    font-size: 11px;
    color: var(--text-dim);
    width: 70px;
    flex-shrink: 0;
  }

  .mem-bar-track {
    flex: 1;
    height: 6px;
    border-radius: 99px;
    background: rgba(255,255,255,0.06);
    overflow: hidden;
  }

  .mem-bar-fill {
    height: 100%;
    border-radius: 99px;
    background: linear-gradient(90deg, var(--accent), #a855f7);
    transition: width 0.6s ease;
  }

  .mem-val {
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-muted);
    width: 52px;
    text-align: right;
  }

  /* Scrollbar global */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 6px; }
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login-screen">
  <div class="login-card">
    <div class="logo">🎛️</div>
    <h2>Music Engine Admin</h2>
    <p>Enter your admin password to continue</p>
    <input type="password" id="pwd-input" placeholder="Admin password" autocomplete="current-password"/>
    <button class="btn-login" onclick="doLogin()">Unlock Dashboard</button>
    <div class="login-error" id="login-error">❌ Incorrect password</div>
  </div>
</div>

<!-- Toast Container -->
<div class="toast-container" id="toasts"></div>

<!-- Confirm Modal -->
<div class="modal-overlay" id="confirm-modal">
  <div class="modal">
    <h3 id="modal-title">Confirm Action</h3>
    <p id="modal-body">Are you sure?</p>
    <div class="modal-btns">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" id="modal-confirm-btn">Confirm</button>
    </div>
  </div>
</div>

<!-- Main App -->
<div id="app">
  <!-- Topbar -->
  <div class="topbar">
    <div class="topbar-logo">
      <div class="icon">🎛️</div>
      Admin
    </div>
    <div class="server-tabs" id="server-tabs"></div>
    <div class="topbar-right">
      <div class="live-badge">
        <div class="live-dot"></div>
        LIVE
      </div>
      <button class="btn-logout" onclick="logout()">Sign Out</button>
    </div>
  </div>

  <!-- Main Content -->
  <div class="main" id="main-content">
    <div class="empty">Select a server above to start monitoring.</div>
  </div>
</div>

<script>
// ── State ──────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'ADMIN_PASSWORD_PLACEHOLDER';
let authed = false;
let pollTimer = null;
let uptimeTimer = null;
let servers = [];
let activeIdx = -1;
let modalAction = null;

// ── Auth ───────────────────────────────────────────────────────────────
function doLogin() {
  const val = document.getElementById('pwd-input').value;
  if (val === ADMIN_PASSWORD || ADMIN_PASSWORD === 'ADMIN_PASSWORD_PLACEHOLDER') {
    authed = true;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    init();
  } else {
    document.getElementById('login-error').style.display = 'block';
    setTimeout(() => { document.getElementById('login-error').style.display = 'none'; }, 2000);
  }
}

document.getElementById('pwd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function logout() {
  authed = false;
  clearInterval(pollTimer);
  clearInterval(uptimeTimer);
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// ── Init ───────────────────────────────────────────────────────────────
function init() {
  // The current server is always this page's own origin
  const thisServer = { name: detectServerType(), url: window.location.origin, data: null, online: false };
  servers = [thisServer];

  // Load saved extra servers from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem('extra_servers') || '[]');
    saved.forEach(s => servers.push({ name: s.name || s.url, url: s.url, data: null, online: false }));
  } catch (_) {}

  renderTabs();
  switchServer(0);
}

function detectServerType() {
  return document.title.includes('Worker') ? '⚡ Download Worker' : '🏠 Residential Bridge';
}

// ── Tabs ───────────────────────────────────────────────────────────────
function renderTabs() {
  const tabs = document.getElementById('server-tabs');
  tabs.innerHTML = servers.map((s, i) => \`
    <div class="server-tab \${i === activeIdx ? 'active' : ''}" onclick="switchServer(\${i})">
      <div class="status-dot \${s.online ? 'online' : 'offline'}"></div>
      \${s.name}
    </div>
  \`).join('');
}

function switchServer(idx) {
  activeIdx = idx;
  renderTabs();
  clearInterval(pollTimer);
  clearInterval(uptimeTimer);
  poll();
  pollTimer = setInterval(poll, 3000);
}

// ── Polling ────────────────────────────────────────────────────────────
async function poll() {
  if (activeIdx < 0 || activeIdx >= servers.length) return;
  const s = servers[activeIdx];

  try {
    const [healthRes, clientsRes, logsRes, cacheRes] = await Promise.all([
      fetch(\`\${s.url}/health\`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(\`\${s.url}/clients\`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(\`\${s.url}/logs\`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(\`\${s.url}/cache-files\`).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    s.online = !!healthRes;
    s.data = { health: healthRes, clients: clientsRes, logs: logsRes, cache: cacheRes };
    renderTabs();
    renderDashboard(s);

    // Also poll extra servers for cross-monitor cards
    pollExtraServers();
  } catch (e) {
    s.online = false;
    renderTabs();
  }
}

async function pollExtraServers() {
  for (let i = 0; i < servers.length; i++) {
    if (i === activeIdx) continue;
    const s = servers[i];
    try {
      const h = await fetch(\`\${s.url}/health\`).then(r => r.ok ? r.json() : null).catch(() => null);
      s.online = !!h;
      s.data = { health: h, clients: null, logs: null, cache: null };
    } catch (_) { s.online = false; }
  }
  renderTabs();
}

// ── Render Dashboard ───────────────────────────────────────────────────
function renderDashboard(s) {
  if (!s.online || !s.data || !s.data.health) {
    document.getElementById('main-content').innerHTML = \`
      <div class="card">
        <div style="text-align:center;padding:60px 0;">
          <div style="font-size:48px;margin-bottom:16px;">🔴</div>
          <div style="font-size:18px;font-weight:700;margin-bottom:8px;">Server Offline</div>
          <div style="color:var(--text-dim);font-size:14px;">\${s.url} is not responding</div>
        </div>
      </div>\`;
    return;
  }

  const h = s.data.health;
  const clients = s.data.clients;
  const logs = s.data.logs;
  const cache = s.data.cache;

  const isWorker = h.service === 'download_worker';
  const uptime = h.uptimeSeconds || 0;
  const mem = h.memory || {};
  const conc = h.concurrency || {};
  const stats = h.stats || {};
  const rssMB = parseFloat(mem.rssMB) || 0;
  const heapMB = parseFloat(mem.heapUsedMB) || 0;
  const maxMemMB = 512;
  const rssPercent = Math.min(100, (rssMB / maxMemMB) * 100);
  const heapPercent = Math.min(100, (heapMB / maxMemMB) * 100);

  document.getElementById('main-content').innerHTML = \`
    <!-- Stats Row -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">⏱️</div>
        <div class="stat-label">Uptime</div>
        <div class="stat-value" id="uptime-display" data-start="\${Date.now() - uptime * 1000}">\${fmt(uptime)}</div>
        <div class="stat-sub">since last restart</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">⬇️</div>
        <div class="stat-label">Active Downloads</div>
        <div class="stat-value" style="color:\${conc.activeDownloads > 0 ? 'var(--accent)' : 'var(--green)'}">\${conc.activeDownloads || 0}</div>
        <div class="stat-sub">/ \${conc.maxConcurrent || 1} max concurrent</div>
        <div class="queue-slots">
          \${buildSlots(conc.maxConcurrent || 1, conc.activeDownloads || 0, conc.queueLength || 0)}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📋</div>
        <div class="stat-label">Queue Length</div>
        <div class="stat-value" style="color:\${conc.queueLength > 0 ? 'var(--yellow)' : 'var(--text)'}">\${conc.queueLength || 0}</div>
        <div class="stat-sub">pending requests</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">✅</div>
        <div class="stat-label">Total Served</div>
        <div class="stat-value">\${stats.totalDownloadsServed || stats.totalStreamsServed || 0}</div>
        <div class="stat-sub">all-time streams</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">👥</div>
        <div class="stat-label">Client Servers</div>
        <div class="stat-value">\${stats.connectedClientsCount || 0}</div>
        <div class="stat-sub">connected bots</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🧠</div>
        <div class="stat-label">Memory</div>
        <div class="stat-value" style="font-size:20px;margin-top:4px;">\${rssMB.toFixed(0)} <span style="font-size:13px;color:var(--text-dim)">MB RSS</span></div>
        <div class="mem-bars">
          <div class="mem-row">
            <div class="mem-label">RSS</div>
            <div class="mem-bar-track"><div class="mem-bar-fill \${rssPercent > 75 ? 'red' : rssPercent > 50 ? 'yellow' : ''}" style="width:\${rssPercent}%"></div></div>
            <div class="mem-val">\${rssMB.toFixed(1)} MB</div>
          </div>
          <div class="mem-row">
            <div class="mem-label">Heap</div>
            <div class="mem-bar-track"><div class="mem-bar-fill green" style="width:\${heapPercent}%"></div></div>
            <div class="mem-val">\${heapMB.toFixed(1)} MB</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Clients + Controls -->
    <div class="grid-2">
      <!-- Clients Table -->
      <div class="card">
        <div class="card-title">👥 Connected Client Servers</div>
        \${renderClientsTable(clients)}
      </div>

      <!-- Controls -->
      <div class="card">
        <div class="card-title">⚙️ Controls</div>
        <div class="controls-grid">
          <div class="control-row">
            <div>
              <div class="control-label">Max Concurrent Downloads</div>
              <div class="control-desc">Currently active: \${conc.activeDownloads || 0} / \${conc.maxConcurrent || 1}</div>
            </div>
            <div class="control-right">
              <input type="range" min="1" max="5" value="\${conc.maxConcurrent || 1}" oninput="this.nextElementSibling.textContent=this.value" onchange="setMaxConcurrent(this.value, '\${s.url}')"/>
              <div class="range-value">\${conc.maxConcurrent || 1}</div>
            </div>
          </div>
          <div class="control-row">
            <div>
              <div class="control-label">Clear Cache</div>
              <div class="control-desc">Delete all cached audio files (\${cache ? cache.totalFiles + ' files, ' + cache.totalMB + ' MB' : '...' })</div>
            </div>
            <button class="btn btn-danger" onclick="confirmClearCache('\${s.url}')">🗑️ Clear</button>
          </div>
          <div class="control-row">
            <div>
              <div class="control-label">Drain Queue</div>
              <div class="control-desc">Reject all \${conc.queueLength || 0} queued requests immediately</div>
            </div>
            <button class="btn btn-yellow" onclick="confirmDrainQueue('\${s.url}')">⚡ Drain</button>
          </div>
          <div class="control-row">
            <div>
              <div class="control-label">Force GC</div>
              <div class="control-desc">Hint Node.js to run garbage collection</div>
            </div>
            <button class="btn btn-ghost" onclick="forceGC('\${s.url}')">🧹 Run GC</button>
          </div>
          <div class="control-row">
            <div>
              <div class="control-label">Open Raw Health</div>
              <div class="control-desc">View raw JSON from /health endpoint</div>
            </div>
            <a href="\${s.url}/health" target="_blank" class="btn btn-ghost">🔗 Open</a>
          </div>
        </div>
      </div>
    </div>

    <!-- Cache Files + Live Log -->
    <div class="grid-2">
      <div class="card">
        <div class="card-title" style="justify-content:space-between">
          📁 Cached Tracks
          <span style="font-weight:400;font-size:12px;color:var(--text-muted)">\${cache ? cache.totalFiles + ' files · ' + cache.totalMB + ' MB' : ''}</span>
        </div>
        \${cache ? renderCacheBar(cache) : ''}
        <div class="cache-list" style="margin-top:12px">
          \${renderCacheFiles(cache)}
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="justify-content:space-between">
          📋 Live Activity Log
          <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="document.getElementById('log-box').scrollTop=document.getElementById('log-box').scrollHeight">↓ Latest</button>
        </div>
        <div class="log-container" id="log-box">
          \${renderLogs(logs)}
        </div>
      </div>
    </div>

    <!-- Cross-Server Monitor -->
    <div class="card">
      <div class="card-title">🌐 Cross-Server Monitor</div>
      <div class="server-cards" id="monitor-cards">
        \${renderMonitorCards()}
      </div>
      <div class="add-server-form">
        <input type="text" id="add-server-url" placeholder="http://other-server:3000" />
        <input type="text" id="add-server-name" placeholder="Server name (optional)" style="max-width:180px"/>
        <button class="btn btn-primary" onclick="addServer()">+ Add Server</button>
      </div>
    </div>
  \`;

  startUptimeClock(Date.now() - uptime * 1000);
}

function buildSlots(max, active, queued) {
  let html = '';
  for (let i = 0; i < Math.max(max, active, 3); i++) {
    const cls = i < active ? 'active' : (i < active + queued ? 'queued' : '');
    html += \`<div class="queue-slot \${cls}"></div>\`;
  }
  return html;
}

function renderClientsTable(clients) {
  if (!clients || !clients.clients || clients.clients.length === 0) {
    return '<div class="empty">No client servers have connected yet.</div>';
  }
  const rows = clients.clients.map(c => {
    const hitRate = c.requests > 0 ? Math.round((c.cacheHits / c.requests) * 100) : 0;
    const ago = c.lastSeenAgoSeconds !== undefined ? c.lastSeenAgoSeconds : '?';
    return \`
      <tr>
        <td><span class="badge badge-purple">🖥️ \${c.clientId}</span></td>
        <td>\${c.requests}</td>
        <td>\${c.cacheHits} <span style="color:var(--text-muted);font-size:10px">(\${hitRate}%)</span></td>
        <td>\${c.downloads}</td>
        <td style="color:\${c.failures > 0 ? 'var(--red)' : 'var(--text-muted)'}">\${c.failures}</td>
        <td style="color:var(--text-muted)">\${fmtAgo(ago)}</td>
      </tr>\`;
  }).join('');
  return \`
    <div class="table-wrap">
      <table>
        <thead><tr><th>Client</th><th>Requests</th><th>Cache Hits</th><th>Downloads</th><th>Failures</th><th>Last Seen</th></tr></thead>
        <tbody>\${rows}</tbody>
      </table>
    </div>\`;
}

function renderCacheBar(cache) {
  const pct = Math.min(100, ((cache.totalMB || 0) / (cache.maxMB || 400)) * 100);
  const cls = pct > 85 ? 'red' : pct > 60 ? 'yellow' : 'green';
  return \`<div class="progress-bar"><div class="progress-fill \${cls}" style="width:\${pct}%"></div></div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:'JetBrains Mono',monospace">\${cache.totalMB || 0} MB / \${cache.maxMB || 400} MB used</div>\`;
}

function renderCacheFiles(cache) {
  if (!cache || !cache.files || cache.files.length === 0) {
    return '<div class="empty">No cached files yet.</div>';
  }
  return cache.files.map(f => \`
    <div class="cache-item">
      <div class="cache-item-name" title="\${f.name}">\${f.name}</div>
      <div class="cache-item-meta">
        <span>\${f.sizeMB} MB</span>
        <span>\${f.ageMin}m ago</span>
      </div>
    </div>\`).join('');
}

function renderLogs(logs) {
  if (!logs || !logs.entries || logs.entries.length === 0) {
    return '<div class="empty">No log entries yet.</div>';
  }
  return logs.entries.map(e => {
    const cls = e.type || 'default';
    return \`<div class="log-line"><span class="log-time">\${e.time}</span><span class="log-msg \${cls}">\${escapeHtml(e.msg)}</span></div>\`;
  }).join('');
}

function renderMonitorCards() {
  return servers.map((s, i) => {
    const h = s.data && s.data.health;
    const conc = h && h.concurrency ? h.concurrency : {};
    return \`
      <div class="server-monitor-card">
        <div class="smh">
          <div class="dot \${s.online ? 'online' : 'offline'}"></div>
          <div class="name">\${s.name}</div>
          <div class="tag">\${s.online ? '● Online' : '○ Offline'}</div>
        </div>
        <div class="server-monitor-stats">
          <div class="sm-stat"><div class="v" style="color:var(--accent)">\${conc.activeDownloads || 0}</div><div class="l">Active</div></div>
          <div class="sm-stat"><div class="v" style="color:var(--yellow)">\${conc.queueLength || 0}</div><div class="l">Queued</div></div>
          <div class="sm-stat"><div class="v">\${h && h.stats ? (h.stats.totalDownloadsServed || h.stats.totalStreamsServed || 0) : 0}</div><div class="l">Served</div></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="switchServer(\${i})">View Dashboard</button>
          \${i > 0 ? \`<button class="btn btn-danger" style="padding:9px 12px" onclick="removeServer(\${i})">✕</button>\` : ''}
        </div>
      </div>\`;
  }).join('');
}

// ── Uptime Clock ───────────────────────────────────────────────────────
function startUptimeClock(startTimestamp) {
  clearInterval(uptimeTimer);
  uptimeTimer = setInterval(() => {
    const el = document.getElementById('uptime-display');
    if (el) el.textContent = fmt(Math.floor((Date.now() - startTimestamp) / 1000));
  }, 1000);
}

function fmt(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return \`\${h}h \${m}m\`;
  if (m > 0) return \`\${m}m \${sec}s\`;
  return \`\${sec}s\`;
}

function fmtAgo(sec) {
  if (sec < 10) return 'just now';
  if (sec < 60) return \`\${sec}s ago\`;
  if (sec < 3600) return \`\${Math.floor(sec/60)}m ago\`;
  return \`\${Math.floor(sec/3600)}h ago\`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Actions ────────────────────────────────────────────────────────────
async function setMaxConcurrent(val, baseUrl) {
  try {
    const r = await fetch(\`\${baseUrl}/config\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${document.getElementById('pwd-input').value || ADMIN_PASSWORD}\` },
      body: JSON.stringify({ maxConcurrent: parseInt(val) })
    });
    const d = await r.json();
    if (d.ok) toast('✅ Max concurrent updated to ' + val, 'success');
    else toast('❌ ' + (d.error || 'Failed'), 'error');
  } catch (e) { toast('❌ Request failed: ' + e.message, 'error'); }
}

function confirmClearCache(baseUrl) {
  showModal('Clear Cache?', 'This will permanently delete all cached audio files. Running downloads will not be affected.', () => clearCache(baseUrl));
}

async function clearCache(baseUrl) {
  try {
    const r = await fetch(\`\${baseUrl}/clear-cache\`, {
      method: 'POST',
      headers: { 'Authorization': \`Bearer \${document.getElementById('pwd-input').value || ADMIN_PASSWORD}\` }
    });
    const d = await r.json();
    if (d.ok) toast(\`🗑️ Cleared \${d.deletedCount} cached files (\${d.freedMB} MB freed)\`, 'success');
    else toast('❌ ' + (d.error || 'Failed'), 'error');
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}

function confirmDrainQueue(baseUrl) {
  showModal('Drain Queue?', 'All pending queued requests will be rejected with 503. Active downloads will continue.', () => drainQueue(baseUrl));
}

async function drainQueue(baseUrl) {
  try {
    const r = await fetch(\`\${baseUrl}/drain-queue\`, {
      method: 'POST',
      headers: { 'Authorization': \`Bearer \${document.getElementById('pwd-input').value || ADMIN_PASSWORD}\` }
    });
    const d = await r.json();
    if (d.ok) toast(\`⚡ Drained \${d.drained} queued requests\`, 'success');
    else toast('❌ ' + (d.error || 'Failed'), 'error');
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}

async function forceGC(baseUrl) {
  try {
    const r = await fetch(\`\${baseUrl}/gc\`, {
      method: 'POST',
      headers: { 'Authorization': \`Bearer \${document.getElementById('pwd-input').value || ADMIN_PASSWORD}\` }
    });
    const d = await r.json();
    toast('🧹 ' + (d.message || 'GC hint sent'), 'info');
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}

// ── Cross-Server Monitor ───────────────────────────────────────────────
function addServer() {
  const url = document.getElementById('add-server-url').value.trim().replace(/\\/$/, '');
  const name = document.getElementById('add-server-name').value.trim() || url;
  if (!url) { toast('❌ Enter a server URL', 'error'); return; }
  if (servers.some(s => s.url === url)) { toast('⚠️ Already added', 'info'); return; }
  servers.push({ name, url, data: null, online: false });
  saveExtraServers();
  renderTabs();
  toast('✅ Server added', 'success');
  document.getElementById('add-server-url').value = '';
  document.getElementById('add-server-name').value = '';
}

function removeServer(idx) {
  servers.splice(idx, 1);
  saveExtraServers();
  if (activeIdx >= servers.length) activeIdx = servers.length - 1;
  renderTabs();
  renderMonitorCards && poll();
}

function saveExtraServers() {
  const extra = servers.slice(1).map(s => ({ url: s.url, name: s.name }));
  localStorage.setItem('extra_servers', JSON.stringify(extra));
}

// ── Modal & Toast ──────────────────────────────────────────────────────
function showModal(title, body, onConfirm) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  document.getElementById('confirm-modal').classList.add('active');
  modalAction = () => { closeModal(); onConfirm(); };
  document.getElementById('modal-confirm-btn').onclick = modalAction;
}

function closeModal() {
  document.getElementById('confirm-modal').classList.remove('active');
  modalAction = null;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = \`toast \${type}\`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
</script>
</body>
</html>
`;

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Clean up any stale temp files on boot
try {
  const stale = fs.readdirSync(CACHE_DIR);
  for (const f of stale) {
    if (f.endsWith('.tmp') || f.endsWith('.part') || f.includes('.temp.')) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (_) {}
    }
  }
} catch (_) {}

// ==========================================
// 📋 CIRCULAR LOG BUFFER (last 200 events)
// ==========================================
const LOG_BUFFER = [];
const LOG_MAX = 200;

function classifyLog(msg) {
  if (/✅|success|cached|served|HIT/i.test(msg)) return 'success';
  if (/❌|error|fail|FAIL/i.test(msg)) return 'error';
  if (/⏳|queued|queue|waiting/i.test(msg)) return 'warn';
  if (/⚡|cache HIT|instant/i.test(msg)) return 'cache';
  if (/📥|incoming|request|client/i.test(msg)) return 'info';
  return 'default';
}

function addLog(msg) {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  LOG_BUFFER.push({ time, msg: String(msg), type: classifyLog(msg) });
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
}

// Intercept console.log for the log buffer
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);
console.log = (...args) => { const m = args.join(' '); addLog(m); _origLog(m); };
console.error = (...args) => { const m = args.join(' '); addLog(m); _origErr(m); };
console.warn = (...args) => { const m = args.join(' '); addLog(m); _origWarn(m); };

function checkAdminAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token === ADMIN_PASSWORD;
}

// ==========================================
// 🛡️ MULTI-CLIENT & CONCURRENCY THROTTLE
// ==========================================
let MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 1;
let activeDownloads = 0;
let totalDownloadsServed = 0;
const downloadQueue = [];
const inFlightDownloads = new Map(); // key -> Promise<{ success, cachedFile, size, error }>
const clientStats = new Map(); // clientId -> { requests, cacheHits, downloads, failures, firstSeen, lastSeen }

function getClientIdentifier(req, reqUrl) {
  const queryClient = reqUrl.searchParams.get('client') || reqUrl.searchParams.get('clientId') || reqUrl.searchParams.get('bot');
  const headerClient = req.headers['x-client-id'] || req.headers['x-bot-name'] || req.headers['user-agent'];
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown-ip';
  const cleanIp = String(ip).split(',')[0].trim().replace(/^.*:/, '');

  if (queryClient) return String(queryClient).slice(0, 40);
  if (headerClient && !headerClient.includes('node') && !headerClient.includes('Mozilla')) {
    return String(headerClient).slice(0, 40);
  }
  return `server_${cleanIp || 'node'}`;
}

function trackClientEvent(clientId, eventType) {
  if (!clientStats.has(clientId)) {
    clientStats.set(clientId, {
      clientId,
      requests: 0,
      cacheHits: 0,
      downloads: 0,
      failures: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    });
  }
  const s = clientStats.get(clientId);
  s.lastSeen = Date.now();
  if (eventType === 'request') s.requests++;
  else if (eventType === 'cacheHit') s.cacheHits++;
  else if (eventType === 'download') s.downloads++;
  else if (eventType === 'failure') s.failures++;
}

function acquireDownloadSlot(clientId, targetUrl) {
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    activeDownloads++;
    return Promise.resolve({ queued: false, waitTimeMs: 0 });
  }

  const startTime = Date.now();
  const queuePos = downloadQueue.length + 1;
  console.log(`[Worker Queue] ⏳ Queueing download for [${clientId}] (Queue Pos: ${queuePos}, Active: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS})`);

  return new Promise((resolve, reject) => {
    downloadQueue.push({
      clientId,
      targetUrl,
      startTime,
      resolve: () => {
        const waitTimeMs = Date.now() - startTime;
        console.log(`[Worker Queue] 🟢 Dispatching queued download for [${clientId}] (waited ${waitTimeMs}ms)`);
        resolve({ queued: true, waitTimeMs });
      },
      reject
    });
  });
}

function releaseDownloadSlot() {
  if (downloadQueue.length > 0) {
    const nextItem = downloadQueue.shift();
    nextItem.resolve();
  } else {
    activeDownloads = Math.max(0, activeDownloads - 1);
  }
}

function removeQueuedDownload(targetReject) {
  const idx = downloadQueue.findIndex(q => q.reject === targetReject);
  if (idx !== -1) {
    const [removed] = downloadQueue.splice(idx, 1);
    console.log(`[Worker Queue] 🛑 Removed canceled download request for [${removed.clientId}] from queue.`);
  }
}

function getCacheKey(targetUrl) {
  const ytMatch = (targetUrl || '').match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return `yt_${ytMatch[1]}`;
  const normalized = (targetUrl || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
  return `track_${crypto.createHash('md5').update(normalized || 'unknown').digest('hex').slice(0, 16)}`;
}

async function pruneLRUCache() {
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    const trackFiles = [];
    let totalBytes = 0;

    for (const f of files) {
      if (f.endsWith('.m4a') && !f.includes('.temp.')) {
        const full = path.join(CACHE_DIR, f);
        try {
          const st = await fs.promises.stat(full);
          trackFiles.push({ path: full, size: st.size, mtime: st.mtimeMs });
          totalBytes += st.size;
        } catch (_) {}
      }
    }

    trackFiles.sort((a, b) => a.mtime - b.mtime);

    while ((trackFiles.length > MAX_CACHED_TRACKS || totalBytes > MAX_CACHE_SIZE_BYTES) && trackFiles.length > 5) {
      const oldest = trackFiles.shift();
      try {
        await fs.promises.unlink(oldest.path);
        totalBytes -= oldest.size;
        console.log(`🧹 [Worker LRU] Evicted old track: ${path.basename(oldest.path)}`);
      } catch (_) {}
    }
  } catch (err) {
    console.error('LRU prune error:', err.message);
  }
}

// 🎯 SMART CANDIDATE RANKER & SNIPPET SHIELD
// ===========================================
async function resolveBestCandidate(queryUrl, title, artist, expDur) {
  if (!queryUrl.startsWith('scsearch')) return queryUrl;

  const cleanQuery = queryUrl.replace(/^scsearch\d*:/, '').trim();
  const searchArg = `scsearch5:${cleanQuery}`;
  console.log(`[Worker Ranker] 🔍 Fetching top 5 SoundCloud candidates for: "${cleanQuery}"...`);

  return new Promise((resolve) => {
    try {
      try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (_) {}
      const proc = spawn(YTDLP_PATH, [
        '--dump-json',
        '--flat-playlist',
        '--no-warnings',
        '--socket-timeout', '10',
        searchArg
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      let rawOutput = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        resolve(queryUrl);
      }, 10000);

      proc.stdout.on('data', d => rawOutput += d.toString());

      proc.on('close', () => {
        clearTimeout(timer);
        const lines = rawOutput.trim().split('\n').filter(Boolean);
        const items = [];
        for (const l of lines) {
          try {
            const parsed = JSON.parse(l);
            if (parsed.url || parsed.webpage_url) {
              items.push({
                url: parsed.url || parsed.webpage_url,
                title: parsed.title || '',
                duration: Number(parsed.duration) || 0,
                uploader: parsed.uploader || parsed.channel || ''
              });
            }
          } catch (_) {}
        }

        if (items.length === 0) {
          return resolve(queryUrl);
        }

        // Rank the candidates
        const ranked = items.map(item => {
          let score = 0;
          const dur = item.duration || 0;

          // 1. Hard Snippet Shield: Disqualify previews under 75 seconds
          if (dur < 75) return { ...item, score: -9999, reason: 'Snippet' };
          // Disqualify 11+ minute mixes
          if (dur > 660) return { ...item, score: -500, reason: 'Mix' };

          // 2. Duration accuracy match
          if (expDur > 0) {
            const diff = Math.abs(dur - expDur);
            if (diff < 30) score += 60;
            else if (diff < 60) score += 40;
            else if (diff < 120) score += 20;
          } else if (dur >= 120 && dur <= 360) {
            score += 30;
          }

          // 3. Title token matching
          const matchTitle = (title || cleanQuery).toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const itemTitle = (item.title || '').toLowerCase();
          let titleHits = 0;
          matchTitle.forEach(w => { if (itemTitle.includes(w)) titleHits++; });
          score += (titleHits / Math.max(1, matchTitle.length)) * 40;

          // 4. Artist token matching
          if (artist) {
            const matchArtist = artist.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const itemUploader = (item.uploader || '').toLowerCase();
            let artistHits = 0;
            matchArtist.forEach(w => { if (itemTitle.includes(w) || itemUploader.includes(w)) artistHits++; });
            score += (artistHits / Math.max(1, matchArtist.length)) * 25;
          }

          // 5. Penalize low-quality tags
          if (/snippet|preview|teaser|earrape|ear rape|chipmunk/i.test(itemTitle)) score -= 60;

          return { ...item, score };
        }).sort((a, b) => b.score - a.score);

        const winner = ranked[0];
        if (winner && winner.score > -1000 && winner.url) {
          console.log(`[Worker Ranker] 🎯 Picked best candidate: "${winner.title}" (${winner.duration}s, score: ${winner.score})`);
          return resolve(winner.url);
        }

        resolve(items[0].url || queryUrl);
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(queryUrl);
      });
    } catch (_) {
      resolve(queryUrl);
    }
  });
}

// 📦 Core Downloader with In-Flight Coalescing
async function performDownload(key, targetUrl, reqTitle, reqArtist, reqDuration) {
  const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);

  // 1. Double check cache right before downloading
  if (fs.existsSync(cachedFile)) {
    const stats = fs.statSync(cachedFile);
    if (stats.size > 50000) {
      return { success: true, cachedFile, size: stats.size };
    }
  }

  // 2. Resolve Best Full-Length Candidate if needed
  let downloadTarget = targetUrl;
  if (targetUrl.startsWith('scsearch')) {
    downloadTarget = await resolveBestCandidate(targetUrl, reqTitle, reqArtist, reqDuration);
  }

  // 3. Acquire slot from concurrency queue
  await acquireDownloadSlot('downloader', targetUrl);

  const tempFile = path.join(CACHE_DIR, `${key}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.temp.m4a`);
  const ytdlpArgs = [
    '--force-ipv4',
    '--no-cache-dir',
    '--socket-timeout', '12',
    '--retries', '2',
    '--concurrent-fragments', '1',
    '--no-video',
    '--no-playlist',
    '--no-warnings',
    '--format', 'bestaudio/ba/b/best',
    '-o', tempFile,
    downloadTarget
  ];

  return new Promise((resolve) => {
    let proc = null;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      if (!settled && proc) {
        console.error(`[Worker] ⚠️ Download timed out after 45s for: ${targetUrl}`);
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
    }, 45000);

    try {
      try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (_) {}
      proc = spawn(YTDLP_PATH, ytdlpArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let errOutput = '';
      proc.stderr.on('data', d => { errOutput += d.toString(); });

      proc.on('close', async (code) => {
        settled = true;
        clearTimeout(timeoutTimer);
        releaseDownloadSlot();

        if (code === 0 && fs.existsSync(tempFile)) {
          const stats = fs.statSync(tempFile);
          if (stats.size > 50000) {
            try {
              await fs.promises.rename(tempFile, cachedFile);
            } catch (_) {
              try { await fs.promises.copyFile(tempFile, cachedFile); fs.unlinkSync(tempFile); } catch (_) {}
            }

            console.log(`[Worker] ✅ Track downloaded & cached (${(stats.size / 1024 / 1024).toFixed(2)} MB): ${key}.m4a`);
            totalDownloadsServed++;
            pruneLRUCache();
            return resolve({ success: true, cachedFile, size: stats.size });
          }
        }

        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
        console.error(`[Worker] ❌ Download failed for "${targetUrl}" (code ${code}): ${errOutput.slice(-200)}`);
        return resolve({ success: false, error: errOutput.slice(-200) || `Process exited with code ${code}` });
      });

      proc.on('error', (err) => {
        settled = true;
        clearTimeout(timeoutTimer);
        releaseDownloadSlot();
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
        return resolve({ success: false, error: err.message });
      });

    } catch (spawnErr) {
      settled = true;
      clearTimeout(timeoutTimer);
      releaseDownloadSlot();
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
      return resolve({ success: false, error: spawnErr.message });
    }
  });
}

const server = http.createServer(async (req, res) => {
  // CORS & Multi-Host headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id, X-Bot-Name');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientId = getClientIdentifier(req, reqUrl);
  trackClientEvent(clientId, 'request');

  // Multi-Client Health Check
  if (reqUrl.pathname === '/health') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'download_worker',
      uptimeSeconds: Math.floor(process.uptime()),
      concurrency: {
        activeDownloads,
        maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
        queueLength: downloadQueue.length
      },
      stats: {
        totalDownloadsServed,
        connectedClientsCount: clientStats.size
      },
      memory: {
        rssMB: (mem.rss / 1024 / 1024).toFixed(1),
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1)
      }
    }, null, 2));
  }

  // Detailed Connected Clients Report
  if (reqUrl.pathname === '/clients') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const clientsList = Array.from(clientStats.values()).map(c => ({
      ...c,
      lastSeenAgoSeconds: Math.round((Date.now() - c.lastSeen) / 1000)
    }));
    return res.end(JSON.stringify({
      totalClients: clientsList.length,
      activeDownloads,
      queueLength: downloadQueue.length,
      clients: clientsList
    }, null, 2));
  }

  // Fast Ping
  if (reqUrl.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('pong');
  }

  // Stream endpoint: GET /stream?url=<targetUrl>&client=<id>&title=...&artist=...&duration=...
  if (reqUrl.pathname === '/stream') {
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
    }

    const key = getCacheKey(targetUrl);
    const cachedFile = path.join(CACHE_DIR, `${key}.m4a`);

    console.log(`[Worker] 📥 Incoming request from [Client: ${clientId}] for: "${targetUrl}"`);

    // 1. Instant Cache Hit (0% CPU, 0s delay)
    if (fs.existsSync(cachedFile)) {
      try {
        const stats = fs.statSync(cachedFile);
        if (stats.size > 50000) {
          console.log(`[Worker] ⚡ Cache HIT for [Client: ${clientId}] (${(stats.size / 1024 / 1024).toFixed(2)} MB): ${key}.m4a`);
          trackClientEvent(clientId, 'cacheHit');
          totalDownloadsServed++;
          try { fs.utimesSync(cachedFile, new Date(), new Date()); } catch (_) {}

          res.writeHead(200, {
            'Content-Type': 'audio/mp4',
            'Content-Length': stats.size,
            'Cache-Control': 'public, max-age=86400',
            'X-Worker-Cache': 'HIT',
            'X-Worker-Client': clientId
          });
          return fs.createReadStream(cachedFile).pipe(res);
        }
      } catch (_) {}
    }

    // 2. In-Flight Coalescing (If another client server is already downloading this song)
    let downloadPromise;
    if (inFlightDownloads.has(key)) {
      console.log(`[Worker] 👥 Coalescing request for [Client: ${clientId}]: Reusing active in-flight download for "${targetUrl}"`);
      downloadPromise = inFlightDownloads.get(key);
    } else {
      const reqTitle = reqUrl.searchParams.get('title') || '';
      const reqArtist = reqUrl.searchParams.get('artist') || '';
      const reqDuration = parseInt(reqUrl.searchParams.get('duration') || '0', 10);

      downloadPromise = performDownload(key, targetUrl, reqTitle, reqArtist, reqDuration)
        .finally(() => {
          inFlightDownloads.delete(key);
        });

      inFlightDownloads.set(key, downloadPromise);
    }

    // Abort handling if client disconnects while waiting
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    const result = await downloadPromise;

    if (clientDisconnected) {
      console.log(`[Worker] 🛑 [Client: ${clientId}] disconnected before stream could be delivered.`);
      return;
    }

    if (result.success && result.cachedFile && fs.existsSync(result.cachedFile)) {
      trackClientEvent(clientId, 'download');
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'Content-Length': result.size,
        'Cache-Control': 'public, max-age=86400',
        'X-Worker-Cache': 'MISS',
        'X-Worker-Client': clientId
      });
      return fs.createReadStream(result.cachedFile).pipe(res);
    }

    // Download failed
    trackClientEvent(clientId, 'failure');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Download failed on worker',
        client: clientId,
        details: result.error || 'Unknown error'
      }));
    }
    return;
  }

  // ── Admin Dashboard ────────────────────────────────────────────────
  if (reqUrl.pathname === '/dashboard') {
    try {
      let html = DASHBOARD_HTML.replace('ADMIN_PASSWORD_PLACEHOLDER', ADMIN_PASSWORD);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Dashboard HTML not found: ' + e.message);
    }
  }

  // ── Live Logs ──────────────────────────────────────────────────────
  if (reqUrl.pathname === '/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ entries: LOG_BUFFER.slice().reverse() }, null, 2));
  }

  // ── Cache File List ────────────────────────────────────────────────
  if (reqUrl.pathname === '/cache-files') {
    try {
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.m4a') && !f.includes('.temp.'));
      let totalBytes = 0;
      const fileList = [];
      const now = Date.now();
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(CACHE_DIR, f));
          totalBytes += st.size;
          fileList.push({
            name: f,
            sizeMB: (st.size / 1024 / 1024).toFixed(2),
            ageMin: Math.round((now - st.mtimeMs) / 60000)
          });
        } catch (_) {}
      }
      fileList.sort((a, b) => a.ageMin - b.ageMin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        totalFiles: fileList.length,
        totalMB: (totalBytes / 1024 / 1024).toFixed(1),
        maxMB: MAX_CACHE_SIZE_BYTES / 1024 / 1024,
        files: fileList.slice(0, 100)
      }, null, 2));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Admin: Update Config (requires auth) ──────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/config') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (cfg.maxConcurrent) {
          MAX_CONCURRENT_DOWNLOADS = Math.max(1, Math.min(10, parseInt(cfg.maxConcurrent)));
          console.log(`⚙️ [Admin] Max concurrent updated to ${MAX_CONCURRENT_DOWNLOADS}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, maxConcurrent: MAX_CONCURRENT_DOWNLOADS }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── Admin: Clear Cache (requires auth) ────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/clear-cache') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    try {
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.m4a') && !f.includes('.temp.'));
      let freed = 0, count = 0;
      for (const f of files) {
        const fp = path.join(CACHE_DIR, f);
        try { const st = fs.statSync(fp); freed += st.size; fs.unlinkSync(fp); count++; } catch (_) {}
      }
      console.log(`🗑️ [Admin] Cache cleared: ${count} files, ${(freed / 1024 / 1024).toFixed(1)} MB freed`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, deletedCount: count, freedMB: (freed / 1024 / 1024).toFixed(1) }));
    } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Admin: Drain Queue (requires auth) ────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/drain-queue') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    const drained = downloadQueue.length;
    while (downloadQueue.length > 0) {
      const item = downloadQueue.shift();
      try { item.reject(new Error('Queue drained by admin')); } catch (_) {}
    }
    console.log(`⚡ [Admin] Queue drained: ${drained} requests rejected`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, drained }));
  }

  // ── Admin: Force GC ───────────────────────────────────────────────
  if (req.method === 'POST' && reqUrl.pathname === '/gc') {
    if (!checkAdminAuth(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    try { if (typeof global.gc === 'function') global.gc(); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, message: 'GC hint sent' }));
  }

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Not found',
    availableEndpoints: ['/dashboard', '/health', '/clients', '/logs', '/cache-files', '/ping', '/stream?url=...']
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================================');
  console.log(`🚀 Multi-Client Dedicated Audio Download Worker running on port ${PORT}`);
  console.log(`📍 yt-dlp executable: ${YTDLP_PATH}`);
  console.log(`🛡️ Max Concurrent Downloads: ${MAX_CONCURRENT_DOWNLOADS} (Guaranteed Low CPU)`);
  console.log(`📁 Cache Directory: ${CACHE_DIR} (Max ${MAX_CACHED_TRACKS} tracks / ${MAX_CACHE_SIZE_BYTES / 1024 / 1024} MB)`);
  console.log(`🎛️ Admin Dashboard: http://0.0.0.0:${PORT}/dashboard`);
  console.log('📡 Endpoints: /dashboard, /health, /clients, /logs, /cache-files, /ping, /stream');
  console.log('======================================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  server.close(() => process.exit(0));
});
