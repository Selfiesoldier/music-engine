import fetch from 'node-fetch';

let attempts = 0;
const interval = setInterval(async () => {
  attempts++;
  try {
    const res = await fetch('https://musicbot12-ld6i.onrender.com/api/bridge-status', { timeout: 3500 });
    if (res.status === 200) {
      const data = await res.json();
      console.log('🎉 RENDER DEPLOYED SUCCESSFULLY!');
      console.log(data);
      clearInterval(interval);
      process.exit(0);
    } else {
      console.log(`[Attempt ${attempts}] HTTP ${res.status} - waiting...`);
    }
  } catch (err) {
    console.log(`[Attempt ${attempts}] Waiting (error: ${err.message})`);
  }
  if (attempts >= 40) {
    console.log('Timed out waiting.');
    clearInterval(interval);
    process.exit(1);
  }
}, 4000);
