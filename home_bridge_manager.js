import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import fs from 'fs';

const RENDER_BOT_URL = process.env.RENDER_BOT_URL || 'https://musicbot12-ld6i.onrender.com';
const CLOUDFLARED_PATH = process.platform === 'win32'
  ? path.join(__dirname, 'cloudflared.exe')
  : (fs.existsSync(path.join(__dirname, 'cloudflared')) ? path.join(__dirname, 'cloudflared') : 'cloudflared');
const BRIDGE_SCRIPT = path.join(__dirname, 'residential_bridge.js');

console.log('🚀 Starting Residential Audio Bridge & Cloudflare Tunnel...');

// 1. Start the local bridge HTTP server
const bridgeProcess = spawn('node', [BRIDGE_SCRIPT], {
  cwd: __dirname,
  stdio: 'inherit'
});

// 2. Start Cloudflare Tunnel pointing to local port 8888
const cfProcess = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', 'http://127.0.0.1:8888'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});

let registered = false;
let currentTunnelUrl = null;

function registerWithRender(tunnelUrl) {
  currentTunnelUrl = tunnelUrl;
  if (!registered) {
    console.log(`\n======================================================`);
    console.log(`🎉 Cloudflare Tunnel Established: ${tunnelUrl}`);
    console.log(`📡 Registering bridge URL with Render bot (${RENDER_BOT_URL})...`);
    console.log(`======================================================\n`);
  }

  fetch(`${RENDER_BOT_URL}/api/register-bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: tunnelUrl })
  })
    .then(r => r.json())
    .then(data => {
      if (!registered) {
        registered = true;
        console.log(`✅ Bridge successfully registered with Render:`, data);
        console.log(`🎵 Highrise bot will now fetch 100% of YouTube tracks via your residential IP!\n`);
      }
    })
    .catch(err => {
      console.warn(`⚠️ Failed to register bridge automatically: ${err.message}`);
    });
}

// Keep-alive heartbeat every 60s
setInterval(() => {
  if (currentTunnelUrl) {
    registerWithRender(currentTunnelUrl);
  }
}, 60000);

function handleOutput(data) {
  const text = data.toString();
  process.stdout.write(text);

  // Match https://[subdomain].trycloudflare.com
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (match && !registered) {
    registerWithRender(match[0]);
  }
}

cfProcess.stdout.on('data', handleOutput);
cfProcess.stderr.on('data', handleOutput);

cfProcess.on('close', (code) => {
  console.log(`Cloudflare tunnel exited with code ${code}`);
  bridgeProcess.kill();
  process.exit(code || 0);
});

bridgeProcess.on('close', (code) => {
  console.log(`Bridge server exited with code ${code}`);
  cfProcess.kill();
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  console.log('\nStopping Residential Bridge...');
  bridgeProcess.kill();
  cfProcess.kill();
  process.exit(0);
});
