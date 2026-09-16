const fs = require('fs');
const path = require('path');
const MasterPositionManager = require('./MasterPositionManager');
const MasterOutfitManager = require('./MasterOutfitManager');

// Fallback console logger when highrise.bot is not installed or available
class FallbackLogger {
    constructor(prefix = 'MasterBot', level = 'debug') {
        this.prefix = prefix;
        this.level = level;
    }
    info(tag, msg) { console.log(`[INFO] [${this.prefix}] [${tag}] ${msg}`); }
    warn(tag, msg) { console.warn(`[WARN] [${this.prefix}] [${tag}] ${msg}`); }
    error(tag, msg) { console.error(`[ERROR] [${this.prefix}] [${tag}] ${msg}`); }
    debug(tag, msg) { console.debug(`[DEBUG] [${this.prefix}] [${tag}] ${msg}`); }
}

// Try requiring highrise.bot locally, bundled pakbotgem, or relative sibling
let Highrise, Logger;
try {
    const hr = require('highrise.bot');
    Highrise = hr.Highrise;
    Logger = hr.Logger;
} catch (loadErr) {
    const candidates = [
        path.resolve(__dirname, '..', 'node_modules', 'highrise.bot'),
        path.resolve(__dirname, '..', 'pakbotgem', 'node_modules', 'highrise.bot'),
        path.resolve(__dirname, '..', '..', 'node_modules', 'highrise.bot'),
        path.resolve(__dirname, '..', '..', 'pakbotgem', 'node_modules', 'highrise.bot'),
        path.resolve(process.cwd(), 'node_modules', 'highrise.bot'),
        path.resolve(process.cwd(), 'bot-fleet-manager', 'node_modules', 'highrise.bot'),
        path.resolve(process.cwd(), 'pakbotgem', 'node_modules', 'highrise.bot'),
        'c:/Users/sanif/OneDrive/Desktop/pakbotgem/node_modules/highrise.bot'
    ];
    let loaded = false;
    for (const cand of candidates) {
        try {
            if (fs.existsSync(cand)) {
                const hr = require(cand);
                Highrise = hr.Highrise;
                Logger = hr.Logger;
                loaded = true;
                break;
            }
        } catch (_) {}
    }
    if (!loaded) {
        console.warn(`[MasterBot] Notice: highrise.bot not pre-loaded (${loadErr.message}). In-game cashier bot will be inactive until package is installed.`);
    }
}

// Ensure Logger is always a valid constructor
if (typeof Logger !== 'function') {
    Logger = FallbackLogger;
}

class MasterBot {
    constructor(fleetManager, options = {}) {
        this.fleetManager = fleetManager;
        this.token = options.token || process.env.MASTER_BOT_TOKEN;
        this.roomId = options.roomId || process.env.MASTER_ROOM_ID;
        this.owners = (options.owners || process.env.MASTER_OWNERS || 'accountrecovery,6a7adddacc3fa67f5530833c')
            .split(',')
            .map(s => s.trim().toLowerCase());
        
        // Wallet model: use FleetManager's shared credit system (25g/day)
        this.prefix = options.prefix || process.env.MASTER_PREFIX || '//';
        this.dmSessions = new Map(); // userId -> { state, botType, roomId, token, ownerUsername }
        this.bot = null;
        this.botId = null;
        this.log = new Logger('MasterBot', 'debug');
        this.positionManager = new MasterPositionManager({ baseDir: path.resolve(__dirname, '..') });
        this.outfitManager = new MasterOutfitManager({ baseDir: path.resolve(__dirname, '..') });
    }

    // Wallet model helper: delegate to FleetManager's shared credit system
    get goldPerDay() { return this.fleetManager.goldPerDay; }
    get credits() { return this.fleetManager.credits; }

    init() {
        // Credits are loaded by FleetManager (shared wallet model)

        if (!this.token || !this.roomId || this.token === 'your_master_token_here') {
            this.log.warn('MasterBot', 'No MASTER_BOT_TOKEN / MASTER_ROOM_ID configured. In-game cashier bot disabled. (Fleet Manager REST API is still fully operational!)');
            return false;
        }

        if (typeof Highrise !== 'function') {
            this.log.error('MasterBot', 'Cannot connect MasterBot: "highrise.bot" package is not installed on this server. Run "npm install highrise.bot" in bot-fleet-manager to enable the in-game cashier bot. (Fleet Manager REST API is operational)');
            return false;
        }

        this.bot = new Highrise();
        this._registerEvents();
        this._registerFleetEvents();
        this.bot.login(this.token, this.roomId);
        console.log(`[MasterBot] Connecting to showroom room ${this.roomId}...`);

        // Auto-revoke expired 2-hour bot reservations every 30 seconds
        this.reservationWatchdog = setInterval(() => this._checkExpiredReservations(), 30000);
        return true;
    }

    _checkExpiredReservations() {
        const now = Date.now();
        for (const [userId, session] of this.dmSessions.entries()) {
            if (session.state === 'awaiting_designer_confirmation' && session.reservationExpiresAt && now > session.reservationExpiresAt) {
                if (session.tokenPoolId) {
                    this.fleetManager.releaseTokenToPool(session.tokenPoolId);
                    console.log(`[MasterBot] ⌛ Auto-revoked reservation for @${session.ownerUsername || userId} (2 hours elapsed without Designer activation)`);
                }
                try {
                    const botName = (session.tokenLabel || 'ALPHA').replace(/^@/, '');
                    if (this.bot && session.conversationId) {
                        this.bot.direct.send(session.conversationId, `⌛ RESERVATION EXPIRED: Your 2-hour window to grant Designer rights for @${botName} has expired. The bot has been returned to the fleet inventory. You can rent again anytime by typing "rent"!`).catch(() => {});
                    }
                } catch (e) {}
                this.dmSessions.delete(userId);
            }
        }
    }

    // Wallet model: Credits are managed by FleetManager (shared state)
    _saveCredits() { this.fleetManager.saveCredits(); }


    _loadUserConversations() {
        try {
            if (fs.existsSync(this.userConvFile)) {
                return JSON.parse(fs.readFileSync(this.userConvFile, 'utf-8'));
            }
        } catch (e) {}
        return {};
    }

    _saveUserConversations() {
        try {
            fs.writeFileSync(this.userConvFile, JSON.stringify(this.userConversations, null, 2), 'utf-8');
        } catch (e) {}
    }

    async notifyAdmin(msg) {
        const adminId = '6a7adddacc3fa67f5530833c'; // @_paul_sanif_
        let sent = false;
        const convId = this.userConversations[adminId] || this.userConversations['_paul_sanif_'] || this.userConversations['paul_sanif'];
        if (convId && this.bot?.direct) {
            try {
                await this.bot.direct.send(convId, msg);
                sent = true;
            } catch (e) {
                this.log.warn('Direct', `Could not DM admin via conversation: ${e.message}`);
            }
        }
        if (!sent && this.bot?.whisper) {
            try {
                await this.bot.whisper.send(adminId, msg);
                sent = true;
            } catch (e) {}
        }
        this.log.info('AdminAlert', `Admin Notification (Sent: ${sent}):\n${msg}`);
        return sent;
    }

    _isOwner(user) {
        if (!user) return false;
        const u = (user.username || '').toLowerCase().trim();
        const id = (user.id || '').toLowerCase().trim();
        return this.owners.includes(u) ||
               this.owners.includes(id) ||
               id === '6a7adddacc3fa67f5530833c' ||
               u === 'accountrecovery' ||
               u === 'sanif' ||
               u === 'paul_sanif' ||
               u.includes('sanif');
    }

    _canManageRental(user, rental) {
        if (!user || !rental) return false;
        if (this._isOwner(user)) return true;
        const userId = String(user.id || '').toLowerCase().trim();
        const username = String(user.username || '').toLowerCase().trim();

        const custId = String(rental.customerId || '').toLowerCase().trim();
        const custUser = String(rental.customerUsername || '').toLowerCase().trim();
        const ownerUser = String(rental.ownerUsername || '').toLowerCase().trim();

        return (userId && custId && userId === custId) ||
               (username && custUser && username === custUser) ||
               (username && ownerUser && username === ownerUser);
    }

    _getDaysAvailable(userId) {
        return this.fleetManager.getDaysAvailable(userId);
    }

    // Check if user is eligible for free trial (never deployed before + never used trial)
    _isTrialEligible(userId) {
        const credit = this.fleetManager.credits.get(userId);
        if (credit && credit.freeTrialUsed) return false;
        // Check if user has any rental history (active, grace, or terminated)
        const allRentals = this.fleetManager.getRentals();
        const hasRentals = allRentals.some(r => r.customerId === userId);
        return !hasRentals;
    }

    _markTrialUsed(userId, username) {
        const credit = this.fleetManager.credits.get(userId) || { username: username || userId, goldBalance: 0, totalTipped: 0 };
        credit.freeTrialUsed = true;
        credit.freeTrialAt = Date.now();
        if (username) credit.username = username;
        this.fleetManager.credits.set(userId, credit);
        this.fleetManager.saveCredits();
    }

    _getMainMenu(user) {
        const username = user.username || user.id || 'Player';
        const isOwner = this._isOwner(user);
        const gold = this.credits.get(user.id)?.goldBalance || 0;
        const days = this._getDaysAvailable(user.id);

        let menu = (
            `👑 MASTER BOT STORE & FLEET PORTAL 👑\n\n` +
            `Welcome @${username}! Choose an option by replying with a number:\n\n` +
            `[1] 🛒 Purchase / Rent a Bot\n` +
            `[2] 🤖 My Bots (Manage, Deactivate & Delete)\n` +
            `[3] 💰 Check Balance & Pricing\n` +
            `[4] 📖 Free Bot Token Guide\n\n` +
            `⭐ Your Balance: ${isOwner ? 'Unlimited (Super Owner)' : `${gold} Gold (${days} rental day${days === 1 ? '' : 's'})`}\n` +
            `\u{1F381} NEW? Your first bot comes with a FREE 1-hour trial!\n` +
            `💡 Tip: Reply with "1", "2", "3", or "4"`
        );

        if (isOwner) {
            menu += `\n\n👑 OWNER COMMANDS:\n` +
                    `• ${this.prefix}fleet - View fleet status\n` +
                    `• ${this.prefix}pending - View orders queue\n` +
                    `• ${this.prefix}activate <id> - Launch bot\n` +
                    `• ${this.prefix}killbot <id> - Stop bot\n` +
                    `• ${this.prefix}killall - Stop ALL bots\n` +
                    `• ${this.prefix}setbot me - Anchor bot post\n` +
                    `• ${this.prefix}clone @user - Copy outfit\n` +
                    `• Web Dashboard: http://localhost:3500`;
        }

        return menu;
    }

    _getBotTypeMenu() {
        return (
            `🤖 Choose Bot Type to Purchase:\n\n` +
            `[1] 🕺 Emote Bot (PakBot) - 🟢 AVAILABLE NOW\n` +
            `    • 122+ Highrise emotes & emote looper\n` +
            `    • Auto-dance floors & reaction triggers\n` +
            `    • In-room VIP & moderation tools\n` +
            `    • Pricing: ${this.goldPerDay} Gold/Day (Prepaid Wallet)\n\n` +
            `[2] 🎵 Music DJ Bot - 🟢 AVAILABLE NOW
    • 24/7 in-room audio streaming & YouTube queue
    • Commands: /play, /queue, /skip, /np, /volume
    • Status: On-Demand Dedicated Audio Server
    • Pricing: ${this.goldPerDay} Gold/Day (Prepaid Wallet)

👉 Reply with "1" for Emote Bot or "2" for Music DJ Bot (or "cancel" to exit).`
        );
    }

    _registerFleetEvents() {
        // Wire Watchdog billing warnings to Master Bot DM system
        if (this.fleetManager.watchdog) {
            this.fleetManager.watchdog.setWarningCallback(async (userId, type, message) => {
                if (!this.bot) return;
                const prefix = type === 'reactivated' ? '\u{2705}' : 
                               type === 'deactivated' ? '\u{1F534}' : 
                               type === 'deleted' ? '\u{274C}' : '\u{26A0}';
                try {
                    await this.bot.whisper.send(userId, `${prefix} ${message}`);
                } catch (e) {
                    console.error(`[MasterBot] Failed to send ${type} warning DM to ${userId}:`, e.message);
                }
            });
        }

        // When a bot trips the circuit breaker due to repeated crashes (invalid token)
        this.fleetManager.on('circuit_breaker', async (rental) => {
            this.log.warn('CircuitBreaker', `Bot for @${rental.customerUsername} in room ${rental.roomId} failed.`);
            // If the Master Bot is online, try to whisper/DM alert the customer
            try {
                await this.bot.whisper.send(
                    rental.customerId,
                    `⚠️ Alert: Your rented bot in room ${rental.roomId} could not connect (Invalid API token or missing room Designer rights). Please verify your token and redeploy!`
                );
            } catch (e) {}
        });
    }

    _registerEvents() {
        const bot = this.bot;

        bot.on('Ready', (meta) => {
            this.botId = meta.botId;
            this.log.info('MasterBot', `👑 Master Cashier Bot online in ${meta.room?.roomName || 'Showroom'} (ID: ${meta.botId})`);
            try {
                bot.message.send('👑 Master Bot is online! Tip Gold to rent your own 24/7 Emote Bot. Whisper or DM "menu" for info.');
            } catch (e) {}

            // Auto-dock Master Bot at saved showroom home position
            setTimeout(async () => {
                const home = this.positionManager.getHomePosition();
                if (home) {
                    await this.positionManager.ensureHomePosition(bot);
                    this.log.info('Position', `📍 Master Bot docked at home anchor (${home.x}, ${home.y}, ${home.z}) facing ${home.facing}`);
                }
                this.positionManager.startAnchorGuardian(bot, 5000);
            }, 2000);
        });

        // Track player movements in showroom for real-time positioning
        bot.on('Movement', (user, position) => {
            if (!user || user.id === this.botId) return;
            this.positionManager.updateUserPosition(user.id, position);
        });

        // Tip Event (Security Patched)
        bot.on('Tip', async (sender, receiver, currency) => {
            if (!sender || !currency || receiver?.id !== this.botId) return;

            // 🛡️ SECURITY FIX #1: Strictly verify that currency is GOLD (block bubbles / event currencies)
            const currencyType = String(currency.type || '').toLowerCase();
            if (currencyType && currencyType !== 'gold') {
                this.log.warn('Tip', `Ignored non-gold tip (${currencyType}) from @${sender.username || sender.id}`);
                return;
            }

            // 🛡️ SECURITY FIX #2: Integer validation on amount
            const amount = Math.floor(Number(currency.amount) || 0);
            if (amount <= 0) return;

            // Wallet model: Add gold via FleetManager's shared credit system
            const prev = this.fleetManager.addBalance(sender.id, amount, sender.username || sender.id);

            const daysEarned = Math.floor(prev.goldBalance / this.goldPerDay);
            this.log.info('Tip', `💰 @${sender.username || sender.id} tipped ${amount}g -> Balance: ${prev.goldBalance}g (~${daysEarned} days).`);

            try {
                await bot.whisper.send(
                    sender.id,
                    `✨ Thank you for tipping ${amount} Gold! Your Balance: ${prev.goldBalance} Gold (${daysEarned} day(s) of bot time).\n\n` +
                    `To deploy your bot, DM me "menu" or "rent"!`
                );
            } catch (e) {}
        });

        // Universal Command & Conversation Dispatcher
        const is24Hex = (str) => /^[0-9a-fA-F]{24}$/.test(String(str || '').trim());
        const is64Hex = (str) => /^[0-9a-fA-F]{64}$/.test(String(str || '').trim());

        const handleCommand = async (user, rawMessage, channel = 'chat', conversation = null) => {
            let text = (typeof rawMessage === 'string' ? rawMessage : (rawMessage?.content || '')).trim();
            if (!text) return;

            // In room chat, require configured prefix (default: '//')
            if (channel === 'chat') {
                if (text.startsWith(this.prefix)) {
                    text = text.slice(this.prefix.length).trim();
                } else if (text.startsWith('//')) {
                    text = text.slice(2).trim();
                } else if (text.startsWith('!')) {
                    text = text.slice(1).trim();
                } else {
                    return;
                }
            } else {
                // In DMs/whispers, allow with prefix or without
                if (text.startsWith(this.prefix)) {
                    text = text.slice(this.prefix.length).trim();
                } else if (text.startsWith('//')) {
                    text = text.slice(2).trim();
                } else if (text.startsWith('!')) {
                    text = text.slice(1).trim();
                } else if (text.startsWith('/')) {
                    text = text.slice(1).trim();
                }
            }

            const parts = text.split(/\s+/);
            const cmd = parts[0].toLowerCase();
            const args = parts.slice(1);

            const reply = async (msg) => {
                if (channel === 'dm' && conversation?.id) {
                    try {
                        await bot.direct.send(conversation.id, msg);
                    } catch (e) {
                        this.log.warn('Direct', `Could not send DM response: ${e.message}`);
                    }
                } else if (channel === 'whisper') {
                    try {
                        await bot.whisper.send(user.id, msg);
                    } catch (e) {}
                } else {
                    try {
                        await bot.message.send(`@${user.username || user.id} ${msg}`);
                    } catch (e) {}
                }
            };

            // Global Cancel / Exit / Abort in DM (when actively in a setup wizard)
            if (channel === 'dm' && this.dmSessions.has(user.id) && (cmd === 'cancel' || cmd === 'abort' || cmd === 'exit' || cmd === 'stop')) {
                const session = this.dmSessions.get(user.id);
                if (session.tokenPoolId) {
                    this.fleetManager.releaseTokenToPool(session.tokenPoolId);
                }
                this.dmSessions.delete(user.id);
                return reply('❌ Cancelled active setup. Sending you back to the main menu:\n\n' + this._getMainMenu(user));
            }

            if (channel === 'dm' && !this.dmSessions.has(user.id) && (cmd === 'cancel' || cmd === 'abort')) {
                return reply('ℹ️ No active setup wizard is currently in progress. Reply "rent" to purchase a bot or "menu" for options.');
            }

            // Menu / Help / Start / Hi (always clears any stuck session)
            if (cmd === 'menu' || cmd === 'start' || cmd === 'help' || cmd === 'hi' || cmd === 'hello') {
                this.dmSessions.delete(user.id);
                return reply(this._getMainMenu(user));
            }

            // Single-line "rent" command (Supports both Hosted Fleet Bots and Custom Tokens)
            if ((cmd === '1' || cmd === 'purchase' || cmd === 'rent' || cmd === 'buy' || cmd === 'deploy') && args.length >= 1) {
                this.dmSessions.delete(user.id);

                let botType = 'emote';
                if (args[0].toLowerCase() === 'music' || args[0].toLowerCase() === 'dj') {
                    return reply(
                        `⏳ The 24/7 Music DJ Bot is COMING SOON!\n\n` +
                        `Our Emote Bot (PakBot) is fully active and ready to deploy.\n` +
                        `Use: ${this.prefix}rent <room_id> to deploy an Emote Bot!`
                    );
                } else if (args[0].toLowerCase() === 'emote' || args[0].toLowerCase() === 'pakbot') {
                    botType = 'emote';
                    args = args.slice(1);
                }

                let roomId = null;
                let token = null;
                let ownerUsername = (user.username || user.id);

                // Case 1: Only Room ID provided -> rent <room_id> (Auto-checkout from Fleet Pool)
                if (args.length === 1 && is24Hex(args[0])) {
                    roomId = args[0].toLowerCase();
                    token = 'AUTO';
                }
                // Case 2: Room ID + Owner provided (No token) -> rent <room_id> @owner
                else if (args.length === 2 && is24Hex(args[0]) && !is64Hex(args[1])) {
                    roomId = args[0].toLowerCase();
                    token = 'AUTO';
                    ownerUsername = args[1].replace(/^@/, '').trim().toLowerCase();
                }
                // Case 3: Standard credentials -> rent <room_id> <bot_token> [owner]
                else if (args.length >= 2 && is24Hex(args[0]) && is64Hex(args[1])) {
                    roomId = args[0].toLowerCase();
                    token = args[1];
                    if (args[2]) ownerUsername = args[2].replace(/^@/, '').trim().toLowerCase();
                }
                // Case 4: Swapped credentials -> rent <bot_token> <room_id> [owner]
                else if (args.length >= 2 && is64Hex(args[0]) && is24Hex(args[1])) {
                    roomId = args[1].toLowerCase();
                    token = args[0];
                    if (args[2]) ownerUsername = args[2].replace(/^@/, '').trim().toLowerCase();
                }
                else if (args.length > 0) {
                    let feedback = `⚠️ Could not parse your arguments for the "rent" command:\n\n` +
                                   `• Instant Hosted Bot: ${this.prefix}rent <room_id> [owner]\n` +
                                   `• Custom API Token: ${this.prefix}rent <room_id> <bot_token> [owner]\n` +
                                   `• Or type "${this.prefix}rent" by itself to use our step-by-step DM wizard!`;
                    return reply(feedback);
                }

                if (roomId) {
                    return this._executeDeploy(user, botType, roomId, token, ownerUsername, reply);
                }
            }

            // --- ACTIVE MULTI-STEP DM SESSION ---
            if (channel === 'dm' && this.dmSessions.has(user.id)) {
                const session = this.dmSessions.get(user.id);

                // Step: Selecting Bot Type
                if (session.state === 'choose_type') {
                    if (cmd === '1' || cmd === 'emote' || cmd === 'pakbot') {
                        session.botType = 'emote';
                        session.state = 'awaiting_room';
                        return reply(
                            `✅ Selected: Emote Bot (PakBot)\n\n` +
                            `📍 Step 1/3: Please reply with your target Highrise Room ID:\n` +
                            `• Room IDs are 24 characters (e.g. 6a9d3682ad5fa8805c7a2cc8)\n` +
                            `• You can find it in your Room Settings or room share URL.\n\n` +
                            `Type "cancel" at any time to exit.`
                        );
                    } else if (cmd === '2' || cmd === 'music' || cmd === 'dj') {
                        session.botType = 'music';
                        session.state = 'awaiting_room';
                        return reply(
                            `✅ Selected: 🎵 24/7 Music DJ Bot\n\n` +
                            `📍 Step 1/3: Please reply with your target Highrise Room ID:\n` +
                            `• Room IDs are 24 characters (e.g. 6a9d3682ad5fa8805c7a2cc8)\n` +
                            `• You can find it in your Room Settings or room share URL.\n\n` +
                            `Type "cancel" at any time to exit.`
                        );
                    } else {
                        return reply('⚠️ Please reply with "1" for Emote Bot or "2" for Music DJ Bot (or type "cancel" to return to menu).');
                    }
                }

                // Step: Awaiting Room ID
                if (session.state === 'awaiting_room') {
                    // Check if user pasted both Room ID and Token in one message
                    if (parts.length >= 2) {
                        const p0 = parts[0].trim();
                        const p1 = parts[1].trim();
                        if ((is24Hex(p0) && is64Hex(p1)) || (is64Hex(p0) && is24Hex(p1))) {
                            session.roomId = is24Hex(p0) ? p0.toLowerCase() : p1.toLowerCase();
                            session.token = is64Hex(p0) ? p0 : p1;
                            session.state = 'awaiting_owner';
                            return reply(
                                `✅ Detected both Room ID and Bot API Token!\n` +
                                `• Target Room: ${session.roomId}\n` +
                                `• Bot Token: ${session.token.slice(0, 8)}...${session.token.slice(-6)}\n\n` +
                                `👤 Step 3/3: What Highrise username should be registered as the bot owner?\n` +
                                `(The bot will recognize this user as its room owner and grant them full command permissions):\n` +
                                `Example: @${user.username || 'your_username'}`
                            );
                        }
                    }

                    const input = parts[0].trim();

                    // Check if user accidentally pasted their 64-char token here
                    if (input.length === 64 || is64Hex(input)) {
                        return reply(
                            `⚠️ That is a 64-character Bot API Token, not a Room ID!\n\n` +
                            `• Step 1 requires your 24-character Room ID (e.g. 6a9d3682ad5fa8805c7a2cc8).\n` +
                            `• You can get your Room ID from Highrise Room Settings or the room share link.\n` +
                            `• We will ask for your Bot API Token in Step 2.\n\n` +
                            `Please reply with your 24-character Room ID (or type "cancel"):`
                        );
                    }

                    // Check length
                    if (input.length !== 24) {
                        return reply(
                            `⚠️ Invalid Room ID length! Highrise Room IDs are exactly 24 hexadecimal characters.\n` +
                            `• You entered: ${input.length} characters ("${input.slice(0, 24)}${input.length > 24 ? '...' : ''}")\n` +
                            `• Example: 6a9d3682ad5fa8805c7a2cc8\n\n` +
                            `Please reply with your 24-character Room ID (or type "cancel"):`
                        );
                    }

                    // Check hex characters
                    if (!/^[0-9a-fA-F]{24}$/.test(input)) {
                        return reply(
                            `⚠️ Invalid Room ID format! Highrise Room IDs contain only numbers (0-9) and letters (a-f).\n` +
                            `Please check your Room ID and try again (or type "cancel"):`
                        );
                    }

                    session.roomId = input.toLowerCase();
                    session.state = 'awaiting_token';

                    const availCount = this.fleetManager.getAvailableTokens ? this.fleetManager.getAvailableTokens(session.botType).length : 0;
                    const hostedInstruction = availCount > 0
                        ? `\n⚡ DON'T HAVE AN API KEY?\n` +
                          `• We will provide a bot from our side! Type "0" to use our free hosted bot account (${availCount} ready in fleet inventory).\n\n`
                        : `\n(If you don't have an API key, please generate one at the link above).\n\n`;

                    return reply(
                        `✅ Target Room ID saved: ${session.roomId}\n\n` +
                        `🔑 Step 2/3: Enter your Highrise Bot API Token:\n` +
                        `• How to find it: Go to create.highrise.game/dashboard/credentials/api-keys, log in, create/open a Bot Key, and copy the 64-character token.\n` +
                        hostedInstruction +
                        `Please paste your 64-character token here, or type "0" if you don't have one:`
                    );
                }

                // Step: Awaiting Bot Token
                if (session.state === 'awaiting_token') {
                    const input = parts[0].trim();

                    // Check if customer types "0" (or "no", "none", "hosted") to request a bot from our inventory
                    if (input === '0' || input.toLowerCase() === 'zero' || input.toLowerCase() === 'no' || input.toLowerCase() === 'none' || input.toLowerCase() === 'hosted' || input.toLowerCase() === 'free') {
                        try {
                            const picked = this.fleetManager.checkoutTokenFromPool({
                                botType: session.botType,
                                customerId: user.id,
                                roomId: session.roomId
                            });
                            session.token = picked.token;
                            session.isHosted = true;
                            session.tokenLabel = picked.botUsername || picked.label;
                            session.tokenPoolId = picked.id;
                            session.state = 'awaiting_owner';

                            return reply(
                                `✨ Hosted Bot Account Selected: @${session.tokenLabel.replace(/^@/, "")}!\n\n` +
                                `👤 Step 3/4: What is the Highrise username for the bot owner?\n` +
                                `(The bot will recognize this user as room owner and grant them full command permissions):\n` +
                                `Example: @${user.username || "your_username"}`
                            );
                        } catch (poolErr) {
                            return reply(
                                `⚠️ All hosted bot accounts in our fleet inventory are currently in use!\n\n` +
                                `• Please provide your own 64-character Bot API Token from create.highrise.game/dashboard/credentials/api-keys\n` +
                                `• Or type "cancel" and try again later!`
                            );
                        }
                    }

                    // Check if user accidentally pasted their 24-char room ID here
                    if (input.length === 24 || is24Hex(input)) {
                        return reply(
                            `⚠️ That is a 24-character Room ID, not a Bot API Token!\n\n` +
                            `• Bot API Tokens are long 64-character keys.\n` +
                            `• Get your Bot API Token from create.highrise.game/dashboard/credentials/api-keys.\n\n` +
                            `Please reply with your 64-character Bot API Token (or type "cancel"):`
                        );
                    }

                    // Check length
                    if (input.length !== 64) {
                        return reply(
                            `⚠️ Invalid Bot API Token length! Highrise Bot Tokens are exactly 64 hexadecimal characters.\n` +
                            `• You entered: ${input.length} characters.\n` +
                            `• How to find it: create.highrise.game/dashboard/credentials/api-keys\n` +
                            `• Don't have an API key? Type "0" and we will provide one from our side!\n\n` +
                            `Please copy your full 64-character token, or type "0" (or "cancel"):`
                        );
                    }

                    // Check hex characters
                    if (!/^[0-9a-fA-F]{64}$/.test(input)) {
                        return reply(
                            `⚠️ Invalid Bot API Token format! Highrise Bot Tokens only contain 64 hexadecimal characters (0-9 and a-f) with no spaces.\n` +
                            `Please copy your full token again and paste it here (or type "cancel"):`
                        );
                    }

                    // Check token collision across the fleet
                    const inUse = this.fleetManager.isTokenInUse(input, `${user.id}_${session.roomId}_${session.botType}`);
                    if (inUse) {
                        const existingType = inUse.botType === 'music' ? 'Music DJ' : 'Emote';
                        const targetType = session.botType === 'music' ? 'Music DJ' : 'Emote';
                        if (inUse.roomId === session.roomId) {
                            return reply(
                                `⚠️ Token Already Running in This Room!\n\n` +
                                `• This Bot API Token is already actively running as your ${existingType} Bot in room "${session.roomId}".\n` +
                                `• A single Highrise bot account cannot run both an Emote Bot and a Music Bot at the same time.\n\n` +
                                `To run both bots, please use a separate bot account's token for your ${targetType} Bot (or type "cancel"):`
                            );
                        } else {
                            return reply(
                                `⚠️ Token Collision Detected!\n\n` +
                                `• That Bot API Token is already actively running in room "${inUse.roomId}" (owned by @${inUse.customerUsername})!\n` +
                                `• In Highrise, a bot account cannot be in two rooms at the same time.\n\n` +
                                `Please enter a different bot token (or type "cancel"):`
                            );
                        }
                    }

                    session.token = input;
                    session.state = 'awaiting_owner';
                    return reply(
                        `✅ Bot API Token received (64 characters)!\n\n` +
                        `👤 Step 3/3: What is the Highrise username for the bot owner?\n` +
                        `(The bot will recognize this user as its room owner and grant them full command permissions):\n` +
                        `Example: @${user.username || 'your_name'}`
                    );
                }

                // Step: Awaiting Owner Username
                if (session.state === 'awaiting_owner') {
                    const ownerInput = parts[0].replace(/^@/, '').trim().toLowerCase();
                    if (!ownerInput || ownerInput.length < 2) {
                        return reply('⚠️ Please provide a valid Highrise username (minimum 2 characters):');
                    }
                    session.ownerUsername = ownerInput;
                    session.state = 'awaiting_designer_confirmation';
                    session.reservedAt = Date.now();
                    session.reservationExpiresAt = Date.now() + (2 * 60 * 60 * 1000); // 2-Hour Reservation Window

                    const botDisplay = (session.tokenLabel || 'ALPHA_1').replace(/^@/, '');

                    return reply(
                        `📋 Step 4/4: GRANT DESIGNER PERMISSIONS IN HIGHRISE\n\n` +
                        `• Assigned Bot: 🤖 @${botDisplay}\n` +
                        `• Target Room: ${session.roomId}\n` +
                        `• Registered Owner: @${session.ownerUsername}\n\n` +
                        `⚠️ HIGHRISE ACTION REQUIRED BEFORE LAUNCH:\n` +
                        `In Highrise, bots are strictly blocked unless granted Designer rights in your room:\n\n` +
                        `1️⃣ Open Highrise and enter your room: "${session.roomId}"\n` +
                        `2️⃣ Tap Room Settings ➔ Roles ➔ Designers ➔ "Add Designer"\n` +
                        `3️⃣ Search for @${botDisplay} and grant Designer rights\n` +
                        `4️⃣ Tap SAVE in Highrise\n\n` +
                        `⏳ 2-Hour Reservation Window:\n` +
                        `This bot account is reserved for you for 2 hours. If not activated within 2 hours, it will be automatically revoked and returned to the inventory.\n\n` +
                        `👉 Once you have granted Designer rights in your room, reply with "done" (or "ready") to launch your bot!\n` +
                        `(Type "cancel" at any time to exit)`
                    );
                }

                // Step: Awaiting Designer Confirmation (Supports any formation of done/ready + 2-hour timeout)
                if (session.state === 'awaiting_designer_confirmation') {
                    const now = Date.now();

                    // Check if 2-hour reservation has expired
                    if (session.reservationExpiresAt && now > session.reservationExpiresAt) {
                        if (session.tokenPoolId) {
                            this.fleetManager.releaseTokenToPool(session.tokenPoolId);
                        }
                        this.dmSessions.delete(user.id);
                        return reply(
                            `⌛ RESERVATION EXPIRED:\n\n` +
                            `• Your 2-hour window to grant Designer rights for @${(session.tokenLabel || 'ALPHA').replace(/^@/, '')} has expired.\n` +
                            `• The bot account has been returned to the fleet inventory.\n` +
                            `• Your Gold was NOT deducted.\n\n` +
                            `You can start a fresh rental whenever you are ready by typing "rent"!`
                        );
                    }

                    const cleanCmd = cmd.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const cleanText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');

                    // Cancel handling
                    if (cleanCmd === 'cancel' || cleanCmd === 'abort' || cleanCmd === 'stop') {
                        if (session.tokenPoolId) {
                            this.fleetManager.releaseTokenToPool(session.tokenPoolId);
                        }
                        this.dmSessions.delete(user.id);
                        return reply('❌ Rental setup cancelled. Your Gold was not deducted.');
                    }

                    // Matches ANY formation of "done" or "ready" (e.g. Done, DOne, DONE, ready, Ready, READY, rdy, ok, yes, etc.)
                    const isDoneOrReady = (
                        cleanCmd === 'done' ||
                        cleanCmd === 'ready' ||
                        cleanCmd === 'rdy' ||
                        cleanCmd === 'ok' ||
                        cleanCmd === '1' ||
                        cleanCmd === 'launch' ||
                        cleanCmd === 'deploy' ||
                        cleanCmd === 'yes' ||
                        cleanCmd === 'yep' ||
                        cleanCmd === 'yeah' ||
                        cleanCmd === 'go' ||
                        cleanText.includes('done') ||
                        cleanText.includes('ready') ||
                        cleanText.includes('all done') ||
                        cleanText.includes('im done')
                    );

                    if (isDoneOrReady) {
                        const botType = session.botType;
                        const roomId = session.roomId;
                        const token = session.token;
                        const owner = session.ownerUsername;

                        const deployResult = await this._executeDeploy(user, botType, roomId, token, owner, reply);
                        if (deployResult && deployResult.success) {
                            this.dmSessions.delete(user.id);
                            return;
                        }

                        // Handshake failed (e.g. user said "done" but Designer rights still missing or incorrect)
                        const msLeft = Math.max(0, (session.reservationExpiresAt || (Date.now() + 2 * 60 * 60 * 1000)) - Date.now());
                        const hrsLeft = Math.floor(msLeft / (60 * 60 * 1000));
                        const minsLeft = Math.ceil((msLeft % (60 * 60 * 1000)) / (60 * 1000));
                        const timeLeftStr = hrsLeft > 0 ? `${hrsLeft}h ${minsLeft}m` : `${minsLeft} minute(s)`;
                        const botDisplay = (session.tokenLabel || 'ALPHA_1').replace(/^@/, '');

                        return reply(
                            `⚠️ Highrise is still rejecting entry: Designer rights are NOT active yet!\n\n` +
                            `• Assigned Bot: 🤖 @${botDisplay}\n` +
                            `• Target Room: ${roomId}\n\n` +
                            `📋 To complete setup in Highrise:\n` +
                            `1️⃣ Enter your room: "${roomId}"\n` +
                            `2️⃣ Open Room Settings ➔ Roles ➔ Designers ➔ "Add Designer"\n` +
                            `3️⃣ Search for @${botDisplay} and tap Designer\n` +
                            `4️⃣ Tap SAVE in Highrise\n\n` +
                            `⏳ Reservation Timer: You have ${timeLeftStr} remaining before this bot is automatically revoked and returned to the inventory.\n\n` +
                            `👉 Once saved, reply with "done" (or "ready") to try again! (Or type "cancel" to exit):`
                        );
                    }

                    // Any other unrecognized text while waiting
                    const msLeft = Math.max(0, (session.reservationExpiresAt || (Date.now() + 2 * 60 * 60 * 1000)) - Date.now());
                    const hrsLeft = Math.floor(msLeft / (60 * 60 * 1000));
                    const minsLeft = Math.ceil((msLeft % (60 * 60 * 1000)) / (60 * 1000));
                    const timeLeftStr = hrsLeft > 0 ? `${hrsLeft}h ${minsLeft}m` : `${minsLeft} minute(s)`;
                    const botDisplay = (session.tokenLabel || 'ALPHA_1').replace(/^@/, '');

                    return reply(
                        `🤖 Bot @${botDisplay} is currently reserved for your room (${timeLeftStr} remaining).\n\n` +
                        `👉 Please add @${botDisplay} as a Designer in Room Settings, then reply with "done" or "ready" to launch your bot!\n` +
                        `(Type "cancel" to exit and release the bot account)`
                    );
                }
            }

            // --- MENU & COMMAND DISPATCH ---

            // Option 1: Purchase / Rent
            if (cmd === '1' || cmd === 'purchase' || cmd === 'rent' || cmd === 'buy' || cmd === 'deploy') {
                // Check credit before starting wizard
                const isOwner = this._isOwner(user);
                const daysAvailable = this._getDaysAvailable(user.id);

                if (!isOwner && daysAvailable < 1) {
                    // Allow free trial for new users
                    if (!this._isTrialEligible(user.id)) {
                        const gold = this.credits.get(user.id)?.goldBalance || 0;
                        return reply(
                            `\u{274C} You need at least ${this.goldPerDay} Gold to start a bot! (Current Balance: ${gold} Gold)\n\n` +
                            `\u{1F4B0} Pricing: ${this.goldPerDay} Gold/Day (billed daily from your wallet)\n` +
                            `To add credit, tip Gold to the Master Bot in the showroom room, then type "1" again to deploy!`
                        );
                    }
                }

                if (channel === 'dm') {
                    this.dmSessions.set(user.id, { state: 'choose_type', conversationId: conversation?.id });
                    return reply(this._getBotTypeMenu());
                } else {
                    return reply(
                        `🤖 To purchase a bot, please send me a Direct Message (DM) with "rent" or "menu", and I will guide you step by step!`
                    );
                }
            }

            // Option 2: My Bots (Multi-bot support & Self-Service Management)
            if (cmd === '2' || cmd === 'mybots' || cmd === 'mybot' || cmd === 'status') {
                const isSuperOwner = this._isOwner(user);
                const gold = this.credits.get(user.id)?.goldBalance || 0;
                const days = this._getDaysAvailable(user.id);
                const rentals = this.fleetManager.getRentals().filter(r => this._canManageRental(user, r));

                if (rentals.length === 0) {
                    return reply(
                        `🤖 You have no active bots currently deployed.\n` +
                        `💰 Available Balance: ${isSuperOwner ? 'Unlimited (Super Owner)' : `${gold} Gold (${days} days)`}\n\n` +
                        `Reply with "1" or "rent" to purchase your first bot!`
                    );
                }

                let text = `🤖 YOUR BOTS (${rentals.length}):\n\n`;
                rentals.forEach((r, idx) => {
                    const statusIcon = r.isRunning ? '🟢 Online' : (r.status === 'customer_deactivated' ? '⏹️ Deactivated' : (r.status === 'failed_credentials' ? '⚠️ Token Error' : '⏹️ Stopped'));
                    const hostType = r.isHostedToken ? `Fleet Hosted (@${(r.tokenLabel || 'ALPHA').replace(/^@/, '')})` : 'Custom Token';
                    const serverLocation = r.nodeName || (r.nodeId === 'local' ? 'Server 1 (Local)' : (r.nodeUrl || 'Server 1'));
                    text += `[${idx + 1}] Room: ${r.roomId}\n` +
                            `    Type: ${r.botType === 'emote' ? 'Emote Bot (PakBot)' : 'Music Bot'} | ${hostType}\n` +
                            `    Owner: @${r.ownerUsername || r.customerUsername || 'User'}\n` +
                            `    Server: 🌐 ${serverLocation}\n` +
                            `    Status: ${statusIcon} (PID: ${r.pid || r.remotePid || 'none'})\n` +
                            `    Balance: ${r.daysRemaining}\n\n`;
                });

                text += `⚡ SELF-SERVICE ACTIONS FOR YOUR BOTS:\n` +
                        `• Single Bot: Reply "delete 1" or "deactivate 1" (or with Room ID)\n` +
                        `• Multiple Bots: Reply "delete 1, 2" or "delete 1 3" (or "delete 1-3")\n` +
                        `• All Bots: Reply "delete all" or "deactivate all"\n\n` +
                        `💰 Wallet Model: Gold is deducted daily (${this.goldPerDay}g/day). Top up anytime to keep your bot running!\n` +
                        `Extra Gold Balance: ${isSuperOwner ? 'Unlimited (Super Owner)' : `${gold} Gold (${days} days)`}`;
                return reply(text);
            }

            // Customer & Owner Self-Service Bot Deactivation and Deletion (1, multiple, or all)
            if (
                cmd === 'stopbot' || cmd === 'deactivate' || cmd === 'deactivatebot' ||
                cmd === 'deletebot' || cmd === 'delete' || cmd === 'removebot' ||
                cmd === 'killbot' || cmd === 'killbots' || cmd === 'deletebots' || cmd === 'stopbots' || cmd === 'deleteall' || cmd === 'deactivateall' ||
                (cmd === 'stop' && !this.dmSessions.has(user.id))
            ) {
                const isSuperOwner = this._isOwner(user);
                const allRentals = this.fleetManager.getRentals();
                const myRentals = allRentals.filter(r => this._canManageRental(user, r));

                const isDeleteAction = (cmd === 'delete' || cmd === 'deletebot' || cmd === 'removebot' || cmd === 'deleteall');
                const actionWord = isDeleteAction ? 'delete' : 'deactivate';

                // Candidate pool: Super Owner can target any bot across the fleet; regular users can only target their own.
                const poolRentals = isSuperOwner ? allRentals : myRentals;

                let targetRentals = [];
                const fullArgText = args.join(' ').trim();
                const isExplicitAll = (cmd === 'deleteall' || cmd === 'deactivateall' || fullArgText.toLowerCase() === 'all' || fullArgText.toLowerCase() === 'all bots' || fullArgText.toLowerCase() === 'everything');

                // Case A: Delete ALL
                if (isExplicitAll) {
                    if (poolRentals.length === 0) {
                        return reply(`❌ No active or rented bots found to ${actionWord}.`);
                    }
                    targetRentals = poolRentals;
                }
                // Case B: Arguments provided (e.g. "1", "1, 2", "1 2 3", "1-3", or room IDs)
                else if (fullArgText.length > 0) {
                    // Expand ranges like 1-3 to 1,2,3
                    let expanded = fullArgText.toLowerCase().replace(/(\d+)\s*-\s*(\d+)/g, (m, start, end) => {
                        const s = parseInt(start, 10);
                        const e = parseInt(end, 10);
                        if (s <= e && e - s <= 30) {
                            const arr = [];
                            for (let i = s; i <= e; i++) arr.push(i);
                            return arr.join(' ');
                        }
                        return m;
                    });

                    const tokens = expanded.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
                    const seenIds = new Set();
                    const notFound = [];
                    const unauthorized = [];

                    for (const tok of tokens) {
                        if (tok === 'all') {
                            targetRentals = poolRentals;
                            break;
                        }

                        let matched = null;
                        const indexNum = parseInt(tok, 10);

                        // Check 1..N index against candidate pool
                        if (!isNaN(indexNum) && indexNum >= 1 && indexNum <= poolRentals.length) {
                            matched = poolRentals[indexNum - 1];
                        } else {
                            // Match by rentalId, roomId, customerId, or tokenLabel
                            matched = poolRentals.find(r =>
                                r.rentalId?.toLowerCase() === tok ||
                                r.roomId?.toLowerCase() === tok ||
                                r.tokenLabel?.toLowerCase() === tok ||
                                r.customerId?.toLowerCase() === tok ||
                                (r.customerUsername && r.customerUsername.toLowerCase() === tok)
                            );

                            // Check unauthorized
                            if (!matched && !isSuperOwner) {
                                const existsInFleet = allRentals.find(r =>
                                    r.rentalId?.toLowerCase() === tok ||
                                    r.roomId?.toLowerCase() === tok
                                );
                                if (existsInFleet) {
                                    unauthorized.push(tok);
                                    continue;
                                }
                            }
                        }

                        if (matched) {
                            if (!seenIds.has(matched.rentalId)) {
                                seenIds.add(matched.rentalId);
                                targetRentals.push(matched);
                            }
                        } else {
                            notFound.push(tok);
                        }
                    }

                    if (unauthorized.length > 0) {
                        return reply(`❌ Permission Denied: You do not have permission to ${actionWord} bot "${unauthorized[0]}". You can only ${actionWord} your OWN bots!`);
                    }

                    if (targetRentals.length === 0) {
                        return reply(`❌ Could not find any bot matching "${fullArgText}". Type "mybots" to view your bots.`);
                    }
                }
                // Case C: No arguments provided
                else {
                    if (poolRentals.length === 0) {
                        return reply(`❌ You do not have any active or rented bots to ${actionWord}.`);
                    } else if (poolRentals.length === 1) {
                        targetRentals = [poolRentals[0]];
                    } else {
                        // Multiple bots available: prompt user with instructions for 1, multiple, or all!
                        let prompt = `⚠️ Which bot(s) would you like to ${actionWord}?\n\n`;
                        poolRentals.forEach((r, idx) => {
                            const hostLabel = r.isHostedToken ? `[@${(r.tokenLabel || 'ALPHA').replace(/^@/, '')}]` : '[Custom]';
                            prompt += `[${idx + 1}] Room: ${r.roomId} (${r.botType === 'emote' ? 'Emote' : 'Music'}) ${hostLabel}\n`;
                        });
                        prompt += `\nReply with:\n` +
                                  `• Single Bot: "${actionWord} 1" or "${actionWord} <room_id>"\n` +
                                  `• Multiple Bots: "${actionWord} 1, 2" or "${actionWord} 1 3" or "${actionWord} 1-3"\n` +
                                  `• All Bots: "${actionWord} all" to ${actionWord} all bots`;
                        return reply(prompt);
                    }
                }

                // Execute action for all targetRentals
                if (isDeleteAction) {
                    let deletedList = [];
                    for (const r of targetRentals) {
                        const ok = this.fleetManager.deleteRental(r.rentalId, isSuperOwner ? 'admin_deleted' : 'customer_deleted');
                        if (ok) deletedList.push(r);
                    }

                    if (deletedList.length === 0) {
                        return reply(`❌ Failed to delete target bot(s).`);
                    }

                    let msg = `🗑️ Successfully Deleted ${deletedList.length} Bot(s):\n\n`;
                    deletedList.forEach((r, idx) => {
                        const hostInfo = r.isHostedToken ? `[@${(r.tokenLabel || 'ALPHA').replace(/^@/, '')} returned to pool]` : '[Custom]';
                        msg += `• [${idx + 1}] Room: ${r.roomId} (${r.botType === 'emote' ? 'Emote' : 'Music'}) - ${hostInfo}\n`;
                    });

                    msg += `\n💰 Wallet Model: Gold is deducted daily. Top up anytime!\n` +
                           `Type "rent" at any time to deploy a fresh bot!`;
                    return reply(msg);
                } else {
                    // Deactivate
                    let deactivatedList = [];
                    let alreadyOfflineList = [];

                    for (const r of targetRentals) {
                        if (!r.isRunning && r.status === 'customer_deactivated') {
                            alreadyOfflineList.push(r);
                            continue;
                        }
                        const ok = this.fleetManager.terminateRental(r.rentalId, isSuperOwner ? 'admin_terminated' : 'customer_deactivated');
                        if (ok) deactivatedList.push(r);
                    }

                    let msg = '';
                    if (deactivatedList.length > 0) {
                        msg += `🛑 Successfully Deactivated ${deactivatedList.length} Bot(s):\n\n`;
                        deactivatedList.forEach((r, idx) => {
                            const hostInfo = r.isHostedToken ? `[@${(r.tokenLabel || 'ALPHA').replace(/^@/, '')} returned to pool]` : '';
                            msg += `• [${idx + 1}] Room: ${r.roomId} (${r.botType === 'emote' ? 'Emote' : 'Music'}) ${hostInfo}\n`;
                        });
                        msg += `\n💰 Wallet Model: Gold is deducted daily. Deactivated bots stop billing.\n`;
                    }
                    if (alreadyOfflineList.length > 0) {
                        msg += `ℹ️ ${alreadyOfflineList.length} bot(s) were already deactivated/offline.\n`;
                    }
                    msg += `Reply "rent" to deploy again, or "delete all" to purge your bots!`;
                    return reply(msg);
                }
            }

            // Option 3: Balance & Pricing
            if (cmd === '3' || cmd === 'balance' || cmd === 'price' || cmd === 'prices') {
                const isOwner = this._isOwner(user);
                const gold = this.credits.get(user.id)?.goldBalance || 0;
                const days = this._getDaysAvailable(user.id);
                return reply(
                    `💰 RENTAL BALANCE & PRICING:\n\n` +
                    `• Your Gold Balance: ${isOwner ? 'Unlimited (Super Owner)' : `${gold} Gold (${days} rental day${days === 1 ? '' : 's'})`}\n` +
                    `Daily Rate: ${this.goldPerDay} Gold/Day per active bot\n` +
                    `    7 Days: ${this.goldPerDay * 7} Gold\n` +
                    `    30 Days: ${this.goldPerDay * 30} Gold\n\n` +
                    `Prepaid Wallet Model:\n` +
                    `    Gold is deducted automatically every 24 hours per active bot.\n` +
                    `    If your wallet runs out, you'll receive 5 warnings over 10 hours.\n` +
                    `    After warnings, your bot enters a 7-day grace period.\n` +
                    `    Top up anytime to keep your bot running!\n\n` +
                    `To add Gold, simply tip the Master Bot in the showroom room!`
                );
            }

            // Option 4: Free Token & Setup Guide
            if (cmd === '4' || cmd === 'guide' || cmd === 'token') {
                return reply(
                    `📖 HOW TO GET YOUR FREE BOT TOKEN:\n\n` +
                    `1. Open https://create.highrise.game in your browser.\n` +
                    `2. Go to "Dashboard" -> "Credentials / API Keys".\n` +
                    `3. Create a new Bot API key and copy the token.\n` +
                    `4. In Highrise, give your bot account "Designer" rights in your room.\n` +
                    `5. Reply "1" here in DM to deploy your bot instantly!\n\n` +
                    `(Don't have a token? Type "0" during setup to use one of our hosted fleet accounts!)`
                );
            }

            // Music Bot Coming Soon Command
            if (cmd === 'music' || cmd === 'musicbot' || cmd === 'dj') {
                return reply(
                    `⏳ 24/7 MUSIC DJ BOT - COMING SOON!\n\n` +
                    `🎵 The Music DJ Bot is currently undergoing final upgrades and will launch soon.\n` +
                    `🕺 You can deploy our feature-packed Emote Bot right now by replying "1" or "rent"!\n` +
                    `Reply "menu" to view all available options.`
                );
            }

            // --- SUPER OWNER COMMANDS ---
            if (this._isOwner(user)) {
                // //fleet / fleet / allbots / active
                // //nodes / //servers / //cluster (Multi-server cluster health and capacities)

                // //setmusic <rentalId or roomId or customer> <ip:port or url>
                if (cmd === 'setmusic' || cmd === 'setmusicserver' || cmd === 'musicurl' || cmd === 'setmusicport') {
                    if (!this._isOwner(user)) return reply('❌ Super Owner permission required.');
                    const targetKey = args[0];
                    const rawUrl = args[1];
                    if (!targetKey || !rawUrl) {
                        return reply(
                            `Usage: ${this.prefix}setmusic <rentalId or roomId or customer> <ip:port or url>\n\n` +
                            `Examples:\n` +
                            `• ${this.prefix}setmusic 6a7addda_6a9865_music_alpha_1 123.45.67.89:30060\n` +
                            `• ${this.prefix}setmusic 6a9865186e9936ccdd6bd143 http://123.45.67.89:30060`
                        );
                    }

                    let normalized = rawUrl.trim();
                    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
                        normalized = 'http://' + normalized;
                    }
                    normalized = normalized.replace(/\/+$/, '');

                    try {
                        await reply(`⏳ Linking Audio Server "${normalized}" to bot "${targetKey}"...`);
                        const updatedRental = await this.fleetManager.setMusicServer(targetKey, normalized);

                        // Notify the customer directly
                        const custId = updatedRental.customerId;
                        const custConv = this.userConversations[custId] || this.userConversations[(updatedRental.customerUsername || '').toLowerCase()];
                        const custMsg = 
                            `🎵 GREAT NEWS! Your Music DJ Audio Server is now LIVE and CONNECTED!\n\n` +
                            `• Room: ${updatedRental.roomId}\n` +
                            `• Audio Server: Activated\n` +
                            `• Commands: /play <song name or link>, /queue, /skip, /np, /volume\n\n` +
                            `Go ahead and type /play in your room to begin streaming 24/7 high-fidelity music!`;

                        if (custConv && this.bot?.direct) {
                            this.bot.direct.send(custConv, custMsg).catch(() => {});
                        } else if (this.bot?.whisper) {
                            this.bot.whisper.send(custId, custMsg).catch(() => {});
                        }

                        return reply(
                            `✅ SUCCESS! Linked Audio Server to bot "${updatedRental.rentalId}"!\n\n` +
                            `• Room ID: ${updatedRental.roomId}\n` +
                            `• Customer: @${updatedRental.customerUsername}\n` +
                            `• Audio Server: ${normalized}\n` +
                            `• Action: Configuration updated & bot restarted.\n` +
                            `• Customer Notified: Yes\n\n` +
                            `💡 Note: If you ever need to change the IP or port in the future, just re-run ${this.prefix}setmusic!`
                        );
                    } catch (err) {
                        return reply(`❌ Error setting music server: ${err.message}`);
                    }
                }

                if (cmd === 'nodes' || cmd === 'servers' || cmd === 'cluster') {
                    if (!isSuperOwner) return reply('❌ Super Owner permission required.');
                    const nodes = this.fleetManager.nodeManager ? this.fleetManager.nodeManager.getNodes() : [];
                    let text = `🌐 CLUSTER SERVERS (${nodes.length}):\n\n`;
                    nodes.forEach((n, idx) => {
                        const icon = n.status === 'online' ? '🟢' : (n.status === 'offline' ? '🔴' : '🟡');
                        const types = (n.botTypes || []).join('/').toUpperCase();
                        text += `[${idx + 1}] ${icon} ${n.name}\n` +
                                `    URL: ${n.url}\n` +
                                `    Types: ${types}\n` +
                                `    Capacity: ${n.activeCount}/${n.maxCapacity} bots (${n.availableSlots} free)\n\n`;
                    });
                    const totalCap = nodes.reduce((a, n) => a + n.maxCapacity, 0);
                    const totalActive = nodes.reduce((a, n) => a + n.activeCount, 0);
                    text += `📊 Total Cluster Load: ${totalActive}/${totalCap} bots across ${nodes.length} server(s).`;
                    return reply(text);
                }

                if (cmd === 'fleet' || cmd === 'allbots' || cmd === 'statusall' || cmd === 'active') {
                    const rentals = this.fleetManager.getRentals();
                    const active = rentals.filter(r => r.isRunning);
                    if (rentals.length === 0) {
                        return reply('👑 Fleet Overview: 0 active bots / 0 total rentals in fleet.');
                    }
                    let text = `👑 Fleet Overview: ${active.length} active / ${rentals.length} total\n\n`;
                    for (const r of rentals.slice(0, 15)) {
                        const statusIcon = r.isRunning ? '🟢' : (r.status === 'customer_deactivated' ? '⏹️' : '⚠️');
                        const hostLabel = r.isHostedToken ? `[@${(r.tokenLabel || 'ALPHA').replace(/^@/, '')}]` : '[Custom]';
                        const srv = r.nodeName ? `[${r.nodeName}] ` : '';
                          text += `${statusIcon} @${r.ownerUsername || r.customerUsername}: [${r.status}] Room ${r.roomId} ${srv}${hostLabel} (${r.daysRemaining}d left, PID: ${r.pid || r.remotePid || 'none'})\n`;
                    }
                    return reply(text);
                }

                // //killall / //stopall (Emergency terminate all active customer bots)
                if (cmd === 'killall' || cmd === 'stopall' || cmd === 'terminateall') {
                    const res = this.fleetManager.terminateAllRentals('owner_emergency_stop');
                    return reply(`🛑 EMERGENCY STOP: Successfully stopped all ${res.terminatedCount} active customer bot(s) across the fleet!`);
                }

                // //tokens / //pool (Lists bot token pool inventory)
                if (cmd === 'tokens' || cmd === 'pool' || cmd === 'inventory' || cmd === 'keys') {
                    const pool = this.fleetManager.getTokenPool ? this.fleetManager.getTokenPool(false) : [];
                    const avail = this.fleetManager.getAvailableTokens ? this.fleetManager.getAvailableTokens().length : 0;
                    let msg = `🔑 FLEET BOT INVENTORY (TOKEN POOL)\n` +
                              `Total Accounts: ${pool.length} | Available: ${avail} | In Use: ${pool.length - avail}\n\n`;
                    for (const t of pool) {
                        const icon = t.status === 'available' ? '🟢 Available' : `🔵 In Use (Room: ${t.assignedRoom || 'Active'})`;
                        msg += `• [${t.label}] ${icon}\n`;
                    }
                    return reply(msg);
                }

                // //pending (Lists orders waiting for on-demand activation)
                if (cmd === 'pending' || cmd === 'orders') {
                    const pending = this.fleetManager.getPendingRentals();
                    if (pending.length === 0) {
                        return reply('✨ No pending bot orders waiting for activation!');
                    }
                    let msg = `⏳ Pending Bot Orders (${pending.length}):\n\n`;
                    for (const p of pending) {
                        msg += `• [${p.botType.toUpperCase()}] ID: ${p.rentalId}\n` +
                               `  Customer: @${p.customerUsername} | Room: ${p.roomId}\n` +
                               `  To activate: ${this.prefix}activate ${p.rentalId}\n\n`;
                    }
                    return reply(msg);
                }

                // //activate <rentalId or customerId>
                if (cmd === 'activate' || cmd === 'deploypending') {
                    const targetId = args[0];
                    if (!targetId) return reply(`Usage: ${this.prefix}activate <rentalId or customerId>`);
                    await reply(`⏳ Activating and verifying bot "${targetId}" in Highrise...`);
                    try {
                        const res = await this.fleetManager.activateRental(targetId);
                        const r = res.rental;
                        return reply(
                            `🚀 SUCCESS! Bot for @${r.customerUsername} is now LIVE in room ${r.roomId}!\n` +
                            `• PID: ${r.pid}\n` +
                            `• 7-Day countdown clock has officially started.\n` +
                            `• Bot Type: ${r.botType.toUpperCase()}`
                        );
                    } catch (e) {
                        return reply(`❌ Activation failed: ${e.message}`);
                    }
                }

                // ==========================================
                // 📍 BOT POSITIONING & TELEPORTATION SYSTEM
                // ==========================================

                // !setbot / !sethome / !setanchor (sets permanent home anchor)
                if (cmd === 'setbot' || cmd === 'sethome' || cmd === 'setanchor') {
                    const arg0 = (args[0] || '').toLowerCase();
                    const isMe = !args[0] || arg0 === 'me' || arg0 === 'here';

                    if (isMe) {
                        const userPos = await this.positionManager.getUserPosition(bot, user.id);
                        if (!userPos) {
                            return reply('❌ Could not determine your position. Please walk a step and try again!');
                        }
                        const facing = this.positionManager.invertFacing(userPos.facing);
                        this.positionManager.setHomePosition(userPos.x, userPos.y, userPos.z, facing);
                        await this.positionManager.ensureHomePosition(bot);
                        return reply(`📍 Master Bot home anchor saved to your spot (${userPos.x.toFixed(1)}, ${userPos.y.toFixed(1)}, ${userPos.z.toFixed(1)}) facing ${facing}! Anchor Guardian active.`);
                    }

                    // Coordinates: !setbot <x> <y> <z> [facing]
                    const x = parseFloat(args[0]);
                    const y = parseFloat(args[1]);
                    const z = parseFloat(args[2]);
                    const facing = args[3] || 'FrontRight';

                    if (isNaN(x) || isNaN(y) || isNaN(z)) {
                        return reply('Usage: ` + this.prefix + `setbot me  OR  ` + this.prefix + `setbot <x> <y> <z> [facing]');
                    }

                    this.positionManager.setHomePosition(x, y, z, facing);
                    await this.positionManager.ensureHomePosition(bot);
                    return reply(`📍 Master Bot home anchor saved to (${x}, ${y}, ${z}) facing ${facing}! Anchor Guardian active.`);
                }

                // !home / !return (returns bot to home post)
                if (cmd === 'home' || cmd === 'return') {
                    const ok = await this.positionManager.ensureHomePosition(bot);
                    return reply(ok ? '📍 Master Bot returned to home anchor!' : '⚠️ No home anchor configured yet. Use ` + this.prefix + `setbot me');
                }

                // !setloc / !saveloc <name>
                if (cmd === 'setloc' || cmd === 'saveloc') {
                    const locName = (args[0] || '').toLowerCase();
                    if (!locName) return reply('Usage: ` + this.prefix + `setloc <name>');

                    const userPos = await this.positionManager.getUserPosition(bot, user.id);
                    if (!userPos) return reply('❌ Could not determine your position. Walk a step and try again!');

                    this.positionManager.setNamedLocation(locName, userPos.x, userPos.y, userPos.z, userPos.facing);
                    return reply(`💾 Saved location "${locName.toUpperCase()}" at (${userPos.x.toFixed(1)}, ${userPos.y.toFixed(1)}, ${userPos.z.toFixed(1)})! Teleport bot anytime with: ` + this.prefix + `tp ${locName}`);
                }

                // !delloc / !removeloc <name>
                if (cmd === 'delloc' || cmd === 'removeloc') {
                    const locName = (args[0] || '').toLowerCase();
                    if (!locName) return reply('Usage: ` + this.prefix + `delloc <name>');
                    const ok = this.positionManager.deleteNamedLocation(locName);
                    return reply(ok ? `🗑️ Deleted location "${locName}".` : `❌ Location "${locName}" not found.`);
                }

                // !locs / !locations
                if (cmd === 'locs' || cmd === 'locations') {
                    const list = this.positionManager.getAllLocations();
                    if (list.length === 0) return reply('📍 No saved locations. Save one with: ` + this.prefix + `setloc <name>');
                    const lines = list.map(l => `• **${l.name.toUpperCase()}**: (${l.x.toFixed(1)}, ${l.y.toFixed(1)}, ${l.z.toFixed(1)})`);
                    return reply(`📍 Saved Showroom Locations (${list.length}):\n` + lines.join('\n'));
                }

                // !tp / !goto / !teleport (teleport the Master Bot)
                if (cmd === 'tp' || cmd === 'goto' || cmd === 'teleport') {
                    if (args.length === 0) {
                        return reply('Usage: ` + this.prefix + `tp <location_name>  OR  ` + this.prefix + `tp <x> <y> <z> [facing]');
                    }

                    // Named location: !tp cashier
                    if (args.length === 1 && isNaN(parseFloat(args[0]))) {
                        const locName = args[0].toLowerCase();
                        const loc = this.positionManager.getNamedLocation(locName);
                        if (!loc) {
                            return reply(`❌ Location "${locName}" not found. Type ` + this.prefix + `locs to view all saved spots.`);
                        }
                        await this.positionManager.moveBotTo(bot, loc.x, loc.y, loc.z, loc.facing);
                        return reply(`✨ Teleported Master Bot to "${locName.toUpperCase()}"!`);
                    }

                    // Coordinates: !tp 10 0 10
                    const x = parseFloat(args[0]);
                    const y = parseFloat(args[1]);
                    const z = parseFloat(args[2]);
                    const facing = args[3] || 'FrontRight';

                    if (isNaN(x) || isNaN(y) || isNaN(z)) {
                        return reply('Usage: ` + this.prefix + `tp <location_name>  OR  ` + this.prefix + `tp <x> <y> <z> [facing]');
                    }

                    await this.positionManager.moveBotTo(bot, x, y, z, facing);
                    return reply(`✨ Teleported Master Bot to (${x}, ${y}, ${z})!`);
                }

                // ==========================================
                // 👗 UNIVERSAL OUTFITS & WARDROBE SYSTEM
                // ==========================================

                // !clone @username / !copy @username
                if (cmd === 'clone' || cmd === 'copy' || cmd === 'copyoutfit') {
                    const target = (args[0] || '').replace(/^@/, '').trim();
                    if (!target) {
                        return reply('Usage: ` + this.prefix + `clone @username (Clones ANY Highrise player globally)');
                    }

                    await reply(`🔍 Fetching outfit for @${target}...`);
                    const res = await this.outfitManager.cloneUniversalOutfit(bot, target);
                    if (!res.success) {
                        return reply(`❌ ${res.error}`);
                    }

                    const skipped = res.skippedCount > 0 ? ` (${res.skippedCount} exclusive unowned items skipped)` : '';
                    return reply(`👗 OUTFIT CLONED! Master Bot is now wearing @${res.username}'s outfit (${res.count} items)!${skipped} ✨`);
                }

                // !outfit command dispatcher
                if (cmd === 'outfit' || cmd === 'wardrobe') {
                    const sub = (args[0] || '').toLowerCase();

                    // !outfit clone @user
                    if (sub === 'clone' || sub === 'copy') {
                        const target = (args[1] || '').replace(/^@/, '').trim();
                        if (!target) return reply('Usage: ` + this.prefix + `outfit clone @username');

                        await reply(`🔍 Fetching outfit for @${target}...`);
                        const res = await this.outfitManager.cloneUniversalOutfit(bot, target);
                        if (!res.success) return reply(`❌ ${res.error}`);

                        const skipped = res.skippedCount > 0 ? ` (${res.skippedCount} exclusive items skipped)` : '';
                        return reply(`👗 OUTFIT CLONED! Master Bot is now wearing @${res.username}'s outfit (${res.count} items)!${skipped} ✨`);
                    }

                    // !outfit save <name>
                    if (sub === 'save' || sub === 'create') {
                        const presetName = args[1];
                        if (!presetName) return reply('Usage: ` + this.prefix + `outfit save <preset_name>');

                        const current = await this.outfitManager.getBotCurrentOutfit(bot);
                        if (!current.length) return reply('❌ Could not fetch Master Bot current outfit.');

                        this.outfitManager.savePreset(presetName, current, user.username || user.id);
                        return reply(`💾 Saved Master Bot outfit preset "${presetName.toUpperCase()}" (${current.length} items)!`);
                    }

                    // !outfit load <name> / !wear <name>
                    if (sub === 'load' || sub === 'wear') {
                        const presetName = args[1];
                        if (!presetName) return reply('Usage: ` + this.prefix + `outfit load <preset_name>');

                        const res = await this.outfitManager.loadPreset(bot, presetName);
                        if (!res.success) return reply(`❌ ${res.error}`);

                        return reply(`👗 Master Bot equipped outfit preset "${presetName.toUpperCase()}" (${res.count} items)! ✨`);
                    }

                    // !outfit list / !presets
                    if (sub === 'list' || sub === 'presets') {
                        const list = this.outfitManager.getAllPresets();
                        if (list.length === 0) return reply('👗 No saved outfit presets. Save one with: ` + this.prefix + `outfit save <name>');
                        const lines = list.map(p => `• **${p.name.toUpperCase()}** (${p.count} items, saved by @${p.createdBy})`);
                        return reply(`👗 Saved Outfit Presets (${list.length}):\n` + lines.join('\n'));
                    }

                    // !outfit delete <name>
                    if (sub === 'delete' || sub === 'del' || sub === 'remove') {
                        const presetName = args[1];
                        if (!presetName) return reply('Usage: ` + this.prefix + `outfit delete <preset_name>');
                        const ok = this.outfitManager.deletePreset(presetName);
                        return reply(ok ? `🗑️ Deleted outfit preset "${presetName}".` : `❌ Preset "${presetName}" not found.`);
                    }

                    // Default !outfit info
                    const current = await this.outfitManager.getBotCurrentOutfit(bot);
                    return reply(
                        `👗 MASTER BOT UNIVERSAL WARDROBE:\n\n` +
                        `• Equipped: ${current.length} clothing items\n` +
                        `• ` + this.prefix + `clone @user - Clone ANY player's outfit globally\n` +
                        `• ` + this.prefix + `outfit save <name> - Save current outfit as preset\n` +
                        `• ` + this.prefix + `outfit load <name> - Equip a saved preset\n` +
                        `• ` + this.prefix + `outfit list - View all saved presets\n` +
                        `• ` + this.prefix + `outfit delete <name> - Delete a preset`
                    );
                }

                // !presets shortcut
                if (cmd === 'presets') {
                    const list = this.outfitManager.getAllPresets();
                    if (list.length === 0) return reply('👗 No saved outfit presets. Save one with: ` + this.prefix + `outfit save <name>');
                    const lines = list.map(p => `• **${p.name.toUpperCase()}** (${p.count} items, saved by @${p.createdBy})`);
                    return reply(`👗 Saved Outfit Presets (${list.length}):\n` + lines.join('\n'));
                }
            }
        };

        // 1. Whisper Event
        bot.on('Whisper', async (user, message) => {
            await handleCommand(user, message, 'whisper');
        });

        // 2. Room Chat Event
        bot.on('Chat', async (user, message) => {
            await handleCommand(user, message, 'chat');
        });

                // 3. Direct Message (DM) Event
        bot.on('Direct', async (user, message, conversation) => {
            if (!user || !conversation || user.id === this.botId) return;
            if (conversation.id) {
                this.userConversations[user.id] = conversation.id;
                if (user.username) {
                    this.userConversations[user.username.toLowerCase().replace(/^@/, '')] = conversation.id;
                }
                this._saveUserConversations();
            }
            const dmContent = typeof message === 'string' ? message : (message?.content || '');
            this.log.info('Direct', `📩 Received DM from @${user.username || user.id}: "${dmContent}"`);
            await handleCommand(user, message, 'dm', conversation);
        });
    }

    // Wallet Model: Deduct first day's Gold on successful deploy. Daily billing handled by Watchdog.
    async _executeDeploy(user, botType, roomId, token, ownerUsername, reply) {
        const isOwner = this._isOwner(user);
        const goldBalance = this.fleetManager.getBalance(user.id);
        const firstDayCost = this.goldPerDay; // 25g for first day

        // Check if user qualifies for free 1-hour trial
        const isTrialEligible = !isOwner && this._isTrialEligible(user.id);
        const isTrial = isTrialEligible && goldBalance < firstDayCost;

        if (!isOwner && !isTrial && goldBalance < firstDayCost) {
            return reply(
                `\u{274C} Insufficient Gold balance (${goldBalance} Gold). You need at least ${firstDayCost} Gold to start a bot.\n\n` +
                `\u{1F4B0} Daily Rate: ${this.goldPerDay} Gold/Day (billed daily from wallet)\n` +
                `Tip Gold to the Master Bot in the showroom to top up!`
            );
        }

        // Inform user that handshake is in progress
        await reply(`\u{23F3} Verifying credentials and connecting to Highrise room...\nPlease wait 3 seconds.`);

        try {
            // Live Handshake or Queued Activation
            const deployResult = await this.fleetManager.deployRental({
                customerId: user.id,
                customerUsername: user.username || user.id,
                botType: botType || 'emote',
                roomId: roomId.trim(),
                token: token.trim(),
                ownerUsername: ownerUsername || user.username || user.id
            });

            // If order was queued for on-demand provisioning
            if (deployResult && deployResult.queued) {
                if (isTrial) {
                    this._markTrialUsed(user.id, user.username || user.id);
                    const qr = deployResult.rental;
                    if (qr) {
                        const raw = this.fleetManager.rentals.get(qr.rentalId);
                        if (raw) {
                            raw.isTrial = true;
                            raw.trialExpiresAt = Date.now() + (1 * 60 * 60 * 1000);
                            this.fleetManager._saveRentals();
                        }
                    }
                } else if (!isOwner) {
                    this.fleetManager.deductBalance(user.id, firstDayCost);
                }

                const remainingGold = isOwner ? 'Unlimited (Super Owner)' : `${this.fleetManager.getBalance(user.id)} Gold`;
                const qRental = deployResult.rental;

                console.log(`[MasterBot] \u{1F4DD} [NEW MUSIC BOT ORDER] @${user.username || user.id} in room ${roomId} (Order ID: ${qRental.rentalId})`);

                return reply(
                    `\u{1F3B5} MUSIC BOT ORDER CONFIRMED!\n\n` +
                    `\u{1F4CB} Order ID: ${qRental.rentalId}\n` +
                    `\u{1F4CB} Target Room: ${roomId}\n` +
                    `\u{1F4CB} Registered Owner: @${ownerUsername}\n` +
                    `\u{1F4CB} Billing: ${this.goldPerDay} Gold/Day (Prepaid Wallet)\n` +
                    `\u{1F4CB} Gold Deducted: ${isOwner ? 0 : firstDayCost} Gold (Balance: ${remainingGold})\n` +
                    `\u{1F4CB} Order Status: \u{23F3} Queued for Activation\n\n` +
                    `\u{26A0} Your wallet will be billed ${this.goldPerDay}g daily. Top up anytime!\n` +
                    `You will receive a Highrise notification as soon as your bot arrives.`
                );
            }

            // Handle billing: free trial vs paid
            if (isTrial) {
                // Mark trial as used and set trial flags on the rental
                this._markTrialUsed(user.id, user.username || user.id);
                const rental = deployResult?.rental || this.fleetManager.getRentals().find(r => r.customerId === user.id && r.status === 'active');
                if (rental) {
                    const raw = this.fleetManager.rentals.get(rental.rentalId);
                    if (raw) {
                        raw.isTrial = true;
                        raw.trialExpiresAt = Date.now() + (1 * 60 * 60 * 1000); // 1 hour
                        this.fleetManager._saveRentals();
                    }
                }
                console.log(`[MasterBot] \u{1F381} FREE TRIAL started for @${user.username || user.id} in room ${roomId} (1 hour)`);
            } else if (!isOwner) {
                this.fleetManager.deductBalance(user.id, firstDayCost);
            }

            const remainingGold = isOwner ? 'Unlimited (Super Owner)' : `${this.fleetManager.getBalance(user.id)} Gold`;

            const hostedInfo = deployResult?.isHostedToken || deployResult?.rental?.isHostedToken 
                ? `\u{1F4CB} Bot Account: \u{1F916} Fleet Hosted (${deployResult?.rental?.tokenLabel || deployResult?.tokenLabel || 'ALPHA Bot'})\n\u{1F4CB} Note: Remember to grant Designer/Moderator rights to the bot in Highrise room settings!\n`
                : '';

            const trialMsg = isTrial
                ? `\u{1F381} FREE TRIAL: Your bot is running for 1 HOUR free!\n` +
                  `\u{23F0} Trial expires in 1 hour. Tip ${this.goldPerDay} Gold to keep it running after the trial!\n\n`
                : `\u{1F4CB} Billing: ${this.goldPerDay} Gold/Day (Prepaid Wallet)\n` +
                  `\u{1F4CB} First Day Deducted: ${isOwner ? 0 : firstDayCost} Gold\n` +
                  `\u{1F4CB} Remaining Balance: ${remainingGold}\n\n` +
                  `\u{1F4B0} Prepaid Wallet: Gold is deducted daily. If your wallet runs empty, you'll get 5 warnings before deactivation.\n`;

                        if (botType === 'music') {
                await reply(
                    `🚀 SUCCESS! Your 🎵 Music DJ Bot is deployed and connecting to room ${roomId}!\n\n` +
                    `⏳ IMPORTANT NOTICE: Your dedicated Audio Streaming Server is currently being provisioned by our team.\n` +
                    `• It may take anywhere from a few minutes to hours to activate audio playback.\n` +
                    `• Please be patient till then! Your bot is already inside your room.\n` +
                    `• You will receive a direct notification the moment your streaming server is linked!\n\n` +
                    `Default Commands: /play <song name or link>, /queue, /skip, /np`
                );

                const finalRental = deployResult?.rental || deployResult;
                const rId = finalRental?.rentalId || `${user.id}_${roomId}_music`;
                const adminMsg = 
                    `🚨 [NEW MUSIC BOT ORDER RECEIVED]\n\n` +
                    `• Customer: @${user.username || user.id} (${user.id})\n` +
                    `• Target Room: ${roomId}\n` +
                    `• Rental ID: ${rId}\n` +
                    `• Bot Account: @${(finalRental?.tokenLabel || 'ALPHA').replace(/^@/, '')}\n` +
                    `• Node: ${finalRental?.nodeName || 'Cluster Worker'}\n\n` +
                    `👉 When your audio server is ready, reply to me:\n` +
                    `//setmusic ${rId} <ip:port>\n\n` +
                    `Example: //setmusic ${rId} 123.45.67.89:30060`;

                if (isOwner || user.id === '6a7adddacc3fa67f5530833c') {
                    await reply(adminMsg);
                }
                await this.notifyAdmin(adminMsg);
            } else {
                await reply(
                    `\u{1F3B5} SUCCESS! Highrise verified your credentials and your bot is now online!\n\n` +
                    `\u{1F4CB} Target Room: ${roomId}\n` +
                    `\u{1F4CB} Registered Owner: @${ownerUsername}\n` +
                    hostedInfo +
                    trialMsg +
                    `\u{1F6E1} Self-Service: DM "mybots" to manage, deactivate, or delete your bot anytime.\n\n` +
                    `The bot is standing in your room with clean data and recognized @${ownerUsername} as its owner!`
                );
            }
            return { success: true, deployResult };
        } catch (err) {
            this.log.warn('DeployFailed', `Validation failed for ${user.id}: ${err.message}`);
            await reply(
                `\u{274C} Deployment Failed!\n\n` +
                `\u{26A0} Reason: ${err.message}\n\n` +
                `\u{26A0} Your Gold was NOT deducted. (Balance: ${isOwner ? 'Unlimited (Super Owner)' : this.fleetManager.getBalance(user.id) + ' Gold'})`
            );
            return { success: false, error: err.message };
        }
    }
}

module.exports = MasterBot;
