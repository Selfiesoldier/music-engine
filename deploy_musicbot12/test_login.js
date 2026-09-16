import fetch from 'node-fetch';

async function test() {
  const res = await fetch('https://musicbot12-ld6i.onrender.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'changeme' })
  });
  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Response:', data);
}

test();
