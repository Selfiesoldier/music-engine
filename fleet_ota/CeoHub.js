const WebSocket = require('ws');
const crypto = require('crypto');

class CeoHub {
    constructor(fleetManager, options = {}) {
        this.fleetManager = fleetManager;
        this.secret = process.env.FLEET_SECRET || 'highrise_fleet_master_secret_2026';
        this.wss = null;
        this.managers = new Map(); // nodeId -> { ws, info, stats, lastHeartbeat }
        this.pendingRequests = new Map(); // msgId -> { resolve, reject, timer }
        this.heartbeatCheckInterval = null;
    }

    /**
     * Attach WebSocket server to an existing HTTP server instance (e.g. from FleetApiServer)
     */
    attachToServer(httpServer) {
        this.wss = new WebSocket.Server({ server: httpServer, path: '/ws/manager' });

        this.wss.on('connection', (ws, req) => {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            console.log(`[CeoHub] 📡 Incoming Manager connection attempt from ${clientIp}`);

            let authenticatedNodeId = null;

            // Auth timeout: must authenticate within 5 seconds
            const authTimer = setTimeout(() => {
                if (!authenticatedNodeId) {
                    console.warn(`[CeoHub] ⚠️ Manager from ${clientIp} failed to authenticate in time. Disconnecting.`);
                    ws.close(4001, 'Authentication timeout');
                }
            }, 5000);

            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    this._handleMessage(ws, msg, (nodeId) => {
                        authenticatedNodeId = nodeId;
                        clearTimeout(authTimer);
                    });
                } catch (e) {
                    console.error('[CeoHub] Invalid JSON message from manager:', e.message);
                }
            });

            ws.on('close', (code, reason) => {
                clearTimeout(authTimer);
                if (authenticatedNodeId) {
                    const mgr = this.managers.get(authenticatedNodeId);
                    console.warn(`[CeoHub] 🔌 Manager "${mgr?.info?.name || authenticatedNodeId}" disconnected (Code: ${code}, Reason: ${reason || 'none'})`);
                    this.managers.delete(authenticatedNodeId);
                }
            });

            ws.on('error', (err) => {
                console.error(`[CeoHub] WebSocket error on connection (${authenticatedNodeId || clientIp}):`, err.message);
            });
        });

        // 30s heartbeat watchdog to reap stale/dead manager connections
        this.heartbeatCheckInterval = setInterval(() => {
            const now = Date.now();
            for (const [nodeId, mgr] of this.managers.entries()) {
                if (now - mgr.lastHeartbeat > 45000) {
                    console.warn(`[CeoHub] ⚠️ Manager "${mgr.info?.name || nodeId}" timed out (no heartbeat for 45s). Dropping.`);
                    try { mgr.ws.terminate(); } catch (_) {}
                    this.managers.delete(nodeId);
                }
            }
        }, 15000);

        console.log('[CeoHub] 👑 CEO Fleet Control Plane WebSocket active on path /ws/manager');
    }

    _handleMessage(ws, msg, setAuthenticated) {
        // 1. Authentication Handshake
        if (msg.type === 'AUTH') {
            if (!msg.secret || msg.secret !== this.secret) {
                console.warn(`[CeoHub] ❌ Unauthorized manager registration attempt (Invalid Secret) from nodeId: ${msg.nodeId}`);
                ws.send(JSON.stringify({ type: 'AUTH_ACK', success: false, error: 'Unauthorized: Invalid FLEET_SECRET' }));
                ws.close(4001, 'Unauthorized');
                return;
            }

            const nodeId = msg.nodeId || `node_${Date.now()}`;
            const info = {
                nodeId,
                name: msg.name || nodeId,
                botTypes: (msg.botTypes || ['emote', 'music']).map(t => t.toLowerCase()),
                maxCapacity: Number(msg.maxCapacity) || 10,
                specs: msg.specs || {},
                connectedAt: Date.now()
            };

            this.managers.set(nodeId, {
                ws,
                info,
                stats: { activeCount: 0, cpuPercent: 0, ramUsedMB: 0, activeBots: [] },
                lastHeartbeat: Date.now()
            });

            setAuthenticated(nodeId);
            console.log(`[CeoHub] 🤝 Manager Authenticated: "${info.name}" [${nodeId}] (Max Capacity: ${info.maxCapacity}, Types: ${info.botTypes.join(', ')})`);

            ws.send(JSON.stringify({
                type: 'AUTH_ACK',
                success: true,
                message: 'Authenticated with CEO Control Plane',
                assignedNodeId: nodeId
            }));
            return;
        }

        // 2. Manager Heartbeat
        if (msg.type === 'HEARTBEAT') {
            const mgr = this.managers.get(msg.nodeId);
            if (mgr) {
                mgr.lastHeartbeat = Date.now();
                mgr.stats = {
                    activeCount: Number(msg.activeCount) || (Array.isArray(msg.activeBots) ? msg.activeBots.length : 0),
                    cpuPercent: Number(msg.cpuPercent) || 0,
                    ramUsedMB: Number(msg.ramUsedMB) || 0,
                    totalMemMB: Number(msg.totalMemMB) || 0,
                    activeBots: Array.isArray(msg.activeBots) ? msg.activeBots : []
                };

                // Two-Way Sync: Keep CEO fleet ledger updated with active bots running on this remote manager
                if (Array.isArray(msg.activeRentals) && msg.activeRentals.length > 0) {
                    let changed = false;
                    for (const remoteR of msg.activeRentals) {
                        const key = remoteR.rentalId || `${remoteR.customerId}_${remoteR.roomId}_${remoteR.botType}`;
                        const existing = this.fleetManager.rentals.get(key);
                        if (!existing || existing.status !== 'active') {
                            remoteR.nodeId = msg.nodeId;
                            remoteR.nodeName = mgr.info?.name || msg.nodeId;
                            remoteR.status = 'active';
                            remoteR.isRunning = true;
                            this.fleetManager.rentals.set(key, remoteR);
                            changed = true;
                            console.log(`[CeoHub] 🔄 Re-synced active bot "${key}" from Manager "${mgr.info?.name || msg.nodeId}" into CEO fleet ledger`);
                        }
                    }
                    if (changed) {
                        this.fleetManager._saveRentals();
                    }
                }
            }
            return;
        }

        // 3. Response to a pending CEO command (DEPLOY, TERMINATE, RESTART, etc.)
        if (msg.id && this.pendingRequests.has(msg.id)) {
            const { resolve, reject, timer } = this.pendingRequests.get(msg.id);
            clearTimeout(timer);
            this.pendingRequests.delete(msg.id);

            if (msg.success) {
                resolve(msg);
            } else {
                reject(new Error(msg.error || 'Remote manager command failed'));
            }
        }
    }

    /**
     * Send command to a remote manager and await response
     */
    _sendCommand(nodeId, type, payload = {}, timeoutMs = 25000) {
        return new Promise((resolve, reject) => {
            const mgr = this.managers.get(nodeId);
            if (!mgr || mgr.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error(`Manager "${nodeId}" is not connected to CEO`));
            }

            const msgId = `cmd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const timer = setTimeout(() => {
                this.pendingRequests.delete(msgId);
                reject(new Error(`Command ${type} to manager "${nodeId}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRequests.set(msgId, { resolve, reject, timer });

            mgr.ws.send(JSON.stringify({
                id: msgId,
                type,
                payload
            }));
        });
    }

    /**
     * Select the best eligible Manager across the cluster for a given bot type
     */
    selectBestManager(botType = 'emote') {
        const typeNorm = (botType || 'emote').toLowerCase();
        const eligible = [];

        for (const [nodeId, mgr] of this.managers.entries()) {
            if (mgr.ws.readyState !== WebSocket.OPEN) continue;
            if (!mgr.info.botTypes.includes(typeNorm)) continue;
            if (mgr.stats.activeCount >= mgr.info.maxCapacity) continue;

            eligible.push({
                nodeId,
                name: mgr.info.name,
                activeCount: mgr.stats.activeCount,
                maxCapacity: mgr.info.maxCapacity,
                loadRatio: mgr.stats.activeCount / mgr.info.maxCapacity,
                cpuPercent: mgr.stats.cpuPercent
            });
        }

        if (eligible.length === 0) {
            return null; // No available remote managers
        }

        // Sort by lowest load ratio, then lowest active count
        eligible.sort((a, b) => {
            if (a.loadRatio !== b.loadRatio) return a.loadRatio - b.loadRatio;
            return a.activeCount - b.activeCount;
        });

        return eligible[0];
    }

    /**
     * CEO Command: Deploy a bot to a remote Manager
     */
    async deployBot(nodeId, deployData) {
        console.log(`[CeoHub] 🚀 Dispatching DEPLOY_BOT for "${deployData.customerId}" to Manager [${nodeId}]...`);
        return await this._sendCommand(nodeId, 'DEPLOY_BOT', deployData, 30000);
    }

    /**
     * CEO Command: Terminate a bot on a remote Manager
     */
    async terminateBot(nodeId, rentalId, reason = 'terminated') {
        console.log(`[CeoHub] 🛑 Dispatching TERMINATE_BOT for "${rentalId}" to Manager [${nodeId}] (Reason: ${reason})...`);
        return await this._sendCommand(nodeId, 'TERMINATE_BOT', { rentalId, reason }, 15000);
    }

    /**
     * CEO Command: Suspend/Pause a bot on a remote Manager
     */
    async suspendBot(nodeId, rentalId, reason = 'suspended') {
        console.log(`[CeoHub] ⏸️ Dispatching SUSPEND_BOT for "${rentalId}" to Manager [${nodeId}]...`);
        return await this._sendCommand(nodeId, 'SUSPEND_BOT', { rentalId, reason }, 15000);
    }

    /**
     * CEO Command: Restart a bot on a remote Manager
     */
    async restartBot(nodeId, rentalId) {
        console.log(`[CeoHub] 🔄 Dispatching RESTART_BOT for "${rentalId}" to Manager [${nodeId}]...`);
        return await this._sendCommand(nodeId, 'RESTART_BOT', { rentalId }, 15000);
    }

    /**
     * CEO Command: Fetch real-time logs from a remote Manager
     */
    async getLogs(nodeId, rentalId, lines = 100) {
        return await this._sendCommand(nodeId, 'GET_LOGS', { rentalId, lines }, 10000);
    }

    /**
     * Get snapshot of all connected Managers for the Admin Dashboard
     */
    getClusterStatus() {
        const list = [];
        for (const [nodeId, mgr] of this.managers.entries()) {
            list.push({
                nodeId,
                name: mgr.info.name,
                botTypes: mgr.info.botTypes,
                maxCapacity: mgr.info.maxCapacity,
                activeCount: mgr.stats.activeCount,
                cpuPercent: mgr.stats.cpuPercent,
                ramUsedMB: mgr.stats.ramUsedMB,
                connectedAt: mgr.info.connectedAt,
                lastHeartbeatAgoSec: Math.round((Date.now() - mgr.lastHeartbeat) / 1000),
                status: 'online'
            });
        }
        return list;
    }

    destroy() {
        if (this.heartbeatCheckInterval) clearInterval(this.heartbeatCheckInterval);
        for (const req of this.pendingRequests.values()) {
            clearTimeout(req.timer);
            req.reject(new Error('CeoHub destroyed'));
        }
        this.pendingRequests.clear();
        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = CeoHub;
