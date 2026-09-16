const { execSync } = require('child_process');
const clients = ['android', 'ios', 'mweb', 'web', 'tv', 'visionos', 'web_creator', 'android_vr', 'tv_embedded'];
for (const c of clients) {
  try {
    const out = execSync(`.\\yt-dlp.exe -F --extractor-args "youtube:player_client=${c}" "https://www.youtube.com/watch?v=T94PHkuydcw"`, { stdio: 'pipe' }).toString();
    const formats = out.split('\n').filter(l => l.includes('audio only') || l.includes('m4a') || l.includes('webm'));
    console.log(`Client [${c}]: ${formats.length} audio formats found`);
    if (formats.length > 0) {
      console.log('   -> ' + formats[0].trim());
    }
  } catch (e) {
    console.log(`Client [${c}]: Error - ${e.message.split('\n')[0]}`);
  }
}
