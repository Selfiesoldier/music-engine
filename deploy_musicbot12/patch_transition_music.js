import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let server = fs.readFileSync(serverPath, 'utf8');

// 1. Add transition track state and loader to PersistentStreamManager constructor
if (!server.includes('this.transitionPcm = null;')) {
  server = server.replace(
    'this.transitionSilenceMs = 150;',
    `this.transitionSilenceMs = 150;\n    this.transitionPcm = null;\n    this.transitionOffset = 0;\n    this.loadTransitionTrack();`
  );
  console.log('✅ Added transition track state to PersistentStreamManager constructor');
}

// 2. Add loadTransitionTrack method to PersistentStreamManager
if (!server.includes('loadTransitionTrack() {')) {
  const loadMethod = `
  loadTransitionTrack() {
    try {
      const pcmPath = path.join(__dirname, 'assets', 'transition.pcm');
      const m4aPath = path.join(__dirname, 'assets', 'transition.m4a');

      if (!fs.existsSync(pcmPath) && fs.existsSync(m4aPath)) {
        console.log('🔄 [TransitionEngine] Generating transition.pcm from assets/transition.m4a...');
        try {
          execSync(\`"\${getFFmpegPath()}" -y -i "\${m4aPath}" -f s16le -ar 44100 -ac 2 "\${pcmPath}"\`, { stdio: 'ignore' });
        } catch (convErr) {
          console.warn('⚠️ [TransitionEngine] ffmpeg audio conversion warning:', convErr.message);
        }
      }

      if (fs.existsSync(pcmPath)) {
        const raw = fs.readFileSync(pcmPath);
        const chunkSize = 8820; // 50ms aligned chunk
        const alignedLen = raw.length - (raw.length % chunkSize);
        this.transitionPcm = Buffer.allocUnsafe(alignedLen);
        raw.copy(this.transitionPcm, 0, 0, alignedLen);
        this.transitionOffset = 0;
        console.log(\`☕ [TransitionEngine] Loaded seamless transition music loop (\${(this.transitionPcm.length / 1024 / 1024).toFixed(2)} MB, ~\${(this.transitionPcm.length / 176400).toFixed(1)}s)\`);
      } else {
        console.warn('⚠️ [TransitionEngine] No transition track found at assets/transition.m4a');
      }
    } catch (e) {
      console.error('⚠️ [TransitionEngine] Error loading transition track:', e.message);
      this.transitionPcm = null;
    }
  }
`;

  server = server.replace(
    '  generateSilencePCM(durationMs = 100) {',
    `${loadMethod}\n  generateSilencePCM(durationMs = 100) {`
  );
  console.log('✅ Added loadTransitionTrack method');
}

// 3. Update startSilenceFeed and resumeSilenceFeed to stream transition music
const oldStartSilence = `  startSilenceFeed() {
    if (this.silenceInterval) return;
    
    this.isSendingSilence = true;
    this.silenceStartTime = Date.now();
    this.silenceSentMs = 0;
    console.log('🔇 Starting silence feed to keep encoder alive...');
    
    const CHUNK_MS = 50;
    const silenceChunk = this.generateSilencePCM(CHUNK_MS);
    
    this.silenceInterval = setInterval(() => {
      if (!this.isSendingSilence || !this.pcmInputStream || this.pcmInputStream.destroyed) {
        return;
      }
      
      const elapsedMs = Date.now() - this.silenceStartTime;
      // Clock-corrected pacing: maintain a 250ms lead cushion ahead of wall-clock time
      // Prevents client buffer starvation and eliminates disconnection between tracks
      while (this.silenceSentMs - elapsedMs < 250) {
        try {
          this.pcmInputStream.write(silenceChunk);
          this.silenceSentMs += CHUNK_MS;
        } catch (err) {
          break;
        }
      }
    }, 40);
  }`;

const newStartSilence = `  startSilenceFeed() {
    if (this.silenceInterval) return;
    
    this.isSendingSilence = true;
    this.silenceStartTime = Date.now();
    this.silenceSentMs = 0;
    console.log(this.transitionPcm ? '☕ Starting transition music loop to keep stream alive...' : '🔇 Starting silence feed to keep encoder alive...');
    
    const CHUNK_MS = 50;
    const CHUNK_SIZE = 8820;
    const silenceZeroChunk = this.generateSilencePCM(CHUNK_MS);
    
    this.silenceInterval = setInterval(() => {
      if (!this.isSendingSilence || !this.pcmInputStream || this.pcmInputStream.destroyed) {
        return;
      }
      
      const elapsedMs = Date.now() - this.silenceStartTime;
      // Clock-corrected pacing: maintain a 250ms lead cushion ahead of wall-clock time
      // Prevents client buffer starvation and eliminates disconnection between tracks
      while (this.silenceSentMs - elapsedMs < 250) {
        let chunk = silenceZeroChunk;
        if (this.transitionPcm && this.transitionPcm.length >= CHUNK_SIZE) {
          chunk = this.transitionPcm.subarray(this.transitionOffset, this.transitionOffset + CHUNK_SIZE);
          this.transitionOffset += CHUNK_SIZE;
          if (this.transitionOffset >= this.transitionPcm.length) {
            this.transitionOffset = 0; // Seamless loop wrap-around
          }
        }
        try {
          this.pcmInputStream.write(chunk);
          this.silenceSentMs += CHUNK_MS;
        } catch (err) {
          break;
        }
      }
    }, 40);
  }`;

if (server.includes(oldStartSilence)) {
  server = server.replace(oldStartSilence, newStartSilence);
  console.log('✅ Updated startSilenceFeed to play transition music loop');
} else {
  console.warn('⚠️ Could not find exact oldStartSilence snippet');
}

// 4. Update stopSilenceFeed and resumeSilenceFeed logs
server = server.replace(
  "console.log('🔊 Stopped silence feed - real audio playing');",
  "console.log(this.transitionPcm ? '🔊 Stopped transition music - real audio playing' : '🔊 Stopped silence feed - real audio playing');"
);

server = server.replace(
  "console.log('🔇 Resuming silence feed...');",
  "console.log(this.transitionPcm ? '☕ Resuming transition music loop...' : '🔇 Resuming silence feed...');"
);

fs.writeFileSync(serverPath, server, 'utf8');
console.log('🎉 Transition music engine successfully patched into server.js!');
