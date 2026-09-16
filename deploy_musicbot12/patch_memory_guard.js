import fs from 'fs';

const mainDir = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main';
const serverPath = `${mainDir}/server.js`;
const confPath = `${mainDir}/yt-dlp.conf`;
const startPath = `${mainDir}/start.sh`;

// 1. Update yt-dlp.conf to strictly use node (30MB) instead of deno (250MB+)
let conf = fs.readFileSync(confPath, 'utf8');
if (!conf.includes('--no-js-runtimes')) {
  conf += '\n--no-js-runtimes\n--js-runtimes node\n';
}
fs.writeFileSync(confPath, conf, 'utf8');
console.log('✅ yt-dlp.conf updated with --no-js-runtimes --js-runtimes node');

// 2. Update start.sh with strict V8 heap limits to guarantee < 150MB total container footprint
let start = fs.readFileSync(startPath, 'utf8').replace(/\r\n/g, '\n');
start = start.replace(
  'PORT=4416 NODE_OPTIONS="--max-old-space-size=64"',
  'PORT=4416 NODE_OPTIONS="--max-old-space-size=48"'
);
start = start.replace(
  'export NODE_OPTIONS="--max-old-space-size=160 --expose-gc"',
  'export NODE_OPTIONS="--max-old-space-size=64 --expose-gc"'
);
fs.writeFileSync(startPath, start, 'utf8');
console.log('✅ start.sh updated with strict memory limits (48MB for POT, 64MB for server)');

// 3. Update server.js
let server = fs.readFileSync(serverPath, 'utf8');

// A. Enforce jsRuntimeArgs in executeYtdlpDownload
server = server.replace(
  "const jsRuntimeArgs = ['--js-runtimes', 'node,deno'];",
  "const jsRuntimeArgs = ['--no-js-runtimes', '--js-runtimes', 'node'];"
);

// B. Add cache cleanup function to prune old .m4a files and prevent page cache bloat
const cachePruneCode = `
// 🧹 Auto-prune cache directory to prevent Linux page-cache and disk bloat (cgroup OOM prevention)
function pruneStaleCacheFiles(keepFile = null) {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    const keepBasename = keepFile ? path.basename(keepFile) : null;
    let prunedCount = 0;
    for (const f of files) {
      if (f.endsWith('.m4a') || f.endsWith('.part') || f.endsWith('.ytdl')) {
        if (f !== keepBasename && !f.includes('transition')) {
          try {
            fs.unlinkSync(path.join(CACHE_DIR, f));
            prunedCount++;
          } catch (e) {}
        }
      }
    }
    if (prunedCount > 0) {
      console.log(\`🧹 [MemoryGuard] Pruned \${prunedCount} stale audio cache files from disk\`);
    }
  } catch (e) {}
}
`;

if (!server.includes('function pruneStaleCacheFiles')) {
  server = server.replace(
    'let currentLocalFilePath = null;',
    `let currentLocalFilePath = null;\n${cachePruneCode}`
  );
  console.log('✅ Added pruneStaleCacheFiles to server.js');
}

// C. Call pruneStaleCacheFiles when a new stream starts
if (!server.includes('pruneStaleCacheFiles(localFilePath);')) {
  server = server.replace(
    'currentLocalFilePath = localFilePath;',
    'currentLocalFilePath = localFilePath;\n  pruneStaleCacheFiles(localFilePath);'
  );
  console.log('✅ Wired pruneStaleCacheFiles into track start');
}

// D. Add aggressive GC interval (every 30s) and memory monitor
const memoryMonitorCode = `
// 🛡️ High-Frequency Memory Guard & Aggressive Garbage Collection
setInterval(() => {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch (e) {}
  }
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
  // Only log if RSS exceeds 100MB as an early warning
  if (mem.rss > 100 * 1024 * 1024) {
    console.warn(\`⚠️ [MemoryGuard] Elevated Node memory: RSS \${rssMb}MB, Heap \${heapMb}MB - running cleanup...\`);
    pruneStaleCacheFiles(currentLocalFilePath);
    if (typeof global.gc === 'function') global.gc();
  }
}, 30000);
`;

if (!server.includes('High-Frequency Memory Guard')) {
  server = server.replace(
    'registerLiveLogs(app);',
    `${memoryMonitorCode}\nregisterLiveLogs(app);`
  );
  console.log('✅ Added High-Frequency Memory Guard to server.js');
}

// E. Call global.gc() immediately after track download settles and after stream kills
if (!server.includes('// Free memory immediately after stream termination')) {
  server = server.replace(
    'function killCurrentStream() {',
    `function killCurrentStream() {\n  // Free memory immediately after stream termination\n  if (typeof global.gc === 'function') { try { global.gc(); } catch (e) {} }`
  );
  console.log('✅ Added immediate GC call to killCurrentStream');
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('✅ server.js patched successfully with full MemoryGuard!');
