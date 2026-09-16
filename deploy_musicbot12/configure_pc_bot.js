import fs from 'fs';
import path from 'path';

const PC_DIR = 'C:/Users/sanif/OneDrive/Desktop/music bot for pc';

// 1. Update start_all.py in PC folder
const startAllPy = `import subprocess
import threading
import time
import os
import re
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

script_dir = os.path.dirname(os.path.abspath(__file__))

# Use Python 3.12 from local venv
python_exe = os.path.join(script_dir, "venv312", "Scripts", "python.exe")
if not os.path.exists(python_exe):
    python_exe = sys.executable
    print(f"[LAUNCHER] Warning: local venv312 not found, using system Python: {python_exe}")
else:
    print(f"[LAUNCHER] Using Python 3.12 from local venv: {python_exe}")

# Use local cloudflared.exe
cloudflared_exe = os.path.join(script_dir, "cloudflared.exe")
if not os.path.exists(cloudflared_exe):
    cloudflared_exe = "cloudflared"
    print(f"[LAUNCHER] Using system cloudflared")
else:
    print(f"[LAUNCHER] Using local cloudflared.exe: {cloudflared_exe}")

# Commands
CMD_SERVER = ["node", "server.js"]
CMD_TUNNEL = [cloudflared_exe, "tunnel", "--url", "http://127.0.0.1:5000"]
CMD_BOT = [python_exe, "-u", "main.py"]

# State
public_url = None
processes = {}

def tail_stream(prefix, stream, is_tunnel=False):
    global public_url
    try:
        for line in iter(stream.readline, b''):
            line_str = line.decode('utf-8', errors='replace').strip()
            if not line_str: continue
            
            # Print with prefix
            sys.stdout.write(f"{prefix} {line_str}\\n")
            sys.stdout.flush()

            # Auto-extract cloudflare URL (ignore api.trycloudflare.com)
            if is_tunnel and public_url is None:
                match = re.search(r'(https://[a-zA-Z0-9-]+\\.trycloudflare\\.com)', line_str)
                if match and "api.trycloudflare.com" not in match.group(1):
                    public_url = match.group(1)
                    print(f"\\n[LAUNCHER] 🌐 Extracted Cloudflare URL: {public_url}")
                    print("[LAUNCHER] 🚀 Starting Python Bot...\\n")
                    start_process("BOT", CMD_BOT, env_add={"PUBLIC_URL": public_url})
    except Exception as e:
        print(f"[LAUNCHER] Error reading stream for {prefix}: {e}")

def start_process(name, cmd, env_add=None):
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if env_add:
        env.update(env_add)

    prefix = f"[{name}]"
    print(f"[LAUNCHER] Starting {name} watchdog...")
    
    def watchdog():
        while True:
            print(f"[LAUNCHER] 🟢 Spawning {name}...")
            p = subprocess.Popen(
                cmd, 
                cwd=script_dir,
                env=env,
                stdout=subprocess.PIPE, 
                stderr=subprocess.STDOUT,
                shell=False
            )
            processes[name] = p
            
            # Read logs blocking
            tail_stream(prefix, p.stdout, is_tunnel=(name == "TUNNEL"))
            
            p.wait()
            print(f"[LAUNCHER] 🔴 {name} crashed or stopped! Restarting in 3 seconds...")
            time.sleep(3)

    t = threading.Thread(target=watchdog, daemon=True)
    t.start()

if __name__ == "__main__":
    print("==================================================")
    print("🎵 Highrise Music Bot for PC - Launcher 🎵")
    print("==================================================")
    
    start_process("SERVER", CMD_SERVER)
    start_process("TUNNEL", CMD_TUNNEL)
    
    # Bot starts automatically once TUNNEL finds the URL.
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\\n[LAUNCHER] Shutting down all processes...")
        for name, p in processes.items():
            try:
                p.terminate()
            except:
                pass
        sys.exit(0)
`;

fs.writeFileSync(path.join(PC_DIR, 'start_all.py'), startAllPy, 'utf8');
console.log('✅ Updated start_all.py with local cloudflared.exe and local venv!');

// 2. Update server.js to download YouTube DIRECTLY via local yt-dlp.exe
const serverJsPath = path.join(PC_DIR, 'server.js');
let serverJs = fs.readFileSync(serverJsPath, 'utf8');

// Update extractor args in executeYtdlpDownload to support YouTube directly on PC
serverJs = serverJs.replace(
  `  const potArgs = isSoundCloud ? [] : [
    '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
    '--extractor-args', 'youtube:player_client=visionos,android',
  ];
  const formatArg = 'bestaudio/ba/b/best';`,
  `  const potArgs = isSoundCloud ? [] : [
    '--extractor-args', 'youtube:player_client=android,web,tv,visionos',
  ];
  const formatArg = 'ba[ext=m4a]/ba[ext=webm]/ba/b/best';`
);

// Update downloadTrackToFile to download YouTube directly using yt-dlp on PC
const oldDownloadBlock = `  const bridgeOnline = !isDirectSoundCloud && (await checkBridgeHealth());

  // 2. If Home Residential Bridge is connected and healthy, stream YouTube directly
  if (bridgeOnline) {
    try {
      console.log(\`🏠 [Downloader] Streaming YouTube audio via Residential Bridge (\${residentialBridgeUrl})...\`);
      const bridgeStreamUrl = \`\${residentialBridgeUrl}/stream?url=\${encodeURIComponent(url)}\`;
      const resp = await fetch(bridgeStreamUrl, { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) {
        throw new Error(\`Bridge returned HTTP status \${resp.status}\`);
      }
      const fileStream = fs.createWriteStream(outputPath);
      await new Promise((resolve, reject) => {
        resp.body.pipe(fileStream);
        resp.body.on('error', reject);
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
      if (thisStreamId !== currentStreamId) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
        throw new Error("Download aborted: Stream ID changed");
      }
      const stats = fs.statSync(outputPath);
      if (stats.size > 50000) {
        console.log(\`✅ [Downloader] YouTube track downloaded via Residential Bridge (\${(stats.size / 1024 / 1024).toFixed(2)} MB)\`);
        try {
          fs.copyFileSync(outputPath, cachedPath);
          pruneLRUSongCache();
        } catch (_) {}
        return outputPath;
      }
      console.warn(\`⚠️ [Downloader] Bridge file too small (\${stats.size} bytes), proceeding to SoundCloud fallback...\`);
    } catch (bridgeErr) {
      if (thisStreamId !== currentStreamId) throw bridgeErr;
      console.warn(\`⚠️ [Downloader] Residential Bridge failed (\${bridgeErr.message}), fast-tracking to SoundCloud...\`);
    }
  } else if (!isDirectSoundCloud) {
    console.log(\`⚡ [Downloader] Residential bridge offline — fast-tracking directly to SoundCloud (skipping 30s cloud timeout)...\`);
  }`;

const newDownloadBlock = `  // 2. Direct YouTube download via PC yt-dlp (Native Residential Home IP!)
  if (!isDirectSoundCloud) {
    try {
      console.log(\`🚀 [Downloader] Downloading YouTube audio directly via PC yt-dlp ("\${title || url}")...\`);
      await executeYtdlpDownload(url, outputPath, thisStreamId, true);
      const stats = fs.statSync(outputPath);
      if (stats.size > 50000) {
        console.log(\`✅ [Downloader] YouTube track downloaded directly via PC yt-dlp (\${(stats.size / 1024 / 1024).toFixed(2)} MB)\`);
        try {
          fs.copyFileSync(outputPath, cachedPath);
          pruneLRUSongCache();
        } catch (_) {}
        return outputPath;
      }
    } catch (ytErr) {
      if (thisStreamId !== currentStreamId) throw ytErr;
      console.warn(\`⚠️ [Downloader] Direct YouTube download failed (\${ytErr.message}), falling back to SoundCloud...\`);
    }
  }`;

if (!serverJs.includes(oldDownloadBlock)) {
  console.error('Warning: oldDownloadBlock not found exactly in PC server.js!');
} else {
  serverJs = serverJs.replace(oldDownloadBlock, newDownloadBlock);
  console.log('✅ Updated server.js to use direct PC yt-dlp for all YouTube audio!');
}

fs.writeFileSync(serverJsPath, serverJs, 'utf8');
console.log('✅ Configuration complete for "music bot for pc"!');
