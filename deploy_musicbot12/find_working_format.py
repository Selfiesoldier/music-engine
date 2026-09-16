import subprocess

clients = ['ios', 'mweb', 'web', 'tv', 'visionos', 'web_embedded', 'android_vr', 'tv_embedded']
for client in clients:
    cmd = ['python3', '/app/yt-dlp', '--cookies', '/app/cookies.txt', '--extractor-args', f'youtube:player_client={client}', '-F', 'https://www.youtube.com/watch?v=ruEQPQX90fI']
    res = subprocess.run(cmd, capture_output=True, text=True)
    formats = [l for l in res.stdout.split('\n') if ('audio only' in l or 'm4a' in l or 'webm' in l or 'mp4' in l) and not 'mhtml' in l]
    print(f"{client}: {len(formats)} audio/video formats")
    if formats:
        print("   sample:", formats[0].strip())
    elif res.stderr:
        err_line = [l for l in res.stderr.split('\n') if 'ERROR' in l or 'Sign in' in l or '403' in l]
        if err_line:
            print("   error:", err_line[0].strip())
