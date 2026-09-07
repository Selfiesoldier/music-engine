import http from 'http';

const PORT = process.env.PORT || 30060;
const STREAM_URL = `http://localhost:${PORT}/stream`;
const HEALTH_URL = `http://localhost:${PORT}/health`;

console.log(`📡 [Test] Testing Music Engine stream at ${STREAM_URL}...`);

// 1. First verify server is alive
const healthReq = http.get(HEALTH_URL, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log(`✅ [Test] Server Health OK (HTTP ${res.statusCode}):`, data.trim());
    startStreamTest();
  });
});

healthReq.on('error', (err) => {
  console.error(`❌ [Test] Server not reachable at ${HEALTH_URL}:`, err.message);
  process.exit(1);
});

function startStreamTest() {
  let totalBytes = 0;
  let chunkCount = 0;
  const startTime = Date.now();

  const req = http.get(STREAM_URL, (res) => {
    console.log(`✅ [Test] Stream Connected! HTTP ${res.statusCode}`);
    console.log(`📻 [Test] ICY Name: ${res.headers['icy-name']} | Bitrate: ${res.headers['icy-br']}k`);

    res.on('data', (chunk) => {
      totalBytes += chunk.length;
      chunkCount++;
    });

    setTimeout(() => {
      const elapsedSec = (Date.now() - startTime) / 1000;
      const kbps = ((totalBytes * 8) / 1024 / elapsedSec).toFixed(1);
      console.log(`\n========================================`);
      console.log(`📊 Stream Verification Results (5s sample):`);
      console.log(`   • Total Bytes Received: ${totalBytes} bytes`);
      console.log(`   • Chunks Received: ${chunkCount}`);
      console.log(`   • Bitrate Measured: ${kbps} kbps (Target: ~192k)`);
      console.log(`   • Stream Status: ${totalBytes > 80000 ? '🟢 PERFECT (Active 192k Audio)' : '🔴 FAILED'}`);
      console.log(`========================================\n`);
      req.destroy();
      process.exit(totalBytes > 80000 ? 0 : 1);
    }, 5000);
  });

  req.on('error', (err) => {
    console.error(`❌ [Test] Stream error:`, err.message);
    process.exit(1);
  });
}
