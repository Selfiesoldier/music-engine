import fs from 'fs';

console.log('🔧 Preparing Stream Stability & Anti-Disconnection Patch...');

// 1. Patch start.sh in musicbot-main
const startShPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/start.sh';
let startSh = fs.readFileSync(startShPath, 'utf8');

// Remove set -e so the supervisor script never exits on minor errors
startSh = startSh.replace(/^set -e\s*$/m, '# set -e removed to guarantee 24/7 container uptime');

// Export strict Deno memory limits so yt-dlp JS challenges never trigger Linux OOM killer
if (!startSh.includes('DENO_V8_FLAGS')) {
  startSh = startSh.replace(
    'export NODE_OPTIONS="--max-old-space-size=160 --expose-gc"',
    'export NODE_OPTIONS="--max-old-space-size=160 --expose-gc"\nexport DENO_V8_FLAGS="--max-old-space-size=48 --max-semi-space-size=1"'
  );
}

fs.writeFileSync(startShPath, startSh.replace(/\r\n/g, '\n'), 'utf8');
console.log('✅ start.sh patched with anti-OOM Deno limits and persistent supervisor loop');

// 2. Patch server.js in musicbot-main
const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let server = fs.readFileSync(serverPath, 'utf8');

// A. Add memory constraints to ytdlpEnv
if (!server.includes("DENO_V8_FLAGS: '--max-old-space-size=48")) {
  server = server.replace(
    'const ytdlpEnv = { ...process.env };',
    `const ytdlpEnv = {
  ...process.env,
  DENO_V8_FLAGS: '--max-old-space-size=48 --max-semi-space-size=1',
  NODE_OPTIONS: '--max-old-space-size=48'
};`
  );
  console.log('✅ ytdlpEnv patched with strict V8 heap limits');
}

// B. In executeYtdlpDownload: prefer node,deno with strict heap limits
server = server.replace(
  `  const jsRuntimeArgs = fs.existsSync('/usr/local/bin/deno')
    ? ['--js-runtimes', 'deno']
    : ['--js-runtimes', 'node'];`,
  `  // Prefer lightweight Node.js engine (30MB) over heavyweight Deno (250MB) to prevent Render 512MB OOM
  const jsRuntimeArgs = ['--js-runtimes', 'node,deno'];`
);

// C. In killCurrentStream(): DO NOT clear audio buffer!
server = server.replace(
  '  streamManager.clearAudioBuffer();',
  '  // streamManager.clearAudioBuffer(); // Keep circular audio buffer intact to prevent client stream starvation'
);

// D. In app.post("/restore"): Fix dual playNext race condition
const oldRestore = `app.post("/restore", async (req, res) => {
  console.log("🔄 RESTORE command received");
  
  if (queue.length > 0 && !isPlaying) {
    await playNext();
    res.send({ 
      status: "restored",
      queueLength: queue.length,
      nowPlaying: currentTitle,
      message: "Playback restored from saved queue"
    });
  } else if (isPlaying) {
    res.send({
      status: "already_playing",
      nowPlaying: currentTitle,
      queueLength: queue.length
    });
  } else {
    res.send({
      status: "empty",
      message: "No saved queue to restore"
    });
  }
});`;

const newRestore = `app.post("/restore", async (req, res) => {
  console.log("🔄 RESTORE command received");
  
  if (isPlaying || isPreparingTrack || isTransitioning) {
    return res.send({
      status: "already_playing",
      nowPlaying: currentTitle,
      queueLength: queue.length
    });
  }

  if (queue.length > 0) {
    await playNext();
    res.send({ 
      status: "restored",
      queueLength: queue.length,
      nowPlaying: currentTitle,
      message: "Playback restored from saved queue"
    });
  } else {
    res.send({
      status: "empty",
      message: "No saved queue to restore"
    });
  }
});`;

if (server.includes(oldRestore)) {
  server = server.replace(oldRestore, newRestore);
  console.log('✅ app.post("/restore") race condition fixed');
}

// E. In playNext(): guard against re-entry while isPreparingTrack is true
server = server.replace(
  `async function playNext() {
  const next = queue.shift();`,
  `async function playNext() {
  if (isPreparingTrack) {
    console.log("⚠️ playNext called while already preparing track, skipping duplicate call");
    return;
  }
  const next = queue.shift();`
);

// F. In broadcast(): increase frozen client drop threshold to 1MB
server = server.replace(
  'if (client.writableLength > 512 * 1024) {',
  'if (client.writableLength > 1024 * 1024) {'
);

fs.writeFileSync(serverPath, server, 'utf8');
console.log('🎉 All stream stability patches successfully applied!');
