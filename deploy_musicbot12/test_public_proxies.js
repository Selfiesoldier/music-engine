import fetch from 'node-fetch';

const testVideoId = 'WTJSt4wP2ME'; // Wavin' Flag

async function testAPIs() {
  const instances = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.privacydev.net',
    'https://pipedapi.leptons.xyz',
    'https://cf.pipedapi.kavin.rocks',
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza',
    'https://vid.puffyan.us',
    'https://invidious.jing.rocks'
  ];

  console.log('Testing public bypass instances for YouTube audio streams...');

  for (const base of instances) {
    try {
      const isPiped = base.includes('piped');
      const url = isPiped ? `${base}/streams/${testVideoId}` : `${base}/api/v1/videos/${testVideoId}`;
      const res = await fetch(url, { timeout: 4000 });
      if (res.status === 200) {
        const json = await res.json();
        if (isPiped && json.audioStreams?.length > 0) {
          console.log(`🎉 WORKING PIPED INSTANCE: ${base}`);
          console.log(`Direct audio URL available!`);
          return;
        } else if (!isPiped && json.adaptiveFormats?.length > 0) {
          console.log(`🎉 WORKING INVIDIOUS INSTANCE: ${base}`);
          console.log(`Direct audio URL available!`);
          return;
        }
      } else {
        console.log(`${base}: HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(`${base}: ${e.message}`);
    }
  }
}

testAPIs();
