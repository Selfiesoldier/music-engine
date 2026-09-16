import fetch from 'node-fetch';

async function check() {
  for (let i = 1; i <= 30; i++) {
    try {
      const res = await fetch('https://musicbot12-ld6i.onrender.com/debug-exec?cmd=' + encodeURIComponent('grep -n "def claim_daily" systems/economy/economy_manager.py'), { timeout: 5000 });
      const txt = await res.text();
      const stdout = txt.split('STDOUT:')[1] || '';
      if (stdout.includes('claim_daily')) {
        console.log('🎉 NEW DEPLOYMENT IS LIVE ON RENDER!');
        console.log(stdout.trim());
        process.exit(0);
      }
      console.log(`[Check ${i}/30] Building/deploying on Render... (${new Date().toLocaleTimeString()})`);
    } catch (e) {
      console.log(`[Check ${i}/30] Render container switching over: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 6000));
  }
  console.log('Timed out waiting for deploy.');
  process.exit(1);
}

check();
