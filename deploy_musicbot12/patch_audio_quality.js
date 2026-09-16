import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(serverPath, 'utf8');

// 1. Upgrade default bitrate from 128k to 192k for crystal clear audio
content = content.replace("audioBitrate: '128k'", "audioBitrate: '192k'");
content = content.replace("let audioBitrate = settings.audioBitrate || '128k';", "let audioBitrate = settings.audioBitrate || '192k';");

// 2. Prioritize YouTube first, and only fall back to SoundCloud if YouTube fails
// And on SoundCloud fallback, filter out covers, nightcore, slowed, reverb
const oldDownloadSection = `  // ⚡ On Linux/Render cloud IP, YouTube is always blocked: fast-track directly via SoundCloud!
  if (isCloud && !isDirectSoundCloud && title) {
    const cleanQuery = title
      .replace(/^(?:video\\s*song|full\\s*video|official\\s*video|audio\\s*song)\\s*[-:]\\s*/i, '')
      .replace(/[#|/]/g, ' ')
      .trim();
    console.log(\`⚡ [Downloader] Cloud Fast-Track: Fetching "\${cleanQuery}" directly via SoundCloud...\`);
    try {
      return await executeYtdlpDownload(\`scsearch1:\${cleanQuery}\`, outputPath, thisStreamId, false);
    } catch (scErr) {
      console.warn(\`⚠️ [Downloader] Fast-track SoundCloud failed, trying YouTube fallback...\`);
    }
  }`;

const newDownloadSection = `  // 1. First priority: Try authentic original YouTube track directly
  const cookieArgs = getCookieArgs();
  if (cookieArgs.length > 0) {
    try {
      console.log(\`🔑 [Downloader] Found cookies, executing cookie-authenticated download...\`);
      return await executeYtdlpDownload(url, outputPath, thisStreamId, true);
    } catch (cookieErr) {
      if (thisStreamId !== currentStreamId) throw cookieErr;
      console.warn(\`⚠️ [Downloader] Cookie download failed (\${cookieErr.message.slice(0, 150)}). Trying direct fast mode...\`);
    }
  }

  // Try direct YouTube download with PO Token
  if (!isDirectSoundCloud) {
    try {
      console.log(\`🎬 [Downloader] Attempting original YouTube master for authentic artist vocals...\`);
      return await executeYtdlpDownload(url, outputPath, thisStreamId, false);
    } catch (ytErr) {
      if (thisStreamId !== currentStreamId) throw ytErr;
      console.warn(\`⚠️ [Downloader] Direct YouTube failed (\${ytErr.message.slice(0, 100)}). Falling back to high-fidelity SoundCloud...\`);
    }
  }

  // 2. Second priority / Fallback: Filtered SoundCloud search (excluding covers & nightcore)
  if (title) {
    const cleanQuery = title
      .replace(/^(?:video\\s*song|full\\s*video|official\\s*video|audio\\s*song)\\s*[-:]\\s*/i, '')
      .replace(/[#|/]/g, ' ')
      .replace(/\\b(official|music|video|song|full|lyrics|hd|4k)\\b/gi, '')
      .trim();
    const scQuery = \`scsearch1:\${cleanQuery} original -cover -nightcore -slowed -reverb -karaoke\`;
    console.log(\`⚡ [Downloader] SoundCloud Fallback: Fetching verified original for "\${cleanQuery}"...\`);
    try {
      return await executeYtdlpDownload(scQuery, outputPath, thisStreamId, false);
    } catch (scErr) {
      console.warn(\`⚠️ [Downloader] Filtered SoundCloud failed, retrying standard query...\`);
      return await executeYtdlpDownload(\`scsearch1:\${cleanQuery}\`, outputPath, thisStreamId, false);
    }
  }`;

if (content.includes('// ⚡ On Linux/Render cloud IP, YouTube is always blocked')) {
  // Replace the entire block up to the fallback
  const startIdx = content.indexOf('// ⚡ On Linux/Render cloud IP, YouTube is always blocked');
  const endIdx = content.indexOf('throw err;\n  }\n}\n\nasync function startStream');
  if (startIdx !== -1 && endIdx !== -1) {
    const fullOldBlock = content.slice(startIdx, endIdx + 'throw err;\n  }\n}'.length);
    content = content.replace(fullOldBlock, newDownloadSection + '\n}');
    console.log('Replaced downloadTrackToFile logic with YouTube First + Clean SoundCloud fallback');
  }
}

fs.writeFileSync(serverPath, content, 'utf8');
console.log('server.js patched successfully for audio quality!');
