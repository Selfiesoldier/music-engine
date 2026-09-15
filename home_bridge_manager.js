try {
  await import('dotenv/config');
} catch (_) {}
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import fs from 'fs';

const rawBotUrls = process.env.BOT_SERVER_URLS || process.env.BOT_SERVER_URL || process.env.RENDER_BOT_URL || 'http://92.118.206.166:30139';
const BOT_SERVER_URLS = rawBotUrls.split(',').map(u => u.trim()).filter(Boolean);

function getCloudflaredPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'cloudflared.exe');
  }
  // Check system PATH first (e.g. native Termux package)
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
    return 'cloudflared';
  } catch (_) {}
  
  if (fs.existsSync(path.join(__dirname, 'cloudflared'))) {
    return path.join(__dirname, 'cloudflared');
  }
  return 'cloudflared';
}

const CLOUDFLARED_PATH = getCloudflaredPath();
const BRIDGE_SCRIPT = path.join(__dirname, 'residential_bridge.js');

console.log('🚀 Starting Residential Audio Bridge & Cloudflare Tunnel...');
console.log(`📍 Using cloudflared: ${CLOUDFLARED_PATH}`);

// 1. Start the local bridge HTTP server
const bridgeProcess = spawn('node', [BRIDGE_SCRIPT], {
  cwd: __dirname,
  stdio: 'inherit'
});

let registered = false;
let currentTunnelUrl = null;
let cfProcess = null;
let isShuttingDown = false;
let reconnectTimer = null;

const bridgeName = process.env.BRIDGE_NAME || (process.platform === 'win32' ? 'Home PC' : 'Termux Phone');

function registerWithRender(tunnelUrl) {
  currentTunnelUrl = tunnelUrl;
  console.log(`\n======================================================`);
  console.log(`🎉 Cloudflare Tunnel Established: ${tunnelUrl}`);
  console.log(`📡 Registering bridge "${bridgeName}" with ${BOT_SERVER_URLS.length} client bot server(s)...`);
  console.log(`======================================================\n`);

  BOT_SERVER_URLS.forEach(botUrl => {
    fetch(`${botUrl}/api/register-bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tunnelUrl, name: bridgeName })
    })
      .then(r => r.json())
      .then(data => {
        console.log(`✅ Bridge successfully registered with client [${botUrl}]:`, data);
      })
      .catch(err => {
        console.warn(`⚠️ Failed to register bridge with client [${botUrl}]: ${err.message}`);
      });
  });
  registered = true;
}

// Keep-alive heartbeat every 60s to all client servers
setInterval(() => {
  if (currentTunnelUrl && registered) {
    BOT_SERVER_URLS.forEach(botUrl => {
      fetch(`${botUrl}/api/register-bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: currentTunnelUrl, name: bridgeName })
      }).catch(() => {});
    });
  }
}, 60000);

function startTunnel() {
  if (isShuttingDown) return;
  registered = false;
  currentTunnelUrl = null;

  console.log('📡 Requesting Cloudflare Quick Tunnel (http2/IPv4)...');

  // --protocol http2 forces TCP port 443 (avoids UDP/QUIC drops on mobile networks)
  // --edge-ip-version 4 forces IPv4 (avoids Termux IPv6 routing timeouts)
  cfProcess = spawn(CLOUDFLARED_PATH, [
    'tunnel',
    '--protocol', 'http2',
    '--edge-ip-version', '4',
    '--url', 'http://127.0.0.1:8888'
  ], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  function handleOutput(data) {
    const text = data.toString();
    process.stdout.write(text);

    // Match https://[subdomain].trycloudflare.com (exclude api.trycloudflare.com)
    const match = text.match(/https:\/\/([a-zA-Z0-9-]+)\.trycloudflare\.com/);
    if (match && match[1] !== 'api' && !registered) {
      registerWithRender(match[0]);
    }
  }

  cfProcess.stdout.on('data', handleOutput);
  cfProcess.stderr.on('data', handleOutput);

  cfProcess.on('close', (code) => {
    if (isShuttingDown) return;
    console.log(`⚠️ Cloudflare tunnel disconnected (exit code ${code}). Reconnecting in 3 seconds...`);
    reconnectTimer = setTimeout(startTunnel, 3000);
  });
}

// Start initial tunnel
startTunnel();

bridgeProcess.on('close', (code) => {
  if (isShuttingDown) return;
  console.log(`Bridge server exited with code ${code}`);
  isShuttingDown = true;
  if (cfProcess) cfProcess.kill();
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  console.log('\nStopping Residential Bridge...');
  isShuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  bridgeProcess.kill();
  if (cfProcess) cfProcess.kill();
  process.exit(0);
});
