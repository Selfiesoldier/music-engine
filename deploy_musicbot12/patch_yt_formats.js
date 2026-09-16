import fs from 'fs';

const mainDir = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main';
const serverPath = `${mainDir}/server.js`;
const confPath = `${mainDir}/yt-dlp.conf`;

// 1. Update yt-dlp.conf
let conf = fs.readFileSync(confPath, 'utf8');
conf = conf.replace(
  '--extractor-args youtube:player_client=mweb,web,ios',
  '--extractor-args youtube:player_client=visionos,android'
);
fs.writeFileSync(confPath, conf, 'utf8');
console.log('✅ yt-dlp.conf updated to visionos,android');

// 2. Update server.js
let server = fs.readFileSync(serverPath, 'utf8');

// Replace player_client in server.js
server = server.replace(
  "'--extractor-args', 'youtube:player_client=mweb,web,ios',",
  "'--extractor-args', 'youtube:player_client=visionos,android',"
);

// Update formatArg to universal audio selector
server = server.replace(
  "const formatArg = 'bestaudio/best';",
  "const formatArg = 'bestaudio/ba/b/best';"
);

// Update timeout from 65s to 25s so user never waits more than 25s if a source stalls
server = server.replace(
  "// Hard timeout: 65s max for yt-dlp download",
  "// Hard timeout: 25s max for yt-dlp download"
);
server = server.replace(
  "timed out after 65s",
  "timed out after 25s"
);
server = server.replace(
  "65000);",
  "25000);"
);

// Update downloadTrackToFile to try direct fast mode (visionos/android) first, then cookies, then SoundCloud
const oldDownloadFn = `async function downloadTrackToFile(url, outputPath, thisStreamId, title = '') {
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
  }`;

const newDownloadFn = `async function downloadTrackToFile(url, outputPath, thisStreamId, title = '') {
  const isDirectSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');

  // 1. Primary: Direct YouTube with visionos/android client & PO token (avoids web SABR/ad format blocks)
  if (!isDirectSoundCloud) {
    try {
      console.log(\`🎬 [Downloader] Fetching studio audio directly from YouTube (visionos/android)...\`);
      return await executeYtdlpDownload(url, outputPath, thisStreamId, false);
    } catch (ytErr) {
      if (thisStreamId !== currentStreamId) throw ytErr;
      console.warn(\`⚠️ [Downloader] Direct YouTube failed: \${ytErr.message.slice(0, 120)}\`);
      const cookieArgs = getCookieArgs();
      if (cookieArgs.length > 0) {
        try {
          console.log(\`🔄 [Downloader] Retrying YouTube with authenticated cookies...\`);
          return await executeYtdlpDownload(url, outputPath, thisStreamId, true);
        } catch (retryErr) {
          if (thisStreamId !== currentStreamId) throw retryErr;
          console.warn(\`⚠️ [Downloader] Cookie YouTube failed: \${retryErr.message.slice(0, 120)}\`);
        }
      }
    }
  }`;

if (server.includes(oldDownloadFn)) {
  server = server.replace(oldDownloadFn, newDownloadFn);
  console.log('✅ downloadTrackToFile updated to prioritize clean direct extraction');
} else {
  console.warn('⚠️ Could not find exact oldDownloadFn snippet in server.js');
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('✅ server.js patched successfully!');
