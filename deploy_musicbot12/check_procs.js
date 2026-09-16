import fetch from 'node-fetch';

async function checkProcesses() {
  const nodeCode = `
const fs = require('fs');
const pids = fs.readdirSync('/proc').filter(x => /^\\d+$/.test(x));
const procs = [];
for (const pid of pids) {
  try {
    const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\\0/g, ' ');
    if (cmd) procs.push('[' + pid + '] ' + cmd);
  } catch (_) {}
}
console.log(procs.join('\\n'));
  `.trim();

  const url = `https://musicbot12-ld6i.onrender.com/debug-exec?cmd=${encodeURIComponent(`node -e "${nodeCode.replace(/\n/g, ' ')}"`)}`;
  const res = await fetch(url);
  console.log(await res.text());
}

checkProcesses().catch(console.error);
