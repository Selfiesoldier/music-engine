import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let server = fs.readFileSync(serverPath, 'utf8');

// 1. Clock-corrected silence feed with 250ms lead cushion to prevent buffer underrun disconnections
const oldSilenceFeed = `  startSilenceFeed() {
    if (this.silenceInterval) return;
    
    this.isSendingSilence = true;
    console.log('🔇 Starting silence feed to keep encoder alive...');
    
    const silenceChunk = this.generateSilencePCM(50);
    
    this.silenceInterval = setInterval(() => {
      if (this.isSendingSilence && this.pcmInputStream && !this.pcmInputStream.destroyed) {
        try {
          this.pcmInputStream.write(silenceChunk);
        } catch (err) {
        }
      }
    }, 50);
  }
  
  stopSilenceFeed() {
    this.isSendingSilence = false;
    console.log('🔊 Stopped silence feed - real audio playing');
  }
  
  resumeSilenceFeed() {
    this.isSendingSilence = true;
    console.log('🔇 Resuming silence feed...');
  }`;

const newSilenceFeed = `  startSilenceFeed() {
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
  }
  
  stopSilenceFeed() {
    this.isSendingSilence = false;
    console.log('🔊 Stopped silence feed - real audio playing');
  }
  
  resumeSilenceFeed() {
    this.isSendingSilence = true;
    this.silenceStartTime = Date.now();
    this.silenceSentMs = 0;
    console.log('🔇 Resuming silence feed...');
  }`;

if (server.includes(oldSilenceFeed)) {
  server = server.replace(oldSilenceFeed, newSilenceFeed);
  console.log('✅ Clock-corrected silence feed patched with 250ms lead cushion');
} else {
  console.warn('⚠️ Could not find exact oldSilenceFeed snippet');
}

// 2. Fix yt-dlp format selector: use universally valid bestaudio/best
server = server.replace(
  "const formatArg = isSoundCloud ? 'bestaudio[protocol^=http]/bestaudio/best' : 'ba[ext=m4a]/ba[ext=webm]/bestaudio/best/18';",
  "const formatArg = 'bestaudio/best';"
);
console.log('✅ yt-dlp format selector updated to bestaudio/best');

fs.writeFileSync(serverPath, server, 'utf8');
console.log('🎉 Patch applied successfully!');
