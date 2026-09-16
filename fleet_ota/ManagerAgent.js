const WebSocket = require('ws');
const os = require('os');

class ManagerAgent {
    constructor(fleetManager, options = {}) {
        this.fleetManager = fleetManager;
        this.ceoWsUrl = options.ceoWsUrl || process.env.CEO_WS_URL || 'ws://127.0.0.1:3500/ws/manager';
        this.secret = options.secret || process.env.FLEET_SECRET || 'highrise_fleet_master_secret_2026';
        this.nodeId = options.nodeId || process.env.NODE_ID || `node_${os.hostname().replace(/[^a-zA-Z0-9]/g, '_')}`;
        this.name = options.name || process.env.NODE_NAME || `Manager (${os.hostname()})`;
        this.maxCapacity = Number(options.maxCapacity || process.env.MAX_LOCAL_BOTS) || 10;
        this.botTypes = (options.botTypes || process.env.SUPPORTED_BOT_TYPES || 'emote,music')
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

        this.ws = null;
        this.isConnected = false;
        this.isAuthenticated = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.reconnectAttempts = 0;
        this.isShuttingDown = false;
    }

    start() {
        this.isShuttingDown = false;
        this.connect();
    }

    connect() {
        if (this.isShuttingDown) return;
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;

        console.log(`[ManagerAgent] 🔌 Connecting over-the-air to CEO at ${this.ceoWsUrl}...`);

        try {
            this.ws = new WebSocket(this.ceoWsUrl);

            this.ws.on('open', () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                console.log(`[ManagerAgent] 🟢 Connected to CEO Control Plane. Sending authentication handshake...`);
                this._sendAuth();
            });

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    this._handleMessage(msg);
                } catch (e) {
                    console.error('[ManagerAgent] Failed to parse message from CEO:', e.message);
                }
            });

            this.ws.on('close', (code, reason) => {
                this.isConnected = false;
                this.isAuthenticated = false;
                this._stopHeartbeat();
                if (!this.isShuttingDown) {
                    console.warn(`[ManagerAgent] 🔴 Disconnected from CEO (Code: ${code}, Reason: ${reason || 'none'}). Reconnecting in seconds...`);
                    this._scheduleReconnect();
                }
            });

            this.ws.on('error', (err) => {
                console.warn(`[ManagerAgent] Connection error: ${err.message}`);
            });
        } catch (err) {
            console.error('[ManagerAgent] Failed to initiate WebSocket connection:', err.message);
            this._scheduleReconnect();
        }
    }

    _sendAuth() {
        const payload = {
            type: 'AUTH',
            secret: this.secret,
            nodeId: this.nodeId,
            name: this.name,
            botTypes: this.botTypes,
            maxCapacity: this.maxCapacity,
            specs: {
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length,
                totalMemMB: Math.round(os.totalmem() / 1024 / 1024)
            }
        };
        this._send(payload);
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        // Send heartbeat every 15s
        this.heartbeatTimer = setInterval(() => {
            if (!this.isAuthenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            const rentals = this.fleetManager.getRentals();
            const activeRentals = rentals.filter(r => r.isRunning);
            const mem = process.memoryUsage();

            const payload = {
                type: 'HEARTBEAT',
                nodeId: this.nodeId,
                activeCount: activeRentals.length,
                maxCapacity: this.maxCapacity,
                ramUsedMB: Math.round(mem.rss / 1024 / 1024),
                totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
                activeBots: activeRentals.map(r => ({
                    rentalId: r.customerId,
                    botType: r.botType,
                    roomId: r.roomId,
                    pid: r.pid,
                    uptimeSeconds: r.startedAt ? Math.round((Date.now() - r.startedAt) / 1000) : 0
                }))
            };
            this._send(payload);
        }, 15000);
    }

    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    _scheduleReconnect() {
        if (this.isShuttingDown || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(15000, 2000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 5)));
        console.log(`[ManagerAgent] ⏳ Scheduling reconnection attempt in ${(delay / 1000).toFixed(1)}s (Attempt #${this.reconnectAttempts})...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    async _handleMessage(msg) {
        // 1. Auth acknowledgment
        if (msg.type === 'AUTH_ACK') {
            if (msg.success) {
                this.isAuthenticated = true;
                console.log(`[ManagerAgent] 🤝 Authenticated successfully with CEO Control Plane! Reporting live telemetry.`);
                this._startHeartbeat();
            } else {
                console.error(`[ManagerAgent] ❌ CEO rejected authentication: ${msg.error}`);
            }
            return;
        }

        // 2. CEO Command: DEPLOY_BOT
        if (msg.type === 'DEPLOY_BOT') {
            const { id, payload } = msg;
            console.log(`[ManagerAgent] 📦 Received CEO command to DEPLOY bot for customer "${payload.customerId}" (Type: ${payload.botType})...`);

            try {
                const deployResult = await this.fleetManager.deployRental({
                    customerId: payload.customerId,
                    customerUsername: payload.customerUsername,
                    botType: payload.botType || 'emote',
                    roomId: payload.roomId,
                    token: payload.token,
                    durationDays: Number(payload.durationDays) || 7,
                    ownerUsername: payload.ownerUsername,
                    customPrefix: payload.customPrefix,
                    forceActivate: true,
                    isRemoteDeploy: true
                });

                console.log(`[ManagerAgent] ✅ Bot for "${payload.customerId}" deployed and activated on this node!`);
                this._send({
                    id,
                    type: 'DEPLOY_BOT_ACK',
                    success: true,
                    rental: (deployResult?.rental || deployResult)
                });
            } catch (err) {
                console.error(`[ManagerAgent] ❌ Deployment failed for "${payload.customerId}":`, err.message);
                this._send({
                    id,
                    type: 'DEPLOY_BOT_ACK',
                    success: false,
                    error: err.message
                });
            }
            return;
        }

        // 3. CEO Command: TERMINATE_BOT
        if (msg.type === 'TERMINATE_BOT') {
            const { id, payload } = msg;
            console.log(`[ManagerAgent] 🛑 Received CEO command to TERMINATE bot "${payload.rentalId}" (Reason: ${payload.reason})...`);
            try {
                const result = this.fleetManager.terminateRental(payload.rentalId, payload.reason);
                this._send({ id, type: 'TERMINATE_BOT_ACK', success: Boolean(result) });
            } catch (err) {
                this._send({ id, type: 'TERMINATE_BOT_ACK', success: false, error: err.message });
            }
            return;
        }

        // 4. CEO Command: SUSPEND_BOT
        if (msg.type === 'SUSPEND_BOT') {
            const { id, payload } = msg;
            console.log(`[ManagerAgent] ⏸️ Received CEO command to SUSPEND bot "${payload.rentalId}"...`);
            try {
                const result = this.fleetManager.terminateRental(payload.rentalId, payload.reason || 'suspended');
                this._send({ id, type: 'SUSPEND_BOT_ACK', success: Boolean(result) });
            } catch (err) {
                this._send({ id, type: 'SUSPEND_BOT_ACK', success: false, error: err.message });
            }
            return;
        }

        // 5. CEO Command: RESTART_BOT
        if (msg.type === 'RESTART_BOT') {
            const { id, payload } = msg;
            console.log(`[ManagerAgent] 🔄 Received CEO command to RESTART bot "${payload.rentalId}"...`);
            try {
                const result = this.fleetManager.restartRental(payload.rentalId);
                this._send({ id, type: 'RESTART_BOT_ACK', success: result.success, message: result.message });
            } catch (err) {
                this._send({ id, type: 'RESTART_BOT_ACK', success: false, error: err.message });
            }
            return;
        }

        // 6. CEO Command: GET_LOGS
        if (msg.type === 'GET_LOGS') {
            const { id, payload } = msg;
            try {
                const logs = await this.fleetManager.getRentalLogs(payload.rentalId, payload.lines || 100);
                this._send({ id, type: 'GET_LOGS_ACK', success: true, logs });
            } catch (err) {
                this._send({ id, type: 'GET_LOGS_ACK', success: false, error: err.message });
            }
            return;
        }
    }

    _send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(data));
            } catch (err) {
                console.warn(`[ManagerAgent] Failed to send WebSocket message: ${err.message}`);
            }
        }
    }

    stop() {
        this.isShuttingDown = true;
        this._stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(1000, 'Manager shutting down'); } catch (_) {}
        }
        console.log('[ManagerAgent] Manager Agent stopped.');
    }
}

module.exports = ManagerAgent;
