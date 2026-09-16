import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let server = fs.readFileSync(serverPath, 'utf8');

if (!server.includes('Render 24/7 Keep-Alive Sentinel')) {
  const sentinelCode = `
// ============================================================================
// 🛡️ Render 24/7 Keep-Alive Sentinel (Prevents Free-Tier Inactivity Sleep)
// ============================================================================
function armRenderKeepAlive() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (!externalUrl || externalUrl.includes('127.0.0.1') || externalUrl.includes('localhost')) {
    return;
  }

  const pingEndpoint = externalUrl.replace(/\\/+$/, '') + '/ping';
  console.log(\`🛡️ [Keep-Alive Sentinel] Armed 24/7 anti-sleep pinger -> \${pingEndpoint}\`);

  // Ping every 7 minutes (Render free tier spins down after 15 minutes of no HTTP traffic)
  setInterval(async () => {
    try {
      const res = await fetch(pingEndpoint, { 
        headers: { 'User-Agent': 'MusicEngine-KeepAlive/1.0' },
        timeout: 10000 
      });
      if (res.ok) {
        console.log(\`💓 [Keep-Alive Sentinel] Ping successful at \${new Date().toISOString().slice(11, 19)} (Render sleep timer reset)\`);
      }
    } catch (err) {
      console.warn(\`⚠️ [Keep-Alive Sentinel] Ping attempt failed: \${err.message}\`);
    }
  }, 7 * 60 * 1000);
}

armRenderKeepAlive();
`;

  server = server + sentinelCode;
  fs.writeFileSync(serverPath, server, 'utf8');
  console.log('✅ Render 24/7 Keep-Alive Sentinel added to server.js');
} else {
  console.log('ℹ️ Render Keep-Alive Sentinel already present in server.js');
}
