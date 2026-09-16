import subprocess
import sys

cmd = ['python3', '/app/yt-dlp', '--cookies', '/app/cookies.txt', '--extractor-args', 'youtube:player_client=android', '-F', 'https://www.youtube.com/watch?v=ruEQPQX90fI']
print(f"Running: {' '.join(cmd)}")
res = subprocess.run(cmd, capture_output=True, text=True)
print("=== RETURNCODE ===", res.returncode)
print("=== STDOUT ===")
print(res.stdout)
print("=== STDERR ===")
print(res.stderr)
