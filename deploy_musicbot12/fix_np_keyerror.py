import os

path = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/systems/music/music_commands.py'
if os.path.exists(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    target = """                    song_info = BeautifulMessages.now_playing(
                        metadata['title'],
                        metadata['artist'],
                        metadata['duration'],
                        metadata['views'],"""

    replace = """                    song_info = BeautifulMessages.now_playing(
                        metadata.get('title', 'Unknown Track'),
                        metadata.get('artist', 'Unknown Artist'),
                        metadata.get('duration', 'Unknown'),
                        metadata.get('views', 'N/A'),"""

    if target in content:
        content = content.replace(target, replace)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print("Fixed KeyError in music_commands.py now_playing")
    else:
        print("Target not found in music_commands.py")
