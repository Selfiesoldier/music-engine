import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(serverPath, 'utf8');

const target = "|| p2 === '/debug-exec')";
const replacement = "|| p2 === '/debug-exec' || p2.startsWith('/api/register-bridge') || p2.startsWith('/api/bridge'))";

if (content.includes(target)) {
  content = content.replace(target, replacement);
  fs.writeFileSync(serverPath, content, 'utf8');
  console.log('Successfully whitelisted bridge endpoints in auth middleware');
} else {
  console.log('Target string not found, checking if already whitelisted');
}
