import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let s = fs.readFileSync(serverPath, 'utf8');
s = s.replace(
  "const isSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch:');",
  "const isSoundCloud = url.includes('soundcloud.com') || url.startsWith('scsearch');"
);
fs.writeFileSync(serverPath, s, 'utf8');
console.log('✅ isSoundCloud match updated');
