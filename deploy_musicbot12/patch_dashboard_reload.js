import fs from 'fs';

// 1. Fix app.js
const appJsPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/public/js/app.js';
let appJsContent = fs.readFileSync(appJsPath, 'utf8');

if (appJsContent.includes('window.location.reload(); // Session expired')) {
  appJsContent = appJsContent.replace(
    `      if (res.status === 401 && !isRestarting) {
        window.location.reload(); // Session expired
      }`,
    `      if (res.status === 401 && !isRestarting) {
        UI.loginOverlay.classList.add('active');
        UI.dashboard.classList.add('hidden');
        if (eventSource) {
          try { eventSource.close(); } catch (e) {}
          eventSource = null;
        }
      }`
  );
  fs.writeFileSync(appJsPath, appJsContent, 'utf8');
  console.log('Fixed app.js: replaced infinite reload with clean login modal display');
} else {
  console.log('app.js reload line already modified or not found');
}

// 2. Fix server.js session cookie sameSite: "lax"
const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let serverContent = fs.readFileSync(serverPath, 'utf8');

if (serverContent.includes('sameSite: "strict"')) {
  serverContent = serverContent.replace('sameSite: "strict"', 'sameSite: "lax"');
  fs.writeFileSync(serverPath, serverContent, 'utf8');
  console.log('Fixed server.js: changed session cookie sameSite from strict to lax');
} else {
  console.log('server.js sameSite already lax');
}
