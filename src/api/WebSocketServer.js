export class EngineWebSocket {
  constructor(httpServer) {
    this.sseClients = new Set();
    this.wsClients = new Set();
    this.isDestroyed = false;
    this.initWs(httpServer);

    // Keepalive ping every 15s to keep SSE connections open through reverse proxies/Cloudflare
    this.heartbeatTimer = setInterval(() => {
      if (this.isDestroyed) return;
      for (const res of this.sseClients) {
        try {
          res.write(': ping\n\n');
        } catch (e) {
          this.sseClients.delete(res);
        }
      }
    }, 15000);
  }

  async initWs(httpServer) {
    try {
      const { WebSocketServer } = await import('ws');
      this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
      this.wss.on('connection', (ws) => {
        if (this.isDestroyed) {
          ws.close(1001, 'Server shutting down');
          return;
        }
        this.wsClients.add(ws);
        ws.on('close', () => this.wsClients.delete(ws));
        ws.on('error', () => this.wsClients.delete(ws));
      });
    } catch (e) {
      // ws package not installed, operating in lightweight native SSE mode
    }
  }

  addSSEClient(req, res) {
    if (this.isDestroyed) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Server shutting down');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    this.sseClients.add(res);
    req.on('close', () => this.sseClients.delete(res));
  }

  broadcast(eventType, data = {}) {
    if (this.isDestroyed) return;
    const payload = JSON.stringify({ type: eventType, data, timestamp: Date.now() });

    // 1. Broadcast to WebSockets
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch (e) {}
      }
    }

    // 2. Broadcast to SSE clients
    for (const res of this.sseClients) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch (e) {
        this.sseClients.delete(res);
      }
    }
  }

  destroy() {
    this.isDestroyed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    console.log('🛑 [WebSocket] Disconnecting SSE and WebSocket clients...');

    for (const res of this.sseClients) {
      try { res.end(); } catch (e) {}
    }
    this.sseClients.clear();

    for (const ws of this.wsClients) {
      try {
        if (ws.readyState === 1) {
          ws.close(1001, 'Server shutting down');
        }
      } catch (e) {}
    }
    this.wsClients.clear();

    if (this.wss) {
      try { this.wss.close(); } catch (e) {}
      this.wss = null;
    }
  }
}
