import fetch from 'node-fetch';

async function restartBot() {
  const nodeCode = `
const fs = require('fs');
const pids = fs.readdirSync('/proc').filter(x => /^\\d+$/.test(x));
for (const p of pids) {
  try {
    const cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8');
    if (cmd.includes('python3')) {
      process.kill(Number(p), 'SIGKILL');
      console.log('Killed python process:', p);
    }
  } catch (e) {
    console.error('Error killing', p, e.message);
  }
}
  `.trim();

  const url = `https://musicbot12-ld6i.onrender.com/debug-exec?cmd=${encodeURIComponent(`node -e "${nodeCode.replace(/\n/g, ' ')}"`)}`;
  const res = await fetch(url);
  console.log(await res.text());
}

restartBot().catch(console.error);
