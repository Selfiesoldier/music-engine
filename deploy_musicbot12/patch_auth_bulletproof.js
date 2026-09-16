import fs from 'fs';

// 1. Patch server.js
const serverPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/server.js';
let serverContent = fs.readFileSync(serverPath, 'utf8');

// Increase login rate limit to 30 attempts
serverContent = serverContent.replace('max: 5, // 5 requests per windowMs', 'max: 30, // 30 requests per windowMs');

// Update requireAuth to support query param token (?token= or ?auth=)
const oldRequireAuth = `const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (timingSafeCompare(token, ADMIN_PASSWORD)) {
      return next();
    }
  }
  
  res.status(401).send({ error: "Unauthorized" });
};`;

const newRequireAuth = `const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (timingSafeCompare(token, ADMIN_PASSWORD)) {
      return next();
    }
  }

  const queryToken = (req.query.token || req.query.auth || '').trim();
  if (queryToken && timingSafeCompare(queryToken, ADMIN_PASSWORD)) {
    return next();
  }
  
  res.status(401).send({ error: "Unauthorized" });
};`;

serverContent = serverContent.replace(oldRequireAuth, newRequireAuth);

// Update /api/login to return the token as well
serverContent = serverContent.replace(
  'req.session.authenticated = true;\n    res.send({ status: "ok" });',
  'req.session.authenticated = true;\n    res.send({ status: "ok", token: ADMIN_PASSWORD });'
);

fs.writeFileSync(serverPath, serverContent, 'utf8');
console.log('server.js updated with token support in query params and login response');

// 2. Patch public/js/app.js
const appJsPath = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/public/js/app.js';
let appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Update fetchApi to include Bearer token from localStorage and credentials: 'include'
const oldFetchApi = `async function fetchApi(endpoint, method = 'POST', body = null) {
  try {
    const res = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null
    });`;

const newFetchApi = `async function fetchApi(endpoint, method = 'POST', body = null) {
  const token = localStorage.getItem('admin_token') || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = \`Bearer \${token}\`;

  try {
    const res = await fetch(endpoint, {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : null
    });`;

appJsContent = appJsContent.replace(oldFetchApi, newFetchApi);

// In loginForm submit: store token in localStorage upon success
const oldLoginSubmit = `UI.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = document.getElementById('password').value;
  try {
    await fetchApi('/api/login', 'POST', { password: pwd });
    UI.loginOverlay.classList.remove('active');
    UI.dashboard.classList.remove('hidden');
    startSSE();
    loadDashboardData();
  } catch (err) {}
});`;

const newLoginSubmit = `UI.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = document.getElementById('password').value.trim();
  try {
    localStorage.setItem('admin_token', pwd);
    const data = await fetchApi('/api/login', 'POST', { password: pwd });
    if (data.token) localStorage.setItem('admin_token', data.token);
    UI.loginOverlay.classList.remove('active');
    UI.dashboard.classList.remove('hidden');
    startSSE();
    loadDashboardData();
  } catch (err) {
    localStorage.removeItem('admin_token');
  }
});`;

appJsContent = appJsContent.replace(oldLoginSubmit, newLoginSubmit);

// In initial ping: check with Bearer token from localStorage
const oldPing = `// Check if already authenticated via a quick API ping
fetch('/api/config')
  .then(res => {
    if (res.ok) {
      UI.loginOverlay.classList.remove('active');
      UI.dashboard.classList.remove('hidden');
      startSSE();
      loadDashboardData();
    }
  });`;

const newPing = `// Check if already authenticated via a quick API ping (supports localStorage token)
const existingToken = localStorage.getItem('admin_token') || '';
const pingHeaders = existingToken ? { 'Authorization': \`Bearer \${existingToken}\` } : {};
fetch('/api/config', { headers: pingHeaders, credentials: 'include' })
  .then(res => {
    if (res.ok) {
      UI.loginOverlay.classList.remove('active');
      UI.dashboard.classList.remove('hidden');
      startSSE();
      loadDashboardData();
    }
  });`;

appJsContent = appJsContent.replace(oldPing, newPing);

// In startSSE: pass token in query param
const oldStartSSE = `function startSSE() {
  if (eventSource) return;
  eventSource = new EventSource('/events');`;

const newStartSSE = `function startSSE() {
  if (eventSource) return;
  const token = localStorage.getItem('admin_token') || '';
  const sseUrl = token ? \`/events?token=\${encodeURIComponent(token)}\` : '/events';
  eventSource = new EventSource(sseUrl);`;

appJsContent = appJsContent.replace(oldStartSSE, newStartSSE);

fs.writeFileSync(appJsPath, appJsContent, 'utf8');
console.log('app.js updated with persistent Bearer token storage and auto-login');
