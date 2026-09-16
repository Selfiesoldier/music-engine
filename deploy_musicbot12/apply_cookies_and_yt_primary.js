import fs from 'fs';

// 1. Update start.sh in musicbot-main
const startShPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/start.sh';
let startShContent = fs.readFileSync(startShPath, 'utf8');

if (!startShContent.includes('cookies.b64')) {
  startShContent = startShContent.replace(
    'set -e\n',
    'set -e\n\nif [ -f "cookies.b64" ]; then\n  echo "🍪 Restoring authenticated YouTube cookies..."\n  base64 -d cookies.b64 > cookies.txt\nfi\n'
  );
  fs.writeFileSync(startShPath, startShContent, 'utf8');
  console.log('start.sh updated with cookies.b64 auto-restore');
}

// 2. Update server.js in musicbot-main
const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let serverContent = fs.readFileSync(serverPath, 'utf8');

// In getCookieArgs: add cookies.b64 decoder
if (!serverContent.includes('cookies.b64')) {
  serverContent = serverContent.replace(
    'function getCookieArgs() {',
    `function getCookieArgs() {
  if (!fs.existsSync(path.join(__dirname, 'cookies.txt')) && fs.existsSync(path.join(__dirname, 'cookies.b64'))) {
    try {
      const b64 = fs.readFileSync(path.join(__dirname, 'cookies.b64'), 'utf8');
      fs.writeFileSync(path.join(__dirname, 'cookies.txt'), Buffer.from(b64, 'base64').toString('utf8'), 'utf8');
      console.log('🍪 [CookieEngine] Restored cookies.txt from cookies.b64');
    } catch(e) {}
  }`
  );
  console.log('server.js updated with cookies.b64 decoder in getCookieArgs');
}

// Ensure executeYtdlpDownload defaults to withCookies = true
serverContent = serverContent.replace(
  'function executeYtdlpDownload(url, outputPath, thisStreamId, withCookies = false) {',
  'function executeYtdlpDownload(url, outputPath, thisStreamId, withCookies = true) {'
);

// Format arg for YouTube to prioritize high-definition audio
serverContent = serverContent.replace(
  "const formatArg = isSoundCloud ? 'bestaudio[protocol^=http]/bestaudio/best' : 'ba[ext=m4a]/ba/b/best/18';",
  "const formatArg = isSoundCloud ? 'bestaudio[protocol^=http]/bestaudio/best' : 'ba[ext=m4a]/ba[ext=webm]/bestaudio/best/18';"
);

// Make YouTube the primary download source
const oldDownloadFn = serverContent.substring(
  serverContent.indexOf('async function downloadTrackToFile(url, outputPath, thisStreamId, title = \'\') {'),
  serverContent.indexOf('async function startStream(url, title, metadata) {')
);

const newDownloadFn = `async function downloadTrackToFile(url, outputPath, thisStreamId, title = '') {
  const isDirectSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');

  // 1. YouTube is the absolute primary source with authenticated cookies
  if (!isDirectSoundCloud) {
    try {
      console.log(\`🎬 [Downloader] Fetching studio audio directly from YouTube with authenticated cookies...\`);
      return await executeYtdlpDownload(url, outputPath, thisStreamId, true);
    } catch (ytErr) {
      if (thisStreamId !== currentStreamId) throw ytErr;
      console.warn(\`⚠️ [Downloader] Authenticated YouTube download failed: \${ytErr.message.slice(0, 120)}\`);
      try {
        console.log(\`🔄 [Downloader] Retrying YouTube in direct fast mode with Botguard PO Token...\`);
        return await executeYtdlpDownload(url, outputPath, thisStreamId, false);
      } catch (retryErr) {
        if (thisStreamId !== currentStreamId) throw retryErr;
        console.warn(\`⚠️ [Downloader] Direct YouTube failed: \${retryErr.message.slice(0, 120)}\`);
      }
    }
  }

  // 2. Only if YouTube is completely unreachable and title exists, use clean verified SoundCloud fallback
  if (title) {
    const cleanQuery = title
      .replace(/^(?:video\\s*song|full\\s*video|official\\s*video|audio\\s*song)\\s*[-:]\\s*/i, '')
      .replace(/[#|/]/g, ' ')
      .replace(/\\b(official|music|video|song|full|lyrics|hd|4k)\\b/gi, '')
      .trim();
    const scQuery = \`scsearch1:\${cleanQuery} original -cover -nightcore -slowed -reverb -karaoke\`;
    console.log(\`⚡ [Downloader] SoundCloud Fallback: Fetching original audio for "\${cleanQuery}"...\`);
    try {
      return await executeYtdlpDownload(scQuery, outputPath, thisStreamId, false);
    } catch (scErr) {
      console.warn(\`⚠️ [Downloader] Filtered SoundCloud failed, retrying standard query...\`);
      return await executeYtdlpDownload(\`scsearch1:\${cleanQuery}\`, outputPath, thisStreamId, false);
    }
  }
}

`;

if (oldDownloadFn) {
  serverContent = serverContent.replace(oldDownloadFn, newDownloadFn);
  console.log('server.js updated: YouTube is now the absolute primary source with authenticated cookies');
}

fs.writeFileSync(serverPath, serverContent, 'utf8');
console.log('All changes applied successfully!');
