import fetch from 'node-fetch';

async function testOne() {
  const cmd = `python3 /app/yt-dlp --cookies /app/cookies.txt --extractor-args "youtube:player_client=ios" -F "https://www.youtube.com/watch?v=ruEQPQX90fI"`;
  const url = `https://musicbot12-ld6i.onrender.com/debug-exec?cmd=${encodeURIComponent(cmd)}`;
  const res = await fetch(url);
  const text = await res.text();
  console.log(text);
}

testOne();
