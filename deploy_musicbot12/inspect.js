import fs from 'fs';
const s = fs.readFileSync('C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js', 'utf8');
const lines = s.split('\n');
lines.forEach((l, i) => {
  if (l.includes('SilenceFeed') || l.includes('silenceFeed')) {
    console.log(`${i+1}: ${l}`);
  }
});
