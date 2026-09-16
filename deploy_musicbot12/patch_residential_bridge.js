import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(serverPath, 'utf8');

// 1. Add bridge state and API endpoints if not present
if (!content.includes('let residentialBridgeUrl =')) {
  const bridgeEndpoints = `
let residentialBridgeUrl = process.env.RESIDENTIAL_BRIDGE_URL || null;

app.post("/api/register-bridge", (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url parameter" });
  residentialBridgeUrl = url.trim().replace(/\\/+$/, '');
  console.log(\`🏠 [Bridge] Registered active residential audio bridge: \${residentialBridgeUrl}\`);
  res.json({ success: true, bridgeUrl: residentialBridgeUrl });
});

app.get("/api/bridge-status", async (req, res) => {
  if (!residentialBridgeUrl) return res.json({ active: false, bridgeUrl: null });
  try {
    const resp = await fetch(\`\${residentialBridgeUrl}/health\`, { signal: AbortSignal.timeout(4000) });
    const data = await resp.json();
    res.json({ active: true, bridgeUrl: residentialBridgeUrl, health: data });
  } catch (e) {
    res.json({ active: false, bridgeUrl: residentialBridgeUrl, error: e.message });
  }
});
`;
  content = content.replace('app.get("/ping", (req, res) => {', bridgeEndpoints + '\napp.get("/ping", (req, res) => {');
  console.log('Added bridge registration & status endpoints');
}

// 2. Add residential bridge download logic to downloadTrackToFile
const oldDownloadHeader = "async function downloadTrackToFile(url, outputPath, thisStreamId, title = '') {\n  const isDirectSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');";

const newDownloadLogic = `async function downloadTrackToFile(url, outputPath, thisStreamId, title = '') {
  const isDirectSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');

  // 0. Primary: If Home Residential Bridge is connected, stream authentic YouTube audio directly through residential IP
  if (!isDirectSoundCloud && residentialBridgeUrl) {
    try {
      console.log(\`🏠 [Downloader] Streaming YouTube audio via Residential Bridge (\${residentialBridgeUrl})...\`);
      const bridgeStreamUrl = \`\${residentialBridgeUrl}/stream?url=\${encodeURIComponent(url)}\`;
      const resp = await fetch(bridgeStreamUrl, { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) {
        throw new Error(\`Bridge returned HTTP status \${resp.status}\`);
      }
      const fileStream = fs.createWriteStream(outputPath);
      await new Promise((resolve, reject) => {
        resp.body.pipe(fileStream);
        resp.body.on('error', reject);
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
      if (thisStreamId !== currentStreamId) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
        throw new Error("Download aborted: Stream ID changed");
      }
      const stats = fs.statSync(outputPath);
      if (stats.size > 50000) {
        console.log(\`✅ [Downloader] YouTube track downloaded via Residential Bridge (\${(stats.size / 1024 / 1024).toFixed(2)} MB)\`);
        return outputPath;
      }
      console.warn(\`⚠️ [Downloader] Bridge file too small (\${stats.size} bytes), proceeding to cloud fallback...\`);
    } catch (bridgeErr) {
      if (thisStreamId !== currentStreamId) throw bridgeErr;
      console.warn(\`⚠️ [Downloader] Residential Bridge unavailable (\${bridgeErr.message}), falling back to direct cloud...\`);
    }
  }`;

if (content.includes(oldDownloadHeader) && !content.includes('// 0. Primary: If Home Residential Bridge is connected')) {
  content = content.replace(oldDownloadHeader, newDownloadLogic);
  console.log('Added residential bridge stream support to downloadTrackToFile');
}

fs.writeFileSync(serverPath, content, 'utf8');
console.log('server.js updated with Residential Bridge support successfully!');
