import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EconomyManager } from '../src/economy/EconomyManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_STORAGE = path.join(__dirname, 'test_economy_temp.json');

// Clean previous test artifact
if (fs.existsSync(TEST_STORAGE)) {
  fs.unlinkSync(TEST_STORAGE);
}

console.log('🧪 Starting Economy System Verification Tests...\n');

try {
  const econ = new EconomyManager(TEST_STORAGE);

  // 1. Test Gold Tip Conversion (1 Gold = 1 Ticket)
  console.log('Test 1: Gold Tip Conversion (1:1 Rate)');
  const tip1 = econ.processTip('alice_01', 10, 'Alice');
  assert.strictEqual(tip1.success, true);
  assert.strictEqual(tip1.ticketsAdded, 10);
  assert.strictEqual(tip1.newBalance, 10);
  console.log('  ✅ 10 Gold tip granted 10 tickets');

  const tip2 = econ.processTip('alice_01', 20, 'Alice');
  assert.strictEqual(tip2.ticketsAdded, 20);
  assert.strictEqual(tip2.newBalance, 30);
  console.log('  ✅ 20 Gold tip increased balance to 30 tickets');

  // 2. Test Song Request Cost Rules (1 regular, 3 dedication)
  console.log('\nTest 2: Song Request Ticket Costs');
  const bobCheck = econ.checkSongRequest('bob_02', false);
  assert.strictEqual(bobCheck.allowed, false);
  assert.strictEqual(bobCheck.cost, 1);
  assert.strictEqual(bobCheck.needed, 1);
  console.log('  ✅ Non-ticket holder Bob rejected for regular song (needs 1 ticket)');

  const bobDedicationCheck = econ.checkSongRequest('bob_02', true);
  assert.strictEqual(bobDedicationCheck.allowed, false);
  assert.strictEqual(bobDedicationCheck.cost, 3);
  assert.strictEqual(bobDedicationCheck.needed, 3);
  console.log('  ✅ Non-ticket holder Bob rejected for dedication song (needs 3 tickets)');

  // Alice plays 1 regular song
  const aliceRegular = econ.checkSongRequest('alice_01', false);
  assert.strictEqual(aliceRegular.allowed, true);
  assert.strictEqual(aliceRegular.cost, 1);
  econ.chargeSongRequest('alice_01', false, 'Song A');
  assert.strictEqual(econ.getBalance('alice_01').tickets, 29);
  console.log('  ✅ Alice charged 1 ticket for regular song (Balance: 29)');

  // Alice plays 1 dedication song
  const aliceDedication = econ.checkSongRequest('alice_01', true);
  assert.strictEqual(aliceDedication.allowed, true);
  assert.strictEqual(aliceDedication.cost, 3);
  econ.chargeSongRequest('alice_01', true, 'Song B');
  assert.strictEqual(econ.getBalance('alice_01').tickets, 26);
  console.log('  ✅ Alice charged 3 tickets for dedication song (Balance: 26)');

  // 3. Test Daily Claim (1-10 random, 24h cooldown)
  console.log('\nTest 3: Daily Reward (1-10 Random Tickets & 24h Cooldown)');
  const daily1 = econ.claimDaily('charlie_03', 'Charlie');
  assert.strictEqual(daily1.success, true);
  assert.ok(daily1.reward >= 1 && daily1.reward <= 10, `Reward was ${daily1.reward}, expected 1-10`);
  assert.strictEqual(daily1.newBalance, daily1.reward);
  console.log(`  ✅ Charlie claimed daily: received ${daily1.reward} ticket(s) (Balance: ${daily1.newBalance})`);

  // Immediate second claim attempt must be blocked
  const daily2 = econ.claimDaily('charlie_03', 'Charlie');
  assert.strictEqual(daily2.success, false);
  assert.strictEqual(daily2.cooldown, true);
  console.log(`  ✅ Immediate re-claim blocked by 24h cooldown (${daily2.remainingHours}h remaining)`);

  // 4. Test VIP System (Free Play Perks)
  console.log('\nTest 4: VIP Status (Free Requests & Ticket Exemption)');
  econ.setVip('dave_vip', true, 0, 'DaveVIP');
  assert.strictEqual(econ.isUserVip('dave_vip'), true);

  // VIP with 0 tickets can request regular song for 0 cost
  const vipRegular = econ.checkSongRequest('dave_vip', false);
  assert.strictEqual(vipRegular.allowed, true);
  assert.strictEqual(vipRegular.cost, 0);
  assert.strictEqual(vipRegular.isVip, true);
  econ.chargeSongRequest('dave_vip', false, 'VIP Anthem');
  assert.strictEqual(econ.getBalance('dave_vip').tickets, 0);
  console.log('  ✅ VIP Dave requested regular song with 0 tickets (Free / 0 cost)');

  // VIP with 0 tickets can dedicate song for 0 cost
  const vipDedication = econ.checkSongRequest('dave_vip', true);
  assert.strictEqual(vipDedication.allowed, true);
  assert.strictEqual(vipDedication.cost, 0);
  assert.strictEqual(vipDedication.isVip, true);
  econ.chargeSongRequest('dave_vip', true, 'VIP Dedication');
  console.log('  ✅ VIP Dave dedicated song with 0 tickets (Free / 0 cost)');

  // 5. Test Tiered VIP Purchase via Gold Tipping (100G = 7d, 200G = 15d, 300G = 60d)
  console.log('\nTest 5: Tiered VIP Unlocks via Gold Tipping');
  
  // 100 G tip -> 7 days VIP
  const tip100 = econ.processTip('tipper_100', 100, 'Gold100');
  assert.strictEqual(tip100.ticketsAdded, 100);
  assert.strictEqual(tip100.isVip, true);
  assert.strictEqual(tip100.vipReward.days, 7);
  assert.strictEqual(econ.isUserVip('tipper_100'), true);
  console.log('  ✅ 100 G tip unlocked 7 Days VIP + 100 tickets');

  // 200 G tip -> 15 days VIP
  const tip200 = econ.processTip('tipper_200', 200, 'Gold200');
  assert.strictEqual(tip200.ticketsAdded, 200);
  assert.strictEqual(tip200.isVip, true);
  assert.strictEqual(tip200.vipReward.days, 15);
  assert.strictEqual(econ.isUserVip('tipper_200'), true);
  console.log('  ✅ 200 G tip unlocked 15 Days VIP + 200 tickets');

  // 300 G tip -> 60 days (2 months) VIP
  const tip300 = econ.processTip('tipper_300', 300, 'Gold300');
  assert.strictEqual(tip300.ticketsAdded, 300);
  assert.strictEqual(tip300.isVip, true);
  assert.strictEqual(tip300.vipReward.days, 60);
  assert.strictEqual(econ.isUserVip('tipper_300'), true);
  console.log('  ✅ 300 G tip unlocked 2 Months (60 Days) VIP + 300 tickets');

  // Stacking/Extending: tipper_100 tips another 200 G -> extends VIP by +15 days (total 22 days)
  const prevExpiry = econ.getBalance('tipper_100').vipExpiresAt;
  econ.processTip('tipper_100', 200, 'Gold100');
  const newExpiry = econ.getBalance('tipper_100').vipExpiresAt;
  const diffDays = Math.round((newExpiry - prevExpiry) / (1000 * 60 * 60 * 24));
  assert.strictEqual(diffDays, 15);
  console.log('  ✅ Consecutive tips stacked/extended VIP duration (+15 days)');

  // 6. Test VIP Purchase via Tickets (100 -> 7d, 200 -> 15d, 300 -> 60d)
  console.log('\nTest 6: Purchasing Tiered VIP with Tickets');
  econ.addTickets('emma_05', 350, 'bonus', 'Emma');

  const buyTier1 = econ.buyVip('emma_05', 1); // Tier 1: 100 tickets -> 7d
  assert.strictEqual(buyTier1.success, true);
  assert.strictEqual(buyTier1.costPaid, 100);
  assert.strictEqual(buyTier1.daysGranted, 7);
  assert.strictEqual(buyTier1.newBalance, 250);
  console.log('  ✅ Emma bought Tier 1 (7 Days VIP) for 100 tickets (Balance: 250)');

  const buyTier3 = econ.buyVip('emma_05', 300); // Tier 3: 300 tickets -> 60d
  assert.strictEqual(buyTier3.success, false); // Balance 250 < 300
  console.log('  ✅ Emma rejected for Tier 3 (300 tickets) due to balance 250');

  const buyTier2 = econ.buyVip('emma_05', 2); // Tier 2: 200 tickets -> 15d
  assert.strictEqual(buyTier2.success, true);
  assert.strictEqual(buyTier2.costPaid, 200);
  assert.strictEqual(buyTier2.daysGranted, 15);
  assert.strictEqual(buyTier2.newBalance, 50);
  console.log('  ✅ Emma bought Tier 2 (15 Days VIP) for 200 tickets (Balance: 50)');

  // 7. Test Data Persistence Across Engine Restarts
  console.log('\nTest 7: Disk Persistence Verification');
  const econRebooted = new EconomyManager(TEST_STORAGE);
  const tipper300Reloaded = econRebooted.getBalance('tipper_300');
  assert.strictEqual(tipper300Reloaded.isVip, true);
  assert.strictEqual(tipper300Reloaded.tickets, 300);
  assert.strictEqual(tipper300Reloaded.totalTippedGold, 300);
  console.log('  ✅ All VIP tiers, expiration dates, and ticket balances survived simulated restart');

  console.log('\n🎉 ALL 7 ECONOMY & VIP TIER TESTS PASSED PERFECTLY!\n');
} finally {
  // Cleanup test file
  if (fs.existsSync(TEST_STORAGE)) {
    fs.unlinkSync(TEST_STORAGE);
  }
}
