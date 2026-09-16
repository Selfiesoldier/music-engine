import fs from 'fs';

const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let server = fs.readFileSync(serverPath, 'utf8');

// 1. In /play: remove premature isPreparingTrack = true before playNext()
server = server.replace(
`    } else {
      isPreparingTrack = true;
      isTransitioning = true;
      playNext().catch(playErr => {
        console.error("Background playNext error:", playErr);
        isPreparingTrack = false;
        isTransitioning = false;
      });`,
`    } else {
      playNext().catch(playErr => {
        console.error("Background playNext error:", playErr);
      });`
);

// 2. In /insert: remove premature isPreparingTrack = true before playNext()
server = server.replace(
`    } else {
      isPreparingTrack = true;
      isTransitioning = true;
      playNext().catch(playErr => {
        console.error("Background playNext error in /insert:", playErr);
        isPreparingTrack = false;
        isTransitioning = false;
      });`,
`    } else {
      playNext().catch(playErr => {
        console.error("Background playNext error in /insert:", playErr);
      });`
);

// 3. In playNext: replace isPreparingTrack check with dedicated re-entrancy lock
const oldPlayNextHeader = `async function playNext() {
  if (isPreparingTrack) {
    console.log("⚠️ playNext called while already preparing track, skipping duplicate call");
    return;
  }
  const next = queue.shift();`;

const newPlayNextHeader = `let isPlayNextLocked = false;
async function playNext() {
  if (isPlayNextLocked) {
    console.log("⚠️ playNext already executing, skipping duplicate concurrent invocation");
    return;
  }
  isPlayNextLocked = true;
  let next;
  try {
    next = queue.shift();
  } finally {
    isPlayNextLocked = false;
  }`;

if (server.includes(oldPlayNextHeader)) {
  server = server.replace(oldPlayNextHeader, newPlayNextHeader);
  console.log('✅ playNext lock cleanly updated');
} else {
  console.warn('⚠️ Could not find exact oldPlayNextHeader');
}

fs.writeFileSync(serverPath, server, 'utf8');
console.log('🎉 /play and playNext lock fix applied!');
