import fetch from 'node-fetch';

async function runRemote(cmd) {
  console.log(`🚀 Running on Render: ${cmd}`);
  const url = `https://musicbot12-ld6i.onrender.com/debug-exec?cmd=${encodeURIComponent(cmd)}`;
  const res = await fetch(url);
  const text = await res.text();
  console.log(`--- OUTPUT ---\n${text}\n--------------`);
}

const cmd = process.argv.slice(2).join(' ') || 'cat /etc/yt-dlp.conf';
runRemote(cmd);
