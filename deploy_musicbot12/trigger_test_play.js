import fetch from 'node-fetch';

async function testPlay() {
  const resp = await fetch('https://musicbot12-ld6i.onrender.com/play', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer changeme'
    },
    body: JSON.stringify({
      url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
      title: 'Luis Fonsi - Despacito ft. Daddy Yankee'
    })
  });
  const data = await resp.json();
  console.log('Play response:', data);
}

testPlay().catch(console.error);
