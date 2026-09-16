import fs from 'fs';
import path from 'path';

const filePath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add import
if (!content.includes('registerLiveLogs')) {
  content = content.replace(
    'import dotenv from "dotenv";',
    'import dotenv from "dotenv";\nimport { registerLiveLogs } from "./live_logs.js";'
  );
  console.log('Added import registerLiveLogs');
}

// 2. Update rate limiter and auth
if (content.includes("req.path.toLowerCase(); if (p === '/stream'")) {
  content = content.replace(
    "const p = req.path.toLowerCase(); if (p === '/stream' || p.startsWith('/stream')) {",
    "const p = req.path.toLowerCase(); if (p === '/stream' || p.startsWith('/stream') || p.startsWith('/logs') || p.startsWith('/api/logs')) {"
  );
  console.log('Updated rate limiter exemption');
}

if (content.includes("p2 === '/debug-exec'")) {
  content = content.replace(
    "p2 === '/api/login' || p2 === '/stream' || p2.startsWith('/stream') || p2 === '/health' || p2 === '/ping' || p2 === '/debug-ytdlp' || p2 === '/debug-exec'",
    "p2 === '/api/login' || p2 === '/stream' || p2.startsWith('/stream') || p2.startsWith('/logs') || p2.startsWith('/api/logs') || p2 === '/health' || p2 === '/ping' || p2 === '/debug-ytdlp' || p2 === '/debug-exec'"
  );
  console.log('Updated public auth exemption');
}

// 3. Register live logs before port
if (!content.includes('registerLiveLogs(app);')) {
  content = content.replace(
    'const rawPort = process.env.PORT || process.env.SERVER_PORT || 5000;',
    'registerLiveLogs(app);\n\nconst rawPort = process.env.PORT || process.env.SERVER_PORT || 5000;'
  );
  console.log('Registered registerLiveLogs(app)');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('server.js patch complete!');
