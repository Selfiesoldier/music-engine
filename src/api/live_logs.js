import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class LiveLogManager extends EventEmitter {
  constructor(maxLines = 1500) {
    super();
    this.maxLines = maxLines;
    this.buffer = [];
    this.initInterceptors();
    this.initBotLogTail();
  }

  push(text, type = 'info') {
    const cleanText = String(text || '').replace(/[\r\n]+$/, '');
    if (!cleanText) return;

    let detectedType = type;
    const lower = cleanText.toLowerCase();
    if (lower.includes('[bot]') || lower.includes('highrisebot:') || lower.includes('bot:')) detectedType = 'bot';
    else if (lower.includes('error') || lower.includes('failed') || lower.includes('exception') || lower.includes('err:')) detectedType = 'error';
    else if (lower.includes('warn') || lower.includes('timeout') || lower.includes('retrying')) detectedType = 'warn';
    else if (lower.includes('yt-dlp') || lower.includes('download') || lower.includes('cache') || lower.includes('pot provider')) detectedType = 'download';
    else if (lower.includes('stream') || lower.includes('playing') || lower.includes('queue') || lower.includes('ffmpeg')) detectedType = 'stream';

    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

    const entry = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      time: timeStr,
      rawTime: now.toISOString(),
      text: cleanText,
      type: detectedType
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxLines) {
      this.buffer.shift();
    }

    this.emit('log', entry);
  }

  initInterceptors() {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => {
      origLog(...args);
      try {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        this.push(msg, 'info');
      } catch (e) {}
    };

    console.warn = (...args) => {
      origWarn(...args);
      try {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        this.push(msg, 'warn');
      } catch (e) {}
    };

    console.error = (...args) => {
      origError(...args);
      try {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        this.push(msg, 'error');
      } catch (e) {}
    };
  }

  initBotLogTail() {
    const botLogPath = path.join(__dirname, 'logs', 'bot.log');
    let lastSize = -1;

    setInterval(() => {
      try {
        if (!fs.existsSync(botLogPath)) return;
        const stat = fs.statSync(botLogPath);
        if (lastSize === -1) {
          lastSize = Math.max(0, stat.size - 30000);
        }
        if (stat.size < lastSize) lastSize = 0; // Rotated or truncated
        if (stat.size > lastSize) {
          const stream = fs.createReadStream(botLogPath, {
            start: lastSize,
            end: stat.size,
            encoding: 'utf-8'
          });
          let chunk = '';
          stream.on('data', d => chunk += d);
          stream.on('end', () => {
            lastSize = stat.size;
            const lines = chunk.split(/[\r\n]+/);
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) this.push(`[Bot] ${trimmed}`, 'bot');
            }
          });
        }
      } catch (e) {}
    }, 1000);
  }

  getRecent(limit = 400) {
    return this.buffer.slice(-limit);
  }
}

export const liveLogger = new LiveLogManager(1500);

export function registerLiveLogs(app) {
  // 1. Raw Text Log Stream (CLI / curl / terminal / auto-refreshing in browser)
  app.get(['/logs/raw', '/api/logs/raw', '/logs/tail'], (req, res) => {
    // If live streaming / follow mode is requested, keep connection open like tail -f
    if (req.query.live === '1' || req.query.follow === '1' || req.query.stream === '1' || req.path === '/logs/tail') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const limit = parseInt(req.query.limit) || 300;
      for (const l of liveLogger.getRecent(limit)) {
        res.write(`[${l.time}] [${l.type.toUpperCase()}] ${l.text}\n`);
      }
      const listener = (entry) => {
        res.write(`[${entry.time}] [${entry.type.toUpperCase()}] ${entry.text}\n`);
      };
      liveLogger.on('log', listener);
      req.on('close', () => liveLogger.removeListener('log', listener));
      return;
    }

    // Default: refresh every 1 second in browser unless explicitly disabled (?refresh=0)
    const refreshSec = req.query.refresh !== undefined ? req.query.refresh : '1';
    if (refreshSec && refreshSec !== '0' && refreshSec !== 'false' && refreshSec !== 'none') {
      res.setHeader('Refresh', String(refreshSec));
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('text/plain; charset=utf-8');

    const limit = parseInt(req.query.limit) || 400;
    const lines = liveLogger.getRecent(limit).map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.text}`);
    res.send(lines.join('\n') || 'No logs captured yet.');
  });

  // 2. JSON API Endpoint
  app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 400;
    res.json({
      ok: true,
      totalBuffered: liveLogger.buffer.length,
      logs: liveLogger.getRecent(limit)
    });
  });

  // 3. Server-Sent Events (SSE) Live Stream Endpoint
  app.get(['/logs/stream', '/api/logs/stream'], (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Backlog dump upon connection
    const backlog = liveLogger.getRecent(200);
    res.write(`data: ${JSON.stringify({ type: 'init', logs: backlog })}\n\n`);

    const listener = (entry) => {
      res.write(`data: ${JSON.stringify({ type: 'log', log: entry })}\n\n`);
    };
    liveLogger.on('log', listener);

    // Keepalive comment ping every 12s to prevent Render / proxy timeouts
    const ping = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 12000);

    req.on('close', () => {
      clearInterval(ping);
      liveLogger.removeListener('log', listener);
    });
  });

  // 4. Live Cyber Terminal Web Dashboard
  app.get(['/logs', '/LOGS'], (req, res) => {
    res.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚡ Highrise Music Bot — Live Server Terminal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --panel: #111827;
      --border: #1f293d;
      --text: #e2e8f0;
      --muted: #64748b;
      --cyan: #38bdf8;
      --green: #4ade80;
      --amber: #fbbf24;
      --red: #f87171;
      --purple: #c084fc;
      --blue: #60a5fa;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: rgba(17, 24, 39, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      z-index: 10;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 1.05rem;
      letter-spacing: -0.02em;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      background: rgba(74, 222, 128, 0.1);
      border: 1px solid rgba(74, 222, 128, 0.3);
      color: var(--green);
      font-size: 0.75rem;
      font-weight: 600;
    }
    .pulse {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 10px var(--green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .search-box {
      background: #1e293b;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      color: #fff;
      font-family: inherit;
      font-size: 0.85rem;
      outline: none;
      width: 180px;
      transition: all 0.2s;
    }
    .search-box:focus {
      border-color: var(--cyan);
      width: 240px;
    }
    .filter-btn {
      background: #1e293b;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-btn:hover, .filter-btn.active {
      color: #fff;
      background: #334155;
      border-color: #475569;
    }
    .action-btn {
      background: #1e293b;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
      transition: all 0.15s;
    }
    .action-btn:hover {
      background: #334155;
      border-color: var(--cyan);
      color: var(--cyan);
    }
    .autoscroll-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
    }
    .terminal-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.84rem;
      line-height: 1.6;
      background: #070b14;
    }
    .log-line {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 2px 0;
      border-bottom: 1px solid rgba(255,255,255,0.02);
      word-break: break-word;
    }
    .log-time {
      color: var(--muted);
      font-size: 0.76rem;
      flex-shrink: 0;
      user-select: none;
    }
    .badge {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      flex-shrink: 0;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-info { background: rgba(56, 189, 248, 0.12); color: var(--cyan); }
    .badge-warn { background: rgba(251, 191, 36, 0.15); color: var(--amber); }
    .badge-error { background: rgba(248, 113, 113, 0.2); color: var(--red); }
    .badge-bot { background: rgba(192, 132, 252, 0.15); color: var(--purple); }
    .badge-download { background: rgba(74, 222, 128, 0.15); color: var(--green); }
    .badge-stream { background: rgba(96, 165, 250, 0.15); color: var(--blue); }
    .log-text {
      flex: 1;
      color: #cbd5e1;
      white-space: pre-wrap;
    }
    .log-line.type-error .log-text { color: #fca5a5; font-weight: 500; }
    .log-line.type-warn .log-text { color: #fde047; }
    .log-line.type-bot .log-text { color: #e9d5ff; }
    .log-line.type-download .log-text { color: #86efac; }
    .log-line.type-stream .log-text { color: #93c5fd; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>📻 Highrise Music Bot v2</span>
      <div class="status-pill">
        <span class="pulse"></span>
        <span id="connStatus">CONNECTED</span>
      </div>
      <span style="font-size: 0.78rem; color: var(--muted); font-weight: 400;" id="lineCount">0 logs</span>
    </div>
    <div class="controls">
      <input type="text" class="search-box" id="searchBox" placeholder="Filter logs...">
      <button class="filter-btn active" data-filter="all">ALL</button>
      <button class="filter-btn" data-filter="bot">BOT</button>
      <button class="filter-btn" data-filter="download">DOWNLOAD</button>
      <button class="filter-btn" data-filter="stream">STREAM</button>
      <button class="filter-btn" data-filter="error">ERRORS</button>
      <label class="autoscroll-toggle">
        <input type="checkbox" id="autoScrollCheck" checked> Auto-Scroll
      </label>
      <button class="action-btn" id="clearBtn">Clear</button>
      <button class="action-btn" id="copyBtn">Copy</button>
      <a class="action-btn" href="/logs/raw" target="_blank">Raw Text ↗</a>
      <a class="action-btn" href="/" target="_blank">Dashboard ↗</a>
    </div>
  </header>
  <div class="terminal-container" id="terminal"></div>

  <script>
    const terminal = document.getElementById('terminal');
    const connStatus = document.getElementById('connStatus');
    const lineCount = document.getElementById('lineCount');
    const searchBox = document.getElementById('searchBox');
    const autoScrollCheck = document.getElementById('autoScrollCheck');
    const clearBtn = document.getElementById('clearBtn');
    const copyBtn = document.getElementById('copyBtn');
    const filterBtns = document.querySelectorAll('.filter-btn');

    let allLogs = [];
    let currentFilter = 'all';
    let searchQuery = '';

    function renderLog(log, append = true) {
      const line = document.createElement('div');
      line.className = 'log-line type-' + log.type;
      line.dataset.type = log.type;
      line.dataset.text = log.text.toLowerCase();

      let badgeClass = 'badge-' + log.type;
      let badgeLabel = log.type;

      line.innerHTML = \`
        <span class="log-time">\${log.time}</span>
        <span class="badge \${badgeClass}">\${badgeLabel}</span>
        <span class="log-text">\${escapeHtml(log.text)}</span>
      \`;

      if (matchesFilter(log)) {
        line.style.display = 'flex';
      } else {
        line.style.display = 'none';
      }

      terminal.appendChild(line);

      if (autoScrollCheck.checked) {
        terminal.scrollTop = terminal.scrollHeight;
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function matchesFilter(log) {
      if (currentFilter !== 'all' && log.type !== currentFilter) return false;
      if (searchQuery && !log.text.toLowerCase().includes(searchQuery)) return false;
      return true;
    }

    function refilter() {
      const lines = terminal.querySelectorAll('.log-line');
      lines.forEach(line => {
        const type = line.dataset.type;
        const text = line.dataset.text;
        const matchType = (currentFilter === 'all' || type === currentFilter);
        const matchSearch = (!searchQuery || text.includes(searchQuery));
        line.style.display = (matchType && matchSearch) ? 'flex' : 'none';
      });
      if (autoScrollCheck.checked) {
        terminal.scrollTop = terminal.scrollHeight;
      }
    }

    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        refilter();
      });
    });

    searchBox.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      refilter();
    });

    clearBtn.addEventListener('click', () => {
      terminal.innerHTML = '';
      allLogs = [];
      lineCount.innerText = '0 logs';
    });

    copyBtn.addEventListener('click', () => {
      const text = allLogs.map(l => \`[\${l.time}] [\${l.type.toUpperCase()}] \${l.text}\`).join('\\n');
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerText = 'Copied!';
        setTimeout(() => copyBtn.innerText = 'Copy', 1500);
      });
    });

    function connectSSE() {
      const evt = new EventSource('/logs/stream');
      evt.onopen = () => {
        connStatus.innerText = 'CONNECTED';
        connStatus.style.color = 'var(--green)';
      };
      evt.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'init') {
            terminal.innerHTML = '';
            allLogs = data.logs || [];
            allLogs.forEach(l => renderLog(l));
            lineCount.innerText = allLogs.length + ' logs';
          } else if (data.type === 'log' && data.log) {
            allLogs.push(data.log);
            if (allLogs.length > 1500) allLogs.shift();
            renderLog(data.log);
            lineCount.innerText = allLogs.length + ' logs';
          }
        } catch (err) {}
      };
      evt.onerror = () => {
        connStatus.innerText = 'RECONNECTING...';
        connStatus.style.color = 'var(--amber)';
      };
    }

    connectSSE();
  </script>
</body>
</html>`);
  });
}
