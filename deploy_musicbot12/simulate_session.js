import fetch from 'node-fetch';

async function testSession() {
  console.log('--- 1. Testing GET / ---');
  const r1 = await fetch('https://musicbot12-ld6i.onrender.com/');
  console.log('GET / Status:', r1.status);
  console.log('GET / Refresh header:', r1.headers.get('refresh'));

  console.log('\n--- 2. Testing POST /api/login ---');
  const r2 = await fetch('https://musicbot12-ld6i.onrender.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'changeme' })
  });
  console.log('POST /api/login Status:', r2.status);
  const setCookie = r2.headers.get('set-cookie');
  console.log('Set-Cookie:', setCookie);

  console.log('\n--- 3. Testing GET /api/config with session cookie ---');
  const cookieHeader = setCookie ? setCookie.split(';')[0] : '';
  const r3 = await fetch('https://musicbot12-ld6i.onrender.com/api/config', {
    headers: { 'Cookie': cookieHeader }
  });
  console.log('GET /api/config Status:', r3.status);
  const data3 = await r3.json().catch(() => null);
  console.log('GET /api/config Data:', data3);

  console.log('\n--- 4. Testing GET /events with session cookie ---');
  const r4 = await fetch('https://musicbot12-ld6i.onrender.com/events', {
    headers: { 'Cookie': cookieHeader }
  });
  console.log('GET /events Status:', r4.status);
  console.log('GET /events Content-Type:', r4.headers.get('content-type'));
}

testSession();
