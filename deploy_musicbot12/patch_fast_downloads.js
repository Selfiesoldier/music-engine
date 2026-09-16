import fs from 'fs';

// 1. Patch server.js in musicbot-main
const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let serverContent = fs.readFileSync(serverPath, 'utf8');

// Replace player_client
serverContent = serverContent.replace(
  "'--extractor-args', 'youtube:player_client=android,ios'",
  "'--extractor-args', 'youtube:player_client=mweb,web,ios'"
);

// Add --concurrent-fragments 5 and formatArg update
if (!serverContent.includes("'--concurrent-fragments', '5'")) {
  serverContent = serverContent.replace(
    "'--retries', '2',",
    "'--retries', '3',\n    '--concurrent-fragments', '5',"
  );
  console.log('Added --concurrent-fragments 5 to server.js');
}

// Update formatArg for SoundCloud
serverContent = serverContent.replace(
  "const formatArg = isSoundCloud ? 'bestaudio/best' : 'ba[ext=m4a]/ba/b/best/18';",
  "const formatArg = isSoundCloud ? 'bestaudio[protocol^=http]/bestaudio/best' : 'ba[ext=m4a]/ba/b/best/18';"
);

// Update timeout from 25s to 65s
serverContent = serverContent.replace(
  "// Hard timeout: 25s max for yt-dlp download\n    const downloadTimeout = setTimeout(() => {\n      if (!isSettled && currentYtdlp) {\n        console.error(`⚠️ [Downloader] yt-dlp download timed out after 25s. Aborting download.`);\n        try { currentYtdlp.kill('SIGKILL'); } catch (e) {}\n      }\n    }, 25000);",
  "// Hard timeout: 65s max for yt-dlp download\n    const downloadTimeout = setTimeout(() => {\n      if (!isSettled && currentYtdlp) {\n        console.error(`⚠️ [Downloader] yt-dlp download timed out after 65s. Aborting download.`);\n        try { currentYtdlp.kill('SIGKILL'); } catch (e) {}\n      }\n    }, 65000);"
);

// Also check regex replace for timeout in case of whitespace difference
if (serverContent.includes('25000')) {
  serverContent = serverContent.replace(/timed out after 25s/g, 'timed out after 65s');
  serverContent = serverContent.replace(/25000\);/g, '65000);');
  console.log('Updated download timeout to 65s');
}

fs.writeFileSync(serverPath, serverContent, 'utf8');
console.log('server.js updated successfully');

// 2. Patch yt-dlp.conf in musicbot-main
const confPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/yt-dlp.conf';
let confContent = fs.readFileSync(confPath, 'utf8');
confContent = confContent.replace(
  '--extractor-args youtube:player_client=android,ios',
  '--extractor-args youtube:player_client=mweb,web,ios'
);
if (!confContent.includes('--concurrent-fragments 5')) {
  confContent += '\n--concurrent-fragments 5\n';
}
fs.writeFileSync(confPath, confContent, 'utf8');
console.log('yt-dlp.conf updated successfully');
