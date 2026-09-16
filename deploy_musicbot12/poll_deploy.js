import fetch from 'node-fetch';

let attempts = 0;
const interval = setInterval(async () => {
  attempts++;
  try {
    const res = await fetch('https://musicbot12-ld6i.onrender.com/logs/raw?limit=40');
    const text = await res.text();
    if (text.includes('CookieEngine') || text.includes('authenticated cookies') || text.includes('cookies.b64') || text.includes('Restoring authenticated YouTube cookies')) {
      console.log('SUCCESS! Authenticated cookies active on Render:');
      console.log(text.split('\n').filter(l => l.toLowerCase().includes('cookie')).join('\n'));
      clearInterval(interval);
      process.exit(0);
    } else {
      console.log(`[Attempt ${attempts}] Waiting for Render build deployment...`);
    }
  } catch (err) {
    console.log(`[Attempt ${attempts}] Connection error: ${err.message}`);
  }
  if (attempts >= 25) {
    console.log('Timeout polling.');
    clearInterval(interval);
    process.exit(0);
  }
}, 5000);
