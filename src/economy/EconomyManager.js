import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

export const VIP_TIERS = [
  { tier: 1, goldOrTickets: 100, days: 7, label: '7 Days VIP' },
  { tier: 2, goldOrTickets: 200, days: 15, label: '15 Days VIP' },
  { tier: 3, goldOrTickets: 300, days: 60, label: '2 Months (60 Days) VIP' }
];

export class EconomyManager {
  constructor(storagePath = null) {
    this.storagePath = storagePath || path.join(CONFIG.ROOT_DIR, 'economy_state.json');
    this.data = {
      users: {},       // Keyed by userId: { username, tickets, isVip, vipExpiresAt, lastDailyClaim, totalTippedGold, songsPlayed, history }
      transactions: [] // Rolling log of system transactions
    };
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.users === 'object') {
          this.data = parsed;
          console.log(`💰 [Economy] Loaded state with ${Object.keys(this.data.users).length} user profile(s).`);
          return;
        }
      }
    } catch (err) {
      console.warn('⚠️ [Economy] Failed to parse economy_state.json, initializing fresh store:', err.message);
    }
    this.saveState();
  }

  saveState() {
    try {
      fs.writeFileSync(this.storagePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ [Economy] Failed to persist economy state:', err.message);
    }
  }

  // Get or initialize user account
  getUser(userId, username = null) {
    if (!userId) return null;
    let uid = String(userId).trim();

    // 1. If uid not directly found, check if an existing user matches this username/handle
    if (!this.data.users[uid]) {
      const lower = uid.toLowerCase().replace(/^@/, '');
      const matchedKey = Object.keys(this.data.users).find(k => {
        const u = this.data.users[k];
        return (u.username && u.username.toLowerCase().replace(/^@/, '') === lower) || k.toLowerCase() === lower;
      });
      if (matchedKey) {
        uid = matchedKey;
      }
    }

    if (!this.data.users[uid]) {
      this.data.users[uid] = {
        userId: uid,
        username: username || uid,
        tickets: 0,
        isVip: false,
        vipExpiresAt: null, // null means permanent if isVip === true
        lastDailyClaim: null,
        totalTippedGold: 0,
        songsPlayed: 0,
        createdAt: Date.now()
      };
      this.saveState();
    } else if (username && this.data.users[uid].username !== username) {
      this.data.users[uid].username = username;
    }

    // Auto-merge legacy tickets if gifted under username key instead of user ID
    if (username && username !== uid && this.data.users[username]) {
      const legacy = this.data.users[username];
      if (legacy.tickets > 0) {
        this.data.users[uid].tickets += legacy.tickets;
        legacy.tickets = 0;
        this.saveState();
      }
    }

    // Auto-expire VIP if expired
    const user = this.data.users[uid];
    if (user.isVip && user.vipExpiresAt && Date.now() > user.vipExpiresAt) {
      user.isVip = false;
      user.vipExpiresAt = null;
      this.saveState();
    }

    return user;
  }

  // Check user VIP status (with expiry check)
  isUserVip(userId) {
    const user = this.getUser(userId);
    if (!user) return false;
    if (user.isVip) {
      if (user.vipExpiresAt && Date.now() > user.vipExpiresAt) {
        user.isVip = false;
        user.vipExpiresAt = null;
        this.saveState();
        return false;
      }
      return true;
    }
    return false;
  }

  // Query user balance and status
  getBalance(userId, username = null) {
    const user = this.getUser(userId, username);
    if (!user) return null;

    const isVip = this.isUserVip(userId);
    const now = Date.now();
    const cooldownMs = 24 * 60 * 60 * 1000;
    const lastClaim = user.lastDailyClaim || 0;
    const canClaimDaily = (now - lastClaim) >= cooldownMs;
    const nextClaimInMs = canClaimDaily ? 0 : Math.max(0, (lastClaim + cooldownMs) - now);
    const daysLeft = user.vipExpiresAt ? Math.max(0, Math.ceil((user.vipExpiresAt - now) / (24 * 60 * 60 * 1000))) : (isVip ? 'Permanent' : 0);

    return {
      userId: user.userId,
      username: user.username,
      tickets: user.tickets,
      balance: user.tickets,
      newBalance: user.tickets,
      isVip,
      vipExpiresAt: user.vipExpiresAt,
      vip: {
        active: isVip,
        daysLeft,
        expiresAt: user.vipExpiresAt
      },
      canClaimDaily,
      dailyAvailable: canClaimDaily,
      nextClaimInMs,
      nextClaimInHours: (nextClaimInMs / (1000 * 60 * 60)).toFixed(1),
      totalTippedGold: user.totalTippedGold,
      songsPlayed: user.songsPlayed
    };
  }

  // Add tickets to user balance
  addTickets(userId, amount, reason = 'credit', username = null) {
    const qty = Math.max(0, Math.floor(Number(amount) || 0));
    if (qty <= 0) return false;

    const user = this.getUser(userId, username);
    user.tickets += qty;
    this.logTransaction(userId, 'CREDIT', qty, reason, user.tickets);
    this.saveState();
    return user.tickets;
  }

  // Deduct tickets from user balance
  deductTickets(userId, amount, reason = 'spend') {
    const qty = Math.max(0, Math.floor(Number(amount) || 0));
    const user = this.getUser(userId);
    if (!user || user.tickets < qty) return false;

    user.tickets -= qty;
    this.logTransaction(userId, 'DEBIT', qty, reason, user.tickets);
    this.saveState();
    return true;
  }

  // Helper: Grant or extend VIP by a specified number of days
  grantVipDays(user, days) {
    user.isVip = true;
    const now = Date.now();
    const durationMs = Number(days) * 24 * 60 * 60 * 1000;

    if (user.vipExpiresAt && user.vipExpiresAt > now) {
      user.vipExpiresAt += durationMs; // Extend existing active VIP
    } else {
      user.vipExpiresAt = now + durationMs; // Fresh VIP start
    }
    return user.vipExpiresAt;
  }

  // Process Gold Tip: 1 Gold = 1 Ticket + Tiered VIP Rewards
  // 100 G -> 7 days VIP | 200 G -> 15 days VIP | 300+ G -> 60 days (2 months) VIP
  processTip(userId, goldAmount, username = null) {
    const gold = Math.max(0, Math.floor(Number(goldAmount) || 0));
    if (gold <= 0) {
      return { success: false, error: 'Invalid gold amount' };
    }

    const user = this.getUser(userId, username);
    user.totalTippedGold += gold;
    const ticketsGranted = gold; // 1 Gold = 1 Ticket
    user.tickets += ticketsGranted;

    // Check VIP Tier Reward
    let vipReward = null;
    if (gold >= 300) {
      this.grantVipDays(user, 60);
      vipReward = { days: 60, label: '2 Months (60 Days) VIP', expiresAt: user.vipExpiresAt };
    } else if (gold >= 200) {
      this.grantVipDays(user, 15);
      vipReward = { days: 15, label: '15 Days VIP', expiresAt: user.vipExpiresAt };
    } else if (gold >= 100) {
      this.grantVipDays(user, 7);
      vipReward = { days: 7, label: '7 Days VIP', expiresAt: user.vipExpiresAt };
    }

    const logDetail = vipReward
      ? `Tipped ${gold} gold -> +${ticketsGranted} tickets & unlocked ${vipReward.label}!`
      : `Tipped ${gold} gold`;

    this.logTransaction(userId, 'TIP_REWARD', ticketsGranted, logDetail, user.tickets);
    this.saveState();

    console.log(`💰 [Economy Tip] User ${user.username} (${userId}) tipped ${gold} Gold -> +${ticketsGranted} Tickets${vipReward ? ` + VIP (${vipReward.label})` : ''} (Balance: ${user.tickets})`);

    return {
      success: true,
      userId: user.userId,
      username: user.username,
      goldTipped: gold,
      ticketsAdded: ticketsGranted,
      newBalance: user.tickets,
      balance: user.tickets,
      tickets: user.tickets,
      isVip: user.isVip,
      vip: {
        active: user.isVip,
        daysLeft: user.vipExpiresAt ? Math.max(0, Math.ceil((user.vipExpiresAt - Date.now()) / (24 * 60 * 60 * 1000))) : (user.isVip ? 'Permanent' : 0),
        reward: vipReward
      },
      vipReward
    };
  }

  // Daily Claim: 1 to 10 random tickets every 24 hours
  claimDaily(userId, username = null) {
    const user = this.getUser(userId, username);
    if (!user) return { success: false, error: 'User not found' };

    const now = Date.now();
    const cooldownMs = 24 * 60 * 60 * 1000;
    const lastClaim = user.lastDailyClaim || 0;

    if (now - lastClaim < cooldownMs) {
      const remainingMs = (lastClaim + cooldownMs) - now;
      const hours = Math.floor(remainingMs / (1000 * 60 * 60));
      const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
      return {
        success: false,
        cooldown: true,
        message: `You already claimed your daily reward! Next claim available in ${hours}h ${minutes}m.`,
        remainingMs,
        remainingHours: hours,
        remainingMinutes: minutes,
        cooldownHoursRemaining: hours,
        cooldownMinutesRemaining: minutes
      };
    }

    // Roll random tickets between 1 and 10
    const reward = Math.floor(Math.random() * 10) + 1;
    user.tickets += reward;
    user.lastDailyClaim = now;

    this.logTransaction(userId, 'DAILY_REWARD', reward, `Claimed daily reward (${reward} tickets)`, user.tickets);
    this.saveState();

    console.log(`🎁 [Economy Daily] User ${user.username} (${userId}) claimed daily: +${reward} Tickets (Balance: ${user.tickets})`);

    return {
      success: true,
      reward,
      ticketsWon: reward,
      newBalance: user.tickets,
      balance: user.tickets,
      tickets: user.tickets,
      message: `🎉 You claimed your daily reward and received ${reward} ticket${reward > 1 ? 's' : ''}! Current balance: ${user.tickets} tickets.`
    };
  }

  // Song Request verification
  // Rules: Regular song = 1 ticket, Dedication = 3 tickets, VIP = 0 tickets (Free)
  checkSongRequest(userId, isDedication = false, isExempt = false) {
    if (!userId) {
      // If no userId is attached to the request, allow as guest/system
      return { allowed: true, cost: 0, isVip: false };
    }

    const user = this.getUser(userId);
    const isVip = this.isUserVip(userId);
    const cost = isDedication ? (CONFIG.DEDICATION_COST_TICKETS || 3) : (CONFIG.SONG_COST_TICKETS || 1);

    if (isVip) {
      return {
        allowed: true,
        cost: 0,
        originalCost: cost,
        isVip: true,
        balance: user.tickets,
        reason: 'VIP pass: unlimited free song requests!'
      };
    }

    if (user.tickets >= cost) {
      return {
        allowed: true,
        cost,
        isVip: false,
        balance: user.tickets,
        remainingAfter: user.tickets - cost
      };
    }

    // Admin / Owner free fallback if balance < cost
    if (isExempt) {
      return {
        allowed: true,
        cost: 0,
        originalCost: cost,
        isVip: false,
        isExempt: true,
        balance: user.tickets,
        reason: 'Room Owner / Admin free request bypass'
      };
    }

    return {
      allowed: false,
      cost,
      isVip: false,
      balance: user.tickets,
      needed: cost - user.tickets,
      error: `Insufficient tickets! This request requires ${cost} ticket${cost > 1 ? 's' : ''} (you have ${user.tickets}). Tip gold or use /daily to get tickets!`
    };
  }

  // Deduct song request cost after song is validated
  chargeSongRequest(userId, isDedication = false, songTitle = 'Song', isExempt = false) {
    if (!userId) return true;
    const check = this.checkSongRequest(userId, isDedication, isExempt);
    if (!check.allowed) return false;

    const user = this.getUser(userId);
    user.songsPlayed += 1;

    if (check.isVip || check.cost === 0) {
      this.logTransaction(userId, check.isVip ? 'VIP_PLAY' : 'EXEMPT_PLAY', 0, `${check.isVip ? 'VIP' : 'Admin'} play: "${songTitle}"`, user.tickets);
      this.saveState();
      return true;
    }

    const deducted = this.deductTickets(userId, check.cost, `Song request: "${songTitle}"`);
    return deducted;
  }

  // Admin VIP assignment
  setVip(userId, isVip = true, durationDays = 0, username = null) {
    const user = this.getUser(userId, username);
    user.isVip = Boolean(isVip);

    if (user.isVip) {
      const days = Number(durationDays) || 0;
      if (days > 0) {
        user.vipExpiresAt = Date.now() + (days * 24 * 60 * 60 * 1000);
      } else {
        user.vipExpiresAt = null; // Permanent
      }
    } else {
      user.vipExpiresAt = null;
    }

    this.logTransaction(userId, 'VIP_SET', 0, `VIP set to ${user.isVip} (expires: ${user.vipExpiresAt})`, user.tickets);
    this.saveState();
    return {
      userId: user.userId,
      username: user.username,
      isVip: user.isVip,
      vipExpiresAt: user.vipExpiresAt
    };
  }

  // Buy VIP using tickets (Tiered: 100 tickets = 7d, 200 = 15d, 300 = 60d / 2 months)
  buyVip(userId, tierOrTickets = null, durationDays = null) {
    const user = this.getUser(userId);
    if (!user) return { success: false, error: 'User not found' };

    let cost = 100;
    let days = 7;
    let label = '7 Days VIP';

    // Allow custom override if both cost & days provided
    if (tierOrTickets !== null && durationDays !== null) {
      cost = Number(tierOrTickets);
      days = Number(durationDays);
      label = `${days} Days VIP`;
    } else if (tierOrTickets !== null) {
      const input = String(tierOrTickets).toLowerCase().trim();
      if (input === '3' || input === '300' || input === '60' || input === '2m' || input === '2months') {
        cost = 300;
        days = 60;
        label = '2 Months (60 Days) VIP';
      } else if (input === '2' || input === '200' || input === '15' || input === '15d') {
        cost = 200;
        days = 15;
        label = '15 Days VIP';
      } else {
        cost = 100;
        days = 7;
        label = '7 Days VIP';
      }
    }

    if (user.tickets < cost) {
      return {
        success: false,
        error: `Insufficient tickets for ${label}! Cost: ${cost} tickets. Your balance: ${user.tickets} tickets.`,
        cost,
        balance: user.tickets,
        needed: cost - user.tickets,
        availableTiers: VIP_TIERS
      };
    }

    user.tickets -= cost;
    this.grantVipDays(user, days);

    this.logTransaction(userId, 'BUY_VIP', cost, `Purchased ${label} for ${cost} tickets`, user.tickets);
    this.saveState();

    return {
      success: true,
      userId: user.userId,
      username: user.username,
      tier: label,
      daysGranted: days,
      costPaid: cost,
      newBalance: user.tickets,
      isVip: true,
      vipExpiresAt: user.vipExpiresAt
    };
  }

  // Top leaderboard (by tickets or tipped gold)
  getLeaderboard(limit = 10) {
    return Object.values(this.data.users)
      .sort((a, b) => (b.totalTippedGold || 0) - (a.totalTippedGold || 0) || (b.tickets || 0) - (a.tickets || 0))
      .slice(0, limit)
      .map(u => ({
        userId: u.userId,
        username: u.username,
        tickets: u.tickets,
        isVip: u.isVip,
        totalTippedGold: u.totalTippedGold,
        songsPlayed: u.songsPlayed
      }));
  }

  logTransaction(userId, type, amount, details, balanceAfter) {
    if (!this.data.transactions) this.data.transactions = [];
    this.data.transactions.unshift({
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId,
      type,
      amount,
      details,
      balanceAfter,
      timestamp: Date.now()
    });

    // Keep recent 200 transactions
    if (this.data.transactions.length > 200) {
      this.data.transactions.length = 200;
    }
  }
}
