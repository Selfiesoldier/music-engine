import fetch from 'node-fetch';

async function check() {
  console.log('Polling Render for commit 0a5181b (2.5s lead cushion & watchdog fix)...');
  for (let i = 1; i <= 40; i++) {
    try {
      const res = await fetch('https://musicbot12-ld6i.onrender.com/debug-exec?cmd=' + encodeURIComponent('grep -n "2.5s lead cushion" server.js'), { timeout: 6000 });
      const txt = await res.text();
      const stdout = txt.split('STDOUT:')[1] || '';
      if (stdout.includes('2.5s lead cushion')) {
        console.log('🎉 NEW DEPLOYMENT IS LIVE ON RENDER WITH ANTI-STUTTER & WATCHDOG FIX!');
        console.log(stdout.trim());
        process.exit(0);
      }
      console.log(`[Check ${i}/40] Building/deploying on Render... (${new Date().toLocaleTimeString()})`);
    } catch (e) {
      console.log(`[Check ${i}/40] Render container switching over: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 6000));
  }
  console.log('Timed out waiting for deploy.');
  process.exit(1);
}

check();
