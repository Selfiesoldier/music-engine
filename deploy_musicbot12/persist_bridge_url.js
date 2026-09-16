import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(serverPath, 'utf8');

const target = `let residentialBridgeUrl = process.env.RESIDENTIAL_BRIDGE_URL || null;

app.post("/api/register-bridge", (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url parameter" });
  residentialBridgeUrl = url.trim().replace(/\\/+$/, '');
  console.log(\`🏠 [Bridge] Registered active residential audio bridge: \${residentialBridgeUrl}\`);
  res.json({ success: true, bridgeUrl: residentialBridgeUrl });
});`;

const replacement = `let residentialBridgeUrl = process.env.RESIDENTIAL_BRIDGE_URL || 'https://contractors-peter-specialist-killing.trycloudflare.com';
if (fs.existsSync(path.join(CACHE_DIR, 'bridge_url.txt'))) {
  try {
    const saved = fs.readFileSync(path.join(CACHE_DIR, 'bridge_url.txt'), 'utf8').trim();
    if (saved) residentialBridgeUrl = saved;
  } catch (_) {}
}

app.post("/api/register-bridge", (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url parameter" });
  residentialBridgeUrl = url.trim().replace(/\\/+$/, '');
  try { fs.writeFileSync(path.join(CACHE_DIR, 'bridge_url.txt'), residentialBridgeUrl, 'utf8'); } catch (_) {}
  console.log(\`🏠 [Bridge] Registered active residential audio bridge: \${residentialBridgeUrl}\`);
  res.json({ success: true, bridgeUrl: residentialBridgeUrl });
});`;

if (content.includes('let residentialBridgeUrl = process.env.RESIDENTIAL_BRIDGE_URL || null;')) {
  content = content.replace(
    'let residentialBridgeUrl = process.env.RESIDENTIAL_BRIDGE_URL || null;',
    `let residentialBridgeUrl = process.env.RESIDENTIAL_BRIDGE_URL || 'https://contractors-peter-specialist-killing.trycloudflare.com';
if (fs.existsSync(path.join(CACHE_DIR, 'bridge_url.txt'))) {
  try {
    const saved = fs.readFileSync(path.join(CACHE_DIR, 'bridge_url.txt'), 'utf8').trim();
    if (saved) residentialBridgeUrl = saved;
  } catch (_) {}
}`
  );
  content = content.replace(
    "console.log(`🏠 [Bridge] Registered active residential audio bridge:",
    "try { fs.writeFileSync(path.join(CACHE_DIR, 'bridge_url.txt'), residentialBridgeUrl, 'utf8'); } catch (_) {}\n  console.log(`🏠 [Bridge] Registered active residential audio bridge:"
  );
  fs.writeFileSync(serverPath, content, 'utf8');
  console.log('Successfully updated server.js to persist and default bridge URL');
} else {
  console.log('Target string not found');
}
