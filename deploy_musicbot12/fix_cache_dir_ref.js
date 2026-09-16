import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(serverPath, 'utf8');

content = content.replaceAll(
  "path.join(CACHE_DIR, 'bridge_url.txt')",
  "path.join(__dirname, 'cache', 'bridge_url.txt')"
);

fs.writeFileSync(serverPath, content, 'utf8');
console.log('Fixed CACHE_DIR reference in server.js');
