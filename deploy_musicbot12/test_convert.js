import fs from 'fs';
import { execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const m4a = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/assets/transition.m4a';
const pcm = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/assets/transition.pcm';
const ffmpegBin = ffmpegStatic && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg';

console.log('Testing ffmpeg conversion using:', ffmpegBin);
execSync(`"${ffmpegBin}" -y -i "${m4a}" -f s16le -ar 44100 -ac 2 "${pcm}"`, { stdio: 'inherit' });
console.log('Generated PCM size:', fs.statSync(pcm).size);
fs.unlinkSync(pcm);
console.log('Cleaned up test PCM.');
