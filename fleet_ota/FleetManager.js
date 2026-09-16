const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const PythonRuntime = require('./PythonRuntime');
const EventEmitter = require('events');
const WorkerNodeManager = require('./WorkerNodeManager');

class FleetManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.baseDir = options.baseDir || path.resolve(__dirname, '..');
        this.instancesDir = path.join(this.baseDir, 'instances');
        this.dataDir = path.join(this.baseDir, 'data');
        this.rentalsFile = path.join(this.dataDir, 'rentals.json');
        this.settingsFile = path.join(this.dataDir, 'settings.json');
        this.tokenPoolFile = path.join(this.dataDir, 'token_pool.json');
        this.creditsFile = path.join(this.dataDir, 'credits.json');
        this.goldPerDay = Number(process.env.GOLD_PER_DAY) || 25;
        
        // Target bot engine paths - smart multi-environment auto-discovery
        this.pakbotPath = this._resolveBotPath(
            options.pakbotPath,
            'PAKBOT_PATH',
            'pakbotgem',
            'c:/Users/sanif/OneDrive/Desktop/pakbotgem'
        );
        this.musicbotPath = this._resolveBotPath(
            options.musicbotPath,
            'MUSICBOT_PATH',
            'musicbot',
            'c:/Users/sanif/OneDrive/Desktop/musicbot-main'
        );

        this.rentals = new Map(); // rentalId -> rental metadata
        this.activeProcesses = new Map(); // rentalId -> { child, logStream }
        this.crashTracker = new Map(); // rentalId -> { count: number, firstCrash: number }
        this.credits = new Map(); // userId -> { username, goldBalance, totalTipped }
        this.settings = this._loadSettings();
        this.tokenPool = this._loadTokenPool();
        this.nodeManager = new WorkerNodeManager(this);
        this.tombstones = new Set();
        this._loadTombstones();
    }

    _resolveBotPath(explicitPath, envVarName, subDirName, localFallback) {
        const candidates = [
            explicitPath,
            process.env[envVarName],
            path.join(this.baseDir, subDirName),
            path.join(this.baseDir, 'templates', subDirName),
            path.resolve(this.baseDir, '..', subDirName),
            localFallback
        ].filter(Boolean);

        for (const cand of candidates) {
            try {
                if (fs.existsSync(cand)) {
                    if (fs.existsSync(path.join(cand, 'index.js')) ||
                        fs.existsSync(path.join(cand, 'main.py')) ||
                        fs.existsSync(path.join(cand, 'server.js'))) {
                        return cand;
                    }
                }
            } catch (_) {}
        }
        return path.join(this.baseDir, subDirName);
    }

    // --- WALLET / CREDITS MANAGEMENT (Shared by MasterBot + Watchdog) ---
    
    _loadTombstones() {
        this.tombstoneFile = path.join(this.dataDir, 'tombstones.json');
        try {
            if (fs.existsSync(this.tombstoneFile)) {
                const arr = JSON.parse(fs.readFileSync(this.tombstoneFile, 'utf-8'));
                if (Array.isArray(arr)) {
                    this.tombstones = new Set(arr);
                }
            }
        } catch (_) {}
    }

    _saveTombstones() {
        try {
            if (!this.tombstoneFile) this.tombstoneFile = path.join(this.dataDir, 'tombstones.json');
            fs.writeFileSync(this.tombstoneFile, JSON.stringify(Array.from(this.tombstones)), 'utf-8');
        } catch (_) {}
    }

    loadCredits() {
        if (fs.existsSync(this.creditsFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.creditsFile, 'utf-8'));
                for (const [k, v] of Object.entries(data)) {
                    // Backwards-compatibility: migrate legacy daysCredit to goldBalance
                    if (v.daysCredit !== undefined && v.goldBalance === undefined) {
                        v.goldBalance = v.daysCredit * this.goldPerDay;
                        delete v.daysCredit;
                    }
                    this.credits.set(k, v);
                }
                console.log(`[FleetManager] Loaded ${this.credits.size} wallet(s) from credits.json`);
            } catch (e) {
                console.error('[FleetManager] Failed reading credits.json:', e.message);
            }
        }
    }

    saveCredits() {
        try {
            const obj = Object.fromEntries(this.credits);
            const tmpFile = this.creditsFile + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2), 'utf-8');
            fs.renameSync(tmpFile, this.creditsFile);
        } catch (e) {
            console.error('[FleetManager] Failed saving credits.json:', e.message);
        }
    }

    getBalance(userId) {
        const credit = this.credits.get(userId);
        return (credit && credit.goldBalance) ? credit.goldBalance : 0;
    }

    getDaysAvailable(userId) {
        return Math.floor(this.getBalance(userId) / this.goldPerDay);
    }

    addBalance(userId, amount, username) {
        const prev = this.credits.get(userId) || { username: username || userId, goldBalance: 0, totalTipped: 0 };
        if (username) prev.username = username;
        prev.goldBalance = (prev.goldBalance || 0) + amount;
        prev.totalTipped = (prev.totalTipped || 0) + amount;
        this.credits.set(userId, prev);
        this.saveCredits();
        return prev;
    }

    deductBalance(userId, amount) {
        const credit = this.credits.get(userId);
        if (!credit) return false;
        credit.goldBalance = Math.max(0, (credit.goldBalance || 0) - amount);
        this.credits.set(userId, credit);
        this.saveCredits();
        return credit;
    }

    _loadSettings() {
        const defaults = {
            musicApiUrl: process.env.MUSIC_API_URL || 'http://localhost:30060',
            musicApiSecret: process.env.MUSIC_API_SECRET || 'highrise_music_secret_2026',
            autoActivateMusic: false, // On-demand manual activation by default
            workerServers: [],
            adminSecret: process.env.ADMIN_SECRET || 'masteradmin'
        };

        if (fs.existsSync(this.settingsFile)) {
            try {
                const raw = fs.readFileSync(this.settingsFile, 'utf-8');
                return { ...defaults, ...JSON.parse(raw) };
            } catch (e) {
                console.error('[FleetManager] Failed to read settings.json, using defaults:', e.message);
            }
        }
        return defaults;
    }

    _saveSettings() {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            const tmpFile = this.settingsFile + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify(this.settings, null, 2), 'utf-8');
            fs.renameSync(tmpFile, this.settingsFile);
        } catch (e) {
            console.error('[FleetManager] Failed to save settings.json:', e.message);
        }
    }

    getConfig() {
        return { ...this.settings };
    }

    updateConfig(newConfig = {}) {
        this.settings = { ...this.settings, ...newConfig };
        this._saveSettings();
        this.emit('config_updated', this.settings);
        return this.getConfig();
    }

    // --- HOSTED TOKEN POOL MANAGEMENT ---
    _loadTokenPool() {
        if (fs.existsSync(this.tokenPoolFile)) {
            try {
                const raw = fs.readFileSync(this.tokenPoolFile, 'utf-8');
                return JSON.parse(raw);
            } catch (e) {
                console.error('[FleetManager] Failed to read token_pool.json:', e.message);
            }
        }
        return [];
    }

    _saveTokenPool() {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            const tmpFile = this.tokenPoolFile + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify(this.tokenPool, null, 2), 'utf-8');
            fs.renameSync(tmpFile, this.tokenPoolFile);
        } catch (e) {
            console.error('[FleetManager] Failed to save token_pool.json:', e.message);
        }
    }

    getTokenPool(mask = true) {
        return this.tokenPool.map(t => ({
            ...t,
            token: mask ? (t.token.slice(0, 8) + '...' + t.token.slice(-4)) : t.token,
            rawToken: t.token
        }));
    }

    getAvailableTokens(botType = 'any') {
        return this.tokenPool.filter(t => {
            if (t.status !== 'available') return false;
            if (t.botType && t.botType !== 'any' && botType !== 'any' && t.botType !== botType) return false;
            if (this.isTokenInUse(t.token)) return false;
            return true;
        });
    }

    checkoutTokenFromPool({ botType = 'any', customerId, roomId }) {
        const available = this.getAvailableTokens(botType);
        if (available.length === 0) {
            throw new Error('All hosted bot accounts in the fleet inventory are currently in use! Please try again later or provide your own Bot API token.');
        }

        const picked = available[0];
        picked.status = 'in_use';
        picked.assignedTo = customerId;
        picked.assignedRoom = roomId;
        picked.assignedAt = Date.now();
        this._saveTokenPool();
        this.emit('token_pool_updated', this.getTokenPool(false));
        console.log(`[FleetManager] 🔑 Checked out hosted bot account "${picked.label}" (${picked.id}) for @${customerId} (Room: ${roomId})`);
        return picked;
    }

    releaseTokenToPool(tokenOrRentalIdOrId) {
        if (!tokenOrRentalIdOrId) return false;
        let changed = false;
        for (const item of this.tokenPool) {
            const isMatch = (item.id === tokenOrRentalIdOrId) ||
                            (item.token && item.token === tokenOrRentalIdOrId) ||
                            (item.assignedTo && item.assignedTo === tokenOrRentalIdOrId) ||
                            (item.assignedRoom && item.assignedRoom === tokenOrRentalIdOrId);
            if (isMatch && item.status !== 'available') {
                item.status = 'available';
                item.assignedTo = null;
                item.assignedRoom = null;
                item.assignedAt = null;
                changed = true;
                console.log(`[FleetManager] 🔓 Released hosted bot account "${item.label}" back to available inventory`);
            }
        }
        if (changed) {
            this._saveTokenPool();
            this.emit('token_pool_updated', this.getTokenPool(false));
        }
        return changed;
    }

    addTokenToPool({ label, token, botType = 'any' }) {
        const clean = (token || '').trim();
        if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
            throw new Error('Invalid Highrise Bot Token: must be exactly 64 hexadecimal characters.');
        }
        if (this.tokenPool.some(t => t.token.toLowerCase() === clean.toLowerCase())) {
            throw new Error('This bot token is already registered in the token pool!');
        }
        const id = 'alpha_' + (this.tokenPool.length + 1);
        const entry = {
            id,
            label: (label || `ALPHA_${this.tokenPool.length + 1}`).trim().toUpperCase(),
            token: clean,
            botType: botType || 'any',
            status: 'available',
            assignedTo: null,
            assignedRoom: null,
            assignedAt: null,
            createdAt: Date.now()
        };
        this.tokenPool.push(entry);
        this._saveTokenPool();
        this.emit('token_pool_updated', this.getTokenPool(false));
        return entry;
    }

    removeTokenFromPool(tokenId) {
        const idx = this.tokenPool.findIndex(t => t.id === tokenId || t.label === tokenId);
        if (idx === -1) return false;
        const removed = this.tokenPool.splice(idx, 1)[0];
        this._saveTokenPool();
        this.emit('token_pool_updated', this.getTokenPool(false));
        return removed;
    }


    init() {
        console.log('[FleetManager] Engine template paths:');
        console.log('  - Emote bot:', this.pakbotPath);
        console.log('  - Music bot:', this.musicbotPath);
        console.log(`  - Gold rate: ${this.goldPerDay}g/day (Prepaid Wallet Model)`);
        fs.mkdirSync(this.instancesDir, { recursive: true });
        fs.mkdirSync(this.dataDir, { recursive: true });

        // Load existing rentals
        if (fs.existsSync(this.rentalsFile)) {
            try {
                const raw = fs.readFileSync(this.rentalsFile, 'utf-8');
                const list = JSON.parse(raw);
                for (const item of list) {
                    const key = item.rentalId || `${item.customerId}_${item.roomId}` || item.customerId;
                    item.rentalId = key;
                    this.rentals.set(key, item);
                }
                console.log(`[FleetManager] Loaded ${this.rentals.size} total rental records from storage.`);
            } catch (err) {
                console.error('[FleetManager] Error reading rentals.json:', err.message);
            }
        } else {
            this._saveRentals();
        }

        // Load wallet balances
        this.loadCredits();

        // Recover any active rentals that should still be running
        this.recoverActiveRentals();
    }

    _saveRentals() {
        try {
            const list = Array.from(this.rentals.values());
            const tmpFile = this.rentalsFile + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), 'utf-8');
            fs.renameSync(tmpFile, this.rentalsFile); // Atomic write
        } catch (err) {
            console.error('[FleetManager] Failed to save rentals.json:', err.message);
        }
    }

    recoverActiveRentals() {
        const now = Date.now();
        let recovered = 0;
        let expired = 0;
        let pending = 0;

        for (const [rentalId, rental] of this.rentals.entries()) {
            if (rental.status === 'pending_activation') {
                pending++;
                continue;
            }

            if (rental.status === 'active' || rental.status === 'server_shutdown') {
                rental.status = 'active';
                if (rental.nodeId && rental.nodeId !== 'local') {
                    console.log(`[FleetManager] Rental for ${rental.customerUsername} (${rental.roomId}) is running on remote node "${rental.nodeName || rental.nodeId}". Skipping local spawn.`);
                    recovered++;
                    continue;
                }
                // Wallet model: always relaunch active bots (billing handled by Watchdog)
                console.log(`[FleetManager] Relaunching active rental for ${rental.customerUsername} (${rental.roomId})...`);
                this._spawnProcess(rental);
                recovered++;
            } else if (rental.status === 'grace') {
                // Grace period bots stay paused, Watchdog handles deletion
                console.log(`[FleetManager] Rental for ${rental.customerUsername} (${rental.roomId}) is in grace period.`);
            }
        }

        this._saveRentals();
        // Reconcile token pool with active rentals
        for (const item of this.tokenPool) {
            let inUseBy = null;
            for (const r of this.rentals.values()) {
                if ((r.status === 'active' || r.status === 'pending_activation') && (r.fullToken === item.token || r.tokenPoolId === item.id)) {
                    inUseBy = r;
                    break;
                }
            }
            if (inUseBy) {
                item.status = 'in_use';
                item.assignedTo = inUseBy.customerId;
                item.assignedRoom = inUseBy.roomId;
            } else {
                item.status = 'available';
                item.assignedTo = null;
                item.assignedRoom = null;
            }
        }
        this._saveTokenPool();
        const availCount = this.getAvailableTokens().length;
        console.log(`[FleetManager] Startup check: ${recovered} bots recovered, ${pending} pending activation, ${expired} expired. Token inventory: ${availCount}/${this.tokenPool.length} bots ready.`);
    }

    _validateCredentials(cleanRoom, cleanToken) {
        if (cleanRoom.length === 64 && cleanToken.length === 24) {
            throw new Error('Room ID and Bot Token appear to be swapped! Room IDs are 24 characters, Bot Tokens are 64 characters.');
        }
        if (cleanRoom.length === 64) {
            throw new Error('You entered a 64-character Bot API Token where a 24-character Room ID was expected! Room IDs are found in Highrise room settings.');
        }
        if (cleanRoom.length !== 24) {
            throw new Error(`Invalid Room ID length! Highrise Room IDs are exactly 24 characters, but received ${cleanRoom.length} characters.`);
        }
        if (!/^[0-9a-fA-F]{24}$/.test(cleanRoom)) {
            throw new Error('Invalid Room ID format! Highrise Room IDs contain only hexadecimal characters (0-9 and a-f).');
        }
        if (cleanToken.length === 24) {
            throw new Error('You entered a 24-character Room ID where a 64-character Bot Token was expected! Bot Tokens are generated at create.highrise.game.');
        }
        if (cleanToken.length !== 64) {
            throw new Error(`Invalid Bot API Token length! Highrise Bot Tokens are exactly 64 characters, but received ${cleanToken.length} characters.`);
        }
        if (!/^[0-9a-fA-F]{64}$/.test(cleanToken)) {
            throw new Error('Invalid Bot API Token format! Highrise Bot Tokens contain only 64 hexadecimal characters (0-9 and a-f) with no spaces.');
        }
    }

    _checkTokenCollision(cleanToken, cleanRoom, customerId, botType) {
        // Protect Master Bot's own token
        const masterToken = (process.env.MASTER_BOT_TOKEN || '').trim();
        if (masterToken && cleanToken === masterToken) {
            throw new Error('Security Error: You cannot use the Master Cashier Bot\'s API token for a customer bot!');
        }

        // Check active and pending rentals across the entire fleet
        for (const rental of this.rentals.values()) {
            const isColliding = (rental.fullToken && rental.fullToken === cleanToken) ||
                                (rental.token && cleanToken.startsWith(rental.token.replace(/\./g, '')));

            if (isColliding) {
                const isActive = rental.status === 'active' || rental.status === 'pending_activation';
                if (isActive) {
                    // Allow redeployment ONLY if it is the EXACT same botType, customer, and room
                    if (rental.customerId === customerId && rental.roomId === cleanRoom && rental.botType === botType) {
                        continue;
                    }
                    
                    const existingType = rental.botType === 'music' ? 'Music DJ Bot' : 'Emote Bot';
                    const newType = botType === 'music' ? 'Music DJ Bot' : 'Emote Bot';
                    
                    if (rental.roomId === cleanRoom) {
                        throw new Error(
                            `API Key Already In Use: This Bot API Token is already running as your ${existingType} in this room! ` +
                            `In Highrise, one bot account cannot physically run both an Emote Bot and a Music Bot simultaneously. ` +
                            `To run a ${newType} alongside it, please use a separate bot account's token. ` +
                            `Or stop your ${existingType} first using //killbot.`
                        );
                    } else {
                        const roomInfo = rental.roomId ? `room "${rental.roomId}"` : 'another room';
                        const ownerInfo = rental.customerUsername ? ` (owned by @${rental.customerUsername})` : '';
                        throw new Error(
                            `API Key Collision: This Bot API Token is already actively in use by a ${existingType} in ${roomInfo}${ownerInfo}! ` +
                            `In Highrise, one bot account cannot physically be in two rooms at the same time. ` +
                            `Please use a different bot token or stop the existing bot first.`
                        );
                    }
                }
            }
        }
    }

    isTokenInUse(token, excludeRentalId = null) {
        if (!token) return null;
        const clean = token.trim();
        const masterToken = (process.env.MASTER_BOT_TOKEN || '').trim();
        if (masterToken && clean === masterToken) {
            return { roomId: process.env.MASTER_ROOM_ID || 'showroom', customerUsername: 'MasterBot' };
        }

        for (const rental of this.rentals.values()) {
            if (excludeRentalId && rental.rentalId === excludeRentalId) continue;
            const isColliding = (rental.fullToken && rental.fullToken === clean) ||
                                (rental.token && clean.startsWith(rental.token.replace(/\./g, '')));
            if (isColliding && (rental.status === 'active' || rental.status === 'pending_activation')) {
                return rental;
            }
        }
        return null;
    }

    // Places an order in the PENDING_ACTIVATION queue (for on-demand provisioning)
    queueRental({ customerId, customerUsername, botType = 'music', roomId, token, durationDays = 7, ownerUsername, customPrefix }) {
        if (!customerId || !roomId) {
            throw new Error('Missing required fields: customerId and roomId are required.');
        }

        const cleanRoom = roomId.trim().toLowerCase();
        let cleanToken = (token || '').trim();
        let poolEntry = null;

        if (!cleanToken || cleanToken.toUpperCase() === 'AUTO' || cleanToken.toUpperCase() === 'HOSTED') {
            poolEntry = this.checkoutTokenFromPool({ botType, customerId, roomId: cleanRoom });
            cleanToken = poolEntry.token;
        }
        this._validateCredentials(cleanRoom, cleanToken);
        this._checkTokenCollision(cleanToken, cleanRoom, customerId, botType);

        const tokenSuffix = poolEntry ? poolEntry.id : (cleanToken ? cleanToken.slice(-8).toLowerCase() : 'def');
        const rentalId = `${customerId}_${cleanRoom}_${botType}_${tokenSuffix}`;
        const resolvedOwner = (ownerUsername || customerUsername || customerId).replace(/^@/, '').trim().toLowerCase();

        // Setup tenant directory
        const tenantDirName = `tenant_${customerId.slice(0, 8)}_${cleanRoom.slice(0, 6)}_${botType}_${tokenSuffix}`;
        const tenantDir = path.join(this.instancesDir, tenantDirName);
        fs.mkdirSync(tenantDir, { recursive: true });

        const envPath = path.join(tenantDir, '.env');
        const rolesPath = path.join(tenantDir, 'roles.json');
        const dbPath = path.join(tenantDir, 'bot.sqlite');
        if (!fs.existsSync(rolesPath)) {
            fs.writeFileSync(rolesPath, JSON.stringify({}), 'utf-8');
        }

        const defaultPrefix = botType === 'music' ? '/' : '!';
        const prefix = customPrefix || defaultPrefix;

        const envContent = [
            `# Tenant Environment: ${customerUsername || customerId} (${cleanRoom})`,
            `BOT_TOKEN=${cleanToken}`,
            `HIGHRISE_API_TOKEN=${cleanToken}`,
            `ROOM_ID=${cleanRoom}`,
            `HIGHRISE_ROOM_ID=${cleanRoom}`,
            `BOT_NAME=${botType === 'emote' ? 'PakBot' : 'MusicBot'}`,
            `BOT_PREFIX=${prefix}`,
            `DEFAULT_MOOD=energetic`,
            `ROLES_PERSIST_PATH=${rolesPath}`,
            `SQLITE_DB_PATH=${dbPath}`,
            `OWNER_USERNAME=${resolvedOwner}`,
            `MUSIC_API_URL=${this.settings.musicApiUrl || 'http://localhost:30060'}`,
            `MUSIC_API_SECRET=${this.settings.musicApiSecret || 'highrise_music_secret_2026'}`
        ].join('\n');
        fs.writeFileSync(envPath, envContent, 'utf-8');

        const rental = {
            rentalId,
            customerId,
            customerUsername: customerUsername || 'User_' + customerId.slice(0, 6),
            ownerUsername: resolvedOwner,
            botType,
            roomId: cleanRoom,
            token: cleanToken.slice(0, 8) + '...',
            fullToken: cleanToken,
            isHostedToken: Boolean(poolEntry),
            tokenPoolId: poolEntry ? poolEntry.id : null,
            tokenLabel: poolEntry ? poolEntry.label : null,
            startedAt: null,
            expiresAt: null,
            durationDays: Number(durationDays) || 7,
            customPrefix: prefix,
            tenantDir,
            status: 'pending_activation',
            requestedAt: Date.now(),
            pid: null
        };

        this.rentals.set(rentalId, rental);
        this._saveRentals();
        this.emit('rental_queued', rental);
        console.log(`[FleetManager] ⏳ Queued ${botType} rental for ${rental.customerUsername} (Rental ID: ${rentalId})`);
        return rental;
    }

    // Activates a pending or inactive rental, starting the clock and verifying connection
    async activateRental(targetKey) {
        let rental = this.rentals.get(targetKey);
        if (!rental) {
            for (const r of this.rentals.values()) {
                if (r.customerId === targetKey || r.rentalId === targetKey || r.roomId === targetKey) {
                    rental = r;
                    break;
                }
            }
        }

        if (!rental) {
            throw new Error(`Rental not found for key: ${targetKey}`);
        }

        const rentalId = rental.rentalId;

        // If an instance is already running, terminate it first
        if (this.activeProcesses.has(rentalId)) {
            this.terminateRental(rentalId, 'reactivating');
        }

        const now = Date.now();
        rental.startedAt = now;
        rental.lastBilledAt = now; // Wallet model: track last billing timestamp
        rental.warningsSent = 0;
        rental.lastWarningAt = null;
        rental.graceStartedAt = null;
        rental.status = 'active';

        // Spawn process
        const child = this._spawnProcess(rental);

        return new Promise((resolve, reject) => {
            let settled = false;
            let outputBuffer = '';

            const cleanupListeners = () => {
                clearTimeout(timeoutId);
                child.stdout.removeListener('data', onData);
                child.stderr.removeListener('data', onData);
                child.removeListener('exit', onExit);
            };

            const failAndCleanup = (errMessage) => {
                if (settled) return;
                settled = true;
                cleanupListeners();
                rental.status = 'pending_activation';
                rental.startedAt = null;
                rental.lastBilledAt = null;
                rental.warningsSent = 0;
                this.terminateRental(rentalId, 'handshake_failed');
                this._saveRentals();
                reject(new Error(errMessage));
            };

            const succeedAndSave = () => {
                if (settled) return;
                settled = true;
                cleanupListeners();
                this._saveRentals();
                this.emit('rental_activated', rental);
                console.log(`[FleetManager] ✅ Live handshake verified for ${rental.customerUsername} (${rental.roomId})! PID: ${child.pid}`);
                resolve({ success: true, rental });
            };

            const checkOutput = (text) => {
                const lower = text.toLowerCase();

                // 1. Check for immediate room permission or token rejections
                if (lower.includes('designer rights') || lower.includes('must have designer rights')) {
                    return failAndCleanup(`Missing Designer Rights: Highrise rejected this bot from entering room "${rental.roomId}". In Highrise, bots must be granted Designer rights in Room Settings -> Roles to enter!`);
                }
                if (lower.includes('api token not found') || lower.includes('401')) {
                    return failAndCleanup('Highrise rejected this API token ("API token not found"). Please verify token at create.highrise.game!');
                }
                if (lower.includes('invalid room id') || lower.includes('room not found')) {
                    return failAndCleanup(`Highrise room "${rental.roomId}" does not exist.`);
                }

                // 2. Only consider verified when the bot has ACTUALLY joined the room (Ready event fired)
                if (
                    lower.includes('online in') ||
                    lower.includes('bot user id:') ||
                    lower.includes('resilientrunner connected') ||
                    lower.includes('runner connected to room')
                ) {
                    succeedAndSave();
                }
            };

            const onData = (chunk) => {
                const text = chunk.toString();
                outputBuffer += text;
                checkOutput(outputBuffer);
            };

            const onExit = (code) => {
                if (settled) return;
                if (outputBuffer.includes('API token not found') || outputBuffer.includes('401')) {
                    return failAndCleanup('Highrise rejected this API token ("API token not found"). Please verify token at create.highrise.game!');
                }
                if (outputBuffer.includes('designer rights')) {
                    return failAndCleanup(`The bot is missing Designer rights in room "${rental.roomId}". Please grant Designer rights in Highrise room settings!`);
                }
                if (outputBuffer.includes('Invalid room id') || outputBuffer.includes('Room not found')) {
                    return failAndCleanup(`Highrise room "${rental.roomId}" does not exist.`);
                }

                const errLines = outputBuffer.split('\n')
                    .map(l => l.trim())
                    .filter(l => l.includes('[ERROR]') || l.includes('Error:') || l.includes('[WARN]'));
                const detail = errLines.length > 0 ? errLines[errLines.length - 1] : `Bot process exited immediately (Code: ${code})`;
                failAndCleanup(`Connection rejected by Highrise: ${detail}`);
            };

            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            child.once('exit', onExit);

            const timeoutId = setTimeout(() => {
                if (settled) return;
                if (this.activeProcesses.has(rentalId)) {
                    succeedAndSave();
                } else {
                    failAndCleanup('Highrise connection timed out. Please verify your token and room Designer rights.');
                }
            }, 10000);
        });
    }

    // Cluster-Aware Deployment: delegates to the best worker node or deploys locally
    async deployRental({ customerId, customerUsername, botType = 'emote', roomId, token, durationDays = 7, ownerUsername, customPrefix, forceActivate = false, targetNodeId = null, isRemoteDeploy = false }) {
        // 1. If executing ON a worker node (isRemoteDeploy === true) OR nodeManager disabled: deploy locally
        // 1. If executing locally on worker node
        if (isRemoteDeploy) {
            return await this._deployLocal({ customerId, customerUsername, botType, roomId, token, durationDays, ownerUsername, customPrefix, forceActivate });
        }

        // 1.1 Over-The-Air CEO Dispatch: If running as CEO and remote managers are connected, ship to best manager
        if (this.ceoHub) {
            const bestManager = this.ceoHub.selectBestManager(botType);
            if (bestManager) {
                console.log(`[FleetManager] 👑 [CEO Dispatch] Shipping ${botType} bot for @${customerUsername || customerId} over-the-air to Manager "${bestManager.name}" [${bestManager.nodeId}]...`);
                let cleanToken = (token || '').trim();
                let poolEntry = null;
                if (!cleanToken || cleanToken.toUpperCase() === 'AUTO' || cleanToken.toUpperCase() === 'HOSTED') {
                    poolEntry = this.checkoutTokenFromPool({ botType, customerId, roomId: roomId.trim().toLowerCase() });
                    cleanToken = poolEntry.token;
                }
                try {
                    const remoteResult = await this.ceoHub.deployBot(bestManager.nodeId, {
                        customerId, customerUsername, botType, roomId, token: cleanToken, durationDays, ownerUsername, customPrefix, forceActivate: true
                    });
                    const finalRental = remoteResult?.rental || (remoteResult?.success && remoteResult);
                    if (finalRental) {
                        const rec = typeof finalRental === 'object' ? { ...finalRental } : {};
                        rec.nodeId = bestManager.nodeId;
                        rec.nodeName = bestManager.name;
                        const tokenSuffix = poolEntry ? poolEntry.id : (cleanToken ? cleanToken.slice(-8).toLowerCase() : 'def');
                        const key = rec.rentalId || `${customerId}_${cleanRoom}_${botType}_${tokenSuffix}`;
                        rec.rentalId = key;
                        this.rentals.set(key, rec);
                        this._saveRentals();
                        console.log(`[FleetManager] ✅ [CEO Dispatch] Bot successfully confirmed & deployed on Manager "${bestManager.name}" [${bestManager.nodeId}]! Master local spawn avoided.`);
                        return rec;
                    }
                } catch (otaErr) {
                    console.warn(`⚠️ [CEO Dispatch] OTA shipment to Manager "${bestManager.name}" failed (${otaErr.message}). Falling back to local/cluster...`);
                }
            }
        }

        if (!this.nodeManager) {
            return await this._deployLocal({ customerId, customerUsername, botType, roomId, token, durationDays, ownerUsername, customPrefix, forceActivate });
        }

        // 2. Select target cluster node based on botType and capacity
        let targetNode = null;
        if (targetNodeId) {
            targetNode = this.nodeManager.nodes.get(targetNodeId);
        }
        if (!targetNode) {
            targetNode = this.nodeManager.selectBestNode(botType);
        }

        // If target node is local, deploy directly on this server
        if (targetNode.isLocal) {
            const rental = await this._deployLocal({ customerId, customerUsername, botType, roomId, token, durationDays, ownerUsername, customPrefix, forceActivate });
            rental.nodeId = 'local';
            rental.nodeName = targetNode.name || 'Master Server (Local)';
            rental.nodeUrl = 'local';
            this._saveRentals();
            return rental;
        }

        // 3. Remote Node: Dispatch over HTTP to the remote worker server
        console.log(`[FleetManager] \x1b[36m[Cluster]\x1b[0m 🚀 Delegating ${botType} bot for @${customerUsername || customerId} to remote node "${targetNode.name}" (${targetNode.url})...`);

        let cleanToken = (token || '').trim();
        let poolEntry = null;
        if (!cleanToken || cleanToken.toUpperCase() === 'AUTO' || cleanToken.toUpperCase() === 'HOSTED') {
            poolEntry = this.checkoutTokenFromPool({ botType, customerId, roomId: roomId.trim().toLowerCase() });
            cleanToken = poolEntry.token;
        }

        const remoteRes = await this.nodeManager.deployToNode(targetNode.url, {
            customerId,
            customerUsername,
            botType,
            roomId: roomId.trim().toLowerCase(),
            token: cleanToken,
            durationDays: Number(durationDays) || 7,
            ownerUsername,
            customPrefix,
            forceActivate: true,
            isRemoteDeploy: true
        });

        const tokenSuffix = poolEntry ? poolEntry.id : (cleanToken ? cleanToken.slice(-8).toLowerCase() : 'def');
        const rentalId = `${customerId}_${roomId.trim().toLowerCase()}_${botType}_${tokenSuffix}`;
        const resolvedOwner = (ownerUsername || customerUsername || customerId).replace(/^@/, '').trim().toLowerCase();

        const rentalRecord = {
            rentalId,
            customerId,
            customerUsername: customerUsername || 'User_' + customerId.slice(0, 6),
            ownerUsername: resolvedOwner,
            botType,
            roomId: roomId.trim().toLowerCase(),
            token: cleanToken.slice(0, 8) + '...',
            fullToken: cleanToken,
            isHostedToken: Boolean(poolEntry),
            tokenPoolId: poolEntry ? poolEntry.id : null,
            tokenLabel: poolEntry ? poolEntry.label : null,
            startedAt: Date.now(),
            lastBilledAt: Date.now(),
            durationDays: Number(durationDays) || 7,
            customPrefix: customPrefix || (botType === 'music' ? '/' : '!'),
            status: 'active',
            nodeId: targetNode.id,
            nodeName: targetNode.name,
            nodeUrl: targetNode.url,
            remotePid: remoteRes.rental ? remoteRes.rental.pid : null,
            requestedAt: Date.now()
        };

        this.rentals.set(rentalId, rentalRecord);
        this._saveRentals();
        this.emit('rental_deployed', rentalRecord);
        console.log(`[FleetManager] \x1b[32m[Cluster]\x1b[0m ✅ Remote deploy confirmed on "${targetNode.name}" for @${rentalRecord.customerUsername} (Room: ${rentalRecord.roomId})`);
        return rentalRecord;
    }

    async _deployLocal({ customerId, customerUsername, botType = 'emote', roomId, token, durationDays = 7, ownerUsername, customPrefix, forceActivate = false }) {
        if (botType === 'music' && !this.settings.autoActivateMusic && !forceActivate) {
            const queued = this.queueRental({
                customerId,
                customerUsername,
                botType,
                roomId,
                token,
                durationDays,
                ownerUsername,
                customPrefix
            });
            queued.nodeId = 'local';
            queued.nodeName = 'Master Server (Local)';
            queued.nodeUrl = 'local';
            this._saveRentals();
            return { queued: true, rental: queued };
        }

        const queued = this.queueRental({
            customerId,
            customerUsername,
            botType,
            roomId,
            token,
            durationDays,
            ownerUsername,
            customPrefix
        });
        queued.nodeId = 'local';
        queued.nodeName = 'Master Server (Local)';
        queued.nodeUrl = 'local';
        this._saveRentals();

        const activation = await this.activateRental(queued.rentalId);
        return activation.rental;
    }

    _spawnProcess(rental) {
        const { rentalId, customerId, botType, tenantDir } = rental;
        const envPath = path.join(tenantDir, '.env');
        const logPath = path.join(tenantDir, 'output.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });

        logStream.write(`\n--- Bot Instance Spawned at ${new Date().toISOString()} ---\n`);

        const spawnTime = Date.now();
        let child;

        if (botType === 'emote') {
            const pakbotNodeModules = path.join(this.pakbotPath, 'node_modules');
            const baseNodeModules = path.join(this.baseDir, 'node_modules');
            const nodePathEntries = [pakbotNodeModules, baseNodeModules]
                .filter(dir => {
                    try { return fs.existsSync(dir); } catch (_) { return false; }
                });

            const nodePath = nodePathEntries.length > 0
                ? nodePathEntries.join(path.delimiter)
                : pakbotNodeModules;

            child = spawn(process.execPath, ['index.js'], {
                cwd: this.pakbotPath,
                env: {
                    ...process.env,
                    DOTENV_CONFIG_PATH: envPath,
                    NODE_PATH: nodePath
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } else if (botType === 'music') {
            const pythonBin = PythonRuntime.getPythonBinary(this.baseDir);
            const localPythonDir = path.join(this.baseDir, 'python');
            const localBinDir = path.join(localPythonDir, 'bin');

            const customPath = fs.existsSync(localBinDir)
                ? `${localBinDir}${path.delimiter}${process.env.PATH || ''}`
                : process.env.PATH;

            const tenantEnv = {
                ...process.env,
                PATH: customPath,
                PYTHONUNBUFFERED: '1',
                ROOM_ID: rental.roomId,
                API_TOKEN: rental.fullToken,
                BOT_TOKEN: rental.fullToken,
                HIGHRISE_API_TOKEN: rental.fullToken,
                HIGHRISE_ROOM_ID: rental.roomId,
                BOT_PREFIX: rental.customPrefix || '/',
                MUSIC_API_URL: rental.musicApiUrl || this.settings.musicApiUrl || 'http://localhost:30060',
                MUSIC_API_SECRET: this.settings.musicApiSecret || 'highrise_music_secret_2026'
            };

            const pyArgs = [
                'main.py',
                '--room', rental.roomId,
                '--token', rental.fullToken,
                '--prefix', rental.customPrefix || '/'
            ];
            if (rental.musicApiUrl) {
                pyArgs.push('--music-url', rental.musicApiUrl);
            }

            child = spawn(pythonBin, pyArgs, {
                cwd: this.musicbotPath,
                env: tenantEnv,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } else {
            throw new Error(`Unsupported botType: ${botType}`);
        }

        rental.pid = child.pid;

        child.stdout.on('data', (chunk) => {
            logStream.write(chunk);
        });

        child.stderr.on('data', (chunk) => {
            logStream.write(chunk);
        });

        child.on('exit', (code, signal) => {
            const runtimeMs = Date.now() - spawnTime;
            console.log(`[FleetManager] Bot for ${rental.customerUsername} exited (Code: ${code}, Signal: ${signal}, Runtime: ${(runtimeMs / 1000).toFixed(1)}s)`);
            this.activeProcesses.delete(rentalId);
            rental.pid = null;

            // Auto-recovery with exponential backoff if active and not manually stopped
            if (rental.status === 'active' && this.rentals.has(rentalId)) {
                const tracker = this.crashTracker.get(rentalId) || { count: 0, firstCrash: Date.now() };
                const oneHour = 60 * 60 * 1000;
                if (Date.now() - tracker.firstCrash > oneHour) {
                    tracker.count = 0;
                    tracker.firstCrash = Date.now();
                }

                tracker.count++;
                this.crashTracker.set(rentalId, tracker);

                if (tracker.count > 5) {
                    console.error(`[FleetManager] 🛑 Circuit Breaker tripped for ${rental.customerUsername} (${rentalId})! Exceeded 5 crashes within 1 hour.`);
                    rental.status = 'circuit_broken';
                    this._saveRentals();
                    this.emit('circuit_breaker', rental);
                    return;
                }

                const delaySec = Math.min(60, Math.pow(2, tracker.count));
                console.log(`[FleetManager] Auto-restarting bot for ${rental.customerUsername} in ${delaySec}s (Crash #${tracker.count}/5)...`);
                setTimeout(() => {
                    if (rental.status === 'active' && !this.activeProcesses.has(rentalId)) {
                        this._spawnProcess(rental);
                    }
                }, delaySec * 1000);
            }
        });

        child.on('error', (err) => {
            console.error(`[FleetManager] Process spawn error for ${rentalId}:`, err.message);
            logStream.write(`[CRITICAL SPAWN ERROR] ${err.message}\n`);
        });

        this.activeProcesses.set(rentalId, { child, logStream });
        console.log(`[FleetManager] 🚀 Spawned ${botType} bot for ${rental.customerUsername} in room ${rental.roomId} (PID: ${child.pid})`);
        return child;
    }

    // Transition a rental to grace period (wallet empty, warnings exhausted)
    gracePeriodRental(rentalId) {
        const rental = this.rentals.get(rentalId);
        if (!rental) return false;

        // Terminate the running process
        const active = this.activeProcesses.get(rentalId);
        if (active && active.child) {
            try { active.child.kill('SIGINT'); } catch (e) {}
            this.activeProcesses.delete(rentalId);
        }

        rental.status = 'grace';
        rental.graceStartedAt = Date.now();
        rental.pid = null;
        this._saveRentals();
        this.emit('grace_started', rental);
        console.log(`[FleetManager] Rental for ${rental.customerUsername} (${rental.roomId}) entered 7-day grace period.`);
        return rental;
    }

    // Reactivate a grace period rental (user topped up)
    reactivateRental(rentalId) {
        const rental = this.rentals.get(rentalId);
        if (!rental) return false;

        rental.status = 'active';
        rental.lastBilledAt = Date.now();
        rental.warningsSent = 0;
        rental.lastWarningAt = null;
        rental.graceStartedAt = null;
        this._spawnProcess(rental);
        this._saveRentals();
        this.emit('rental_reactivated', rental);
        console.log(`[FleetManager] Reactivated rental for ${rental.customerUsername} (${rental.roomId}) after top-up!`);
        return rental;
    }


    async setMusicServer(targetKey, musicApiUrl) {
        let rental = this.rentals.get(targetKey);
        if (!rental) {
            for (const r of this.rentals.values()) {
                if (r.rentalId === targetKey || r.roomId === targetKey || r.customerId === targetKey || r.customerUsername === targetKey) {
                    rental = r;
                    break;
                }
            }
        }
        if (!rental) {
            throw new Error(`Rental not found for key: "${targetKey}"`);
        }

        rental.musicApiUrl = musicApiUrl;
        this._saveRentals();

        // If hosted on a remote cluster worker node, forward command via CeoHub
        if (rental.nodeId && rental.nodeId !== 'local' && this.ceoHub) {
            console.log(`[FleetManager] 🌐 Forwarding UPDATE_MUSIC_SERVER to Manager [${rental.nodeId}] for bot "${rental.rentalId}"...`);
            await this.ceoHub.updateMusicServer(rental.nodeId, rental.rentalId, musicApiUrl);
            return rental;
        }

        // If local instance: update tenant .env and restart local process
        if (rental.tenantDir && fs.existsSync(rental.tenantDir)) {
            const envPath = path.join(rental.tenantDir, '.env');
            if (fs.existsSync(envPath)) {
                let envContent = fs.readFileSync(envPath, 'utf-8');
                if (envContent.includes('MUSIC_API_URL=')) {
                    envContent = envContent.replace(/MUSIC_API_URL=.*/, `MUSIC_API_URL=${musicApiUrl}`);
                } else {
                    envContent += `\nMUSIC_API_URL=${musicApiUrl}\n`;
                }
                fs.writeFileSync(envPath, envContent, 'utf-8');
            }
        }

        this.restartRental(rental.rentalId);
        return rental;
    }

    restartRental(targetKey) {
        let rental = this.rentals.get(targetKey);
        if (!rental) {
            for (const r of this.rentals.values()) {
                if (r.customerId === targetKey || r.rentalId === targetKey || r.roomId === targetKey) {
                    rental = r;
                    break;
                }
            }
        }

        if (!rental) {
            throw new Error(`Rental not found for key: ${targetKey}`);
        }

        // Forward restart to remote worker node if hosted remotely
        if (rental.nodeUrl && rental.nodeUrl !== 'local' && rental.nodeId && rental.nodeId !== 'local' && this.nodeManager) {
            this.nodeManager.restartOnNode(rental.nodeUrl, rental.rentalId);
            return { success: true, message: `Restart forwarded to remote server "${rental.nodeName || rental.nodeUrl}"`, rental };
        }

        const key = rental.rentalId;
        const active = this.activeProcesses.get(key);
        if (active && active.child) {
            try {
                active.child.kill('SIGINT');
            } catch (e) {}
            this.activeProcesses.delete(key);
        }

        setTimeout(() => {
            this._spawnProcess(rental);
        }, 1500);

        return { success: true, message: `Restarting bot for ${rental.customerUsername}`, rental };
    }

    terminateRental(targetKey, reason = 'terminated') {
        let rental = this.rentals.get(targetKey);
        let key = targetKey;

        if (!rental) {
            for (const [k, r] of this.rentals.entries()) {
                if (r.customerId === targetKey || r.roomId === targetKey || r.rentalId === targetKey) {
                    rental = r;
                    key = k;
                    break;
                }
            }
        }

        if (!rental) return false;

        // Forward termination to remote worker node if hosted remotely
        if (this.ceoHub) {
            for (const [nodeId, mgr] of this.ceoHub.managers.entries()) {
                this.ceoHub.terminateBot(nodeId, key, reason).catch(() => {});
            }
        } else if (rental.nodeUrl && rental.nodeUrl !== 'local' && rental.nodeId && rental.nodeId !== 'local' && this.nodeManager) {
            this.nodeManager.terminateOnNode(rental.nodeUrl, key, reason);
        }

        rental.status = reason;
        rental.stoppedAt = Date.now();

        const active = this.activeProcesses.get(key);
        if (active && active.child) {
            try {
                active.child.kill('SIGINT');
                setTimeout(() => {
                    try { active.child.kill('SIGKILL'); } catch (e) {}
                }, 3000);
            } catch (err) {
                console.error(`[FleetManager] Error stopping process for ${key}:`, err.message);
            }
            this.activeProcesses.delete(key);
        }

        if (rental.tokenPoolId || rental.fullToken) {
            this.releaseTokenToPool(rental.tokenPoolId || rental.fullToken);
        }
        this.crashTracker.delete(key);
        this._saveRentals();
        this.emit('terminated', { rentalId: key, reason });
        console.log(`[FleetManager] Terminated rental for ${rental.customerUsername} (Room: ${rental.roomId}, Reason: ${reason})`);
        return true;
    }

    deleteRental(targetKey, reason = 'deleted') {
        let rental = this.rentals.get(targetKey);
        let key = targetKey;

        if (!rental) {
            for (const [k, r] of this.rentals.entries()) {
                if (r.customerId === targetKey || r.roomId === targetKey || r.rentalId === targetKey) {
                    rental = r;
                    key = k;
                    break;
                }
            }
        }

        if (!rental) return false;

        // Forward deletion to remote worker node if hosted remotely
        if (this.ceoHub) {
            for (const [nodeId, mgr] of this.ceoHub.managers.entries()) {
                this.ceoHub.terminateBot(nodeId, key, reason).catch(() => {});
            }
        } else if (rental.nodeUrl && rental.nodeUrl !== 'local' && rental.nodeId && rental.nodeId !== 'local' && this.nodeManager) {
            this.nodeManager.deleteOnNode(rental.nodeUrl, key, reason);
        }

        // Mark status as deleted so exit handler will NOT auto-restart it
        rental.status = reason;
        rental.stoppedAt = Date.now();

        // 1. Terminate running process if active & close log stream
        const active = this.activeProcesses.get(key);
        if (active) {
            if (active.logStream) {
                try { active.logStream.end(); } catch (e) {}
            }
            if (active.child) {
                try {
                    active.child.kill('SIGINT');
                    setTimeout(() => {
                        try { active.child.kill('SIGKILL'); } catch (e) {}
                    }, 2000);
                } catch (err) {
                    console.error('[FleetManager] Error stopping process for ' + key + ':', err.message);
                }
            }
            this.activeProcesses.delete(key);
        }

        // 2. Release token back to pool if hosted
        if (rental.tokenPoolId || rental.fullToken) {
            this.releaseTokenToPool(rental.tokenPoolId || rental.fullToken);
        }

        // 3. Remove tenant directory from disk (with 1s delay for Windows process handle release)
        const tenantDir = rental.tenantDir;
        if (tenantDir) {
            setTimeout(() => {
                try {
                    if (fs.existsSync(tenantDir)) {
                        fs.rmSync(tenantDir, { recursive: true, force: true });
                        console.log('[FleetManager] Removed tenant directory: ' + tenantDir);
                    }
                } catch (err) {
                    console.error('[FleetManager] Error removing tenant directory for ' + key + ':', err.message);
                }
            }, 1000);
        }

        // 4. Remove from rentals Map and persist
        this.crashTracker.delete(key);
        this.rentals.delete(key);
        this._saveRentals();
        this.emit('deleted', { rentalId: key, reason });
        console.log('[FleetManager] 🗑️ Deleted rental for ' + rental.customerUsername + ' (Room: ' + rental.roomId + ', Reason: ' + reason + ')');
        return true;
    }

    deleteAllRentals(reason = 'deleted_all') {
        const rentalsList = Array.from(this.rentals.values());
        let count = 0;
        const deletedIds = [];

        for (const rental of rentalsList) {
            const key = rental.rentalId;
            const ok = this.deleteRental(key, reason);
            if (ok) {
                count++;
                deletedIds.push(key);
            }
        }

        console.log('[FleetManager] 🗑️ Deleted ALL ' + count + ' rentals across the fleet (Reason: ' + reason + ')');
        return { success: true, count, deletedIds };
    }

    terminateAllRentals(reason = 'admin_terminated_all') {
        let count = 0;
        const now = Date.now();

        for (const [key, active] of this.activeProcesses.entries()) {
            if (active && active.child) {
                try {
                    active.child.kill('SIGINT');
                    setTimeout(() => {
                        try { active.child.kill('SIGKILL'); } catch (e) {}
                    }, 2000);
                    count++;
                } catch (e) {}
            }
            const rental = this.rentals.get(key);
            if (rental) {
                rental.status = reason;
                rental.stoppedAt = now;
            }
        }
        this.activeProcesses.clear();
        this.crashTracker.clear();

        for (const rental of this.rentals.values()) {
            if (rental.status === 'active') {
                rental.status = reason;
                rental.stoppedAt = now;
            }
        }

        this._saveRentals();
        this.emit('all_terminated', { count, reason });
        console.log(`[FleetManager] 🛑 Terminated ALL active customer bots (${count} stopped, Reason: ${reason})`);
        return { success: true, terminatedCount: count };
    }

    extendRental(targetKey, additionalDays = 7) {
        let rental = this.rentals.get(targetKey);
        let key = targetKey;

        if (!rental) {
            for (const [k, r] of this.rentals.entries()) {
                if (r.customerId === targetKey || r.roomId === targetKey) {
                    rental = r;
                    key = k;
                    break;
                }
            }
        }

        if (!rental) {
            throw new Error(`Rental not found for key: ${targetKey}`);
        }

        const additionalMs = additionalDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        if (rental.status === 'pending_activation') {
            rental.durationDays += additionalDays;
        } else {
            if (rental.expiresAt < now) {
                rental.expiresAt = now + additionalMs;
            } else {
                rental.expiresAt += additionalMs;
            }
            rental.status = 'active';
            rental.durationDays += additionalDays;

            if (!this.activeProcesses.has(key)) {
                this._spawnProcess(rental);
            }
        }

        this._saveRentals();
        this.emit('extended', rental);
        return rental;
    }

    async getRentalLogs(targetKey, maxLines = 100) {
        let rental = this.rentals.get(targetKey);
        if (!rental) {
            for (const r of this.rentals.values()) {
                if (r.customerId === targetKey || r.rentalId === targetKey || r.roomId === targetKey) {
                    rental = r;
                    break;
                }
            }
        }

        if (!rental) return [];

        // Fetch logs from remote worker node if hosted remotely
        if (rental.nodeUrl && rental.nodeUrl !== 'local' && rental.nodeId && rental.nodeId !== 'local' && this.nodeManager) {
            return await this.nodeManager.getLogsFromNode(rental.nodeUrl, rental.rentalId, maxLines);
        }

        if (!rental.tenantDir) return [];
        const logPath = path.join(rental.tenantDir, 'output.log');
        if (!fs.existsSync(logPath)) return [];

        try {
            const raw = fs.readFileSync(logPath, 'utf-8');
            const lines = raw.split(/\r?\n/);
            return lines.slice(-maxLines);
        } catch (e) {
            return [`[Log Read Error] ${e.message}`];
        }
    }

    getPendingRentals() {
        return this.getRentals().filter(r => r.status === 'pending_activation');
    }

    getRentals() {
        const now = Date.now();
        return Array.from(this.rentals.values()).map(r => {
            const key = r.rentalId || `${r.customerId}_${r.roomId}` || r.customerId;
            const isRunning = this.activeProcesses.has(key);
            let msRemaining = 0;
            let daysRemaining = '0.0';

            if (r.status === 'pending_activation') {
                daysRemaining = `Queued`;
            } else if (r.status === 'grace') {
                const graceMs = r.graceStartedAt ? Math.max(0, (r.graceStartedAt + 7 * 24 * 60 * 60 * 1000) - now) : 0;
                daysRemaining = `Grace: ${(graceMs / (24 * 60 * 60 * 1000)).toFixed(1)}d left`;
            } else if (r.status === 'active') {
                const balance = this.getBalance(r.customerId);
                const estDays = Math.floor(balance / this.goldPerDay);
                daysRemaining = `${estDays}d (~${balance}g)`;
            }

            const isRemote = Boolean(r.nodeId && r.nodeId !== 'local');
            const runningStatus = isRemote ? (r.status === 'active') : isRunning;

            return {
                ...r,
                rentalId: key,
                nodeId: r.nodeId || 'local',
                nodeName: r.nodeName || (isRemote ? r.nodeId : 'Master Server (Local)'),
                nodeUrl: r.nodeUrl || 'local',
                isRunning: runningStatus,
                msRemaining,
                daysRemaining
            };
        });
    }

    getRental(targetKey) {
        const rentals = this.getRentals();
        return rentals.find(r => r.rentalId === targetKey || r.customerId === targetKey || r.roomId === targetKey) || null;
    }
}

module.exports = FleetManager;
