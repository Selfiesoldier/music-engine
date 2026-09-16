import fetch from 'node-fetch';

async function testClientsWithCookies() {
  const clients = ['android', 'ios', 'mweb', 'web', 'tv', 'visionos', 'tv_embedded', 'android_vr', 'web_creator', 'web_embedded'];
  for (const c of clients) {
    const cmd = `python3 /app/yt-dlp --cookies /app/cookies.txt --extractor-args "youtube:player_client=${c}" -F "https://www.youtube.com/watch?v=ruEQPQX90fI"`;
    try {
      const url = `https://musicbot12-ld6i.onrender.com/debug-exec?cmd=${encodeURIComponent(cmd)}`;
      const res = await fetch(url);
      const text = await res.text();
      const hasAudio = text.includes('audio only') || text.includes('140') || text.includes('251') || text.includes('18');
      const err = text.split('\n').find(l => l.includes('ERROR') || l.includes('Sign in') || l.includes('403') || l.includes('Forbidden') || l.includes('ERR:'));
      console.log(`[cookies + ${c}]: ${hasAudio ? '🎉 SUCCESS (Audio Formats Found!)' : '❌ FAILED'} | ${err || 'No audio'}`);
      if (hasAudio) {
        console.log(text.split('\n').filter(l => l.includes('audio only') || l.includes('251') || l.includes('140')).slice(0, 3).join('\n'));
      }
    } catch (e) {
      console.log(`[cookies + ${c}]: Fetch error: ${e.message}`);
    }
  }
}

testClientsWithCookies();
