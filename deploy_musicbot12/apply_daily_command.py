import sys

# 1. Update systems/economy/economy_manager.py
econ_mgr_file = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/systems/economy/economy_manager.py'
with open(econ_mgr_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Add self.daily_file and daily_claims to __init__
old_init = """    def __init__(self, balance_file="systems/economy/data/user_balances.json"):
        self.balance_file = balance_file
        self.balances = {}  # In-memory cache: {user_id: points}
        self.lock = asyncio.Lock()  # For thread-safe operations
        self.load_balances()"""

new_init = """    def __init__(self, balance_file="systems/economy/data/user_balances.json", daily_file="systems/economy/data/daily_claims.json"):
        self.balance_file = balance_file
        self.daily_file = daily_file
        self.balances = {}  # In-memory cache: {user_id: points}
        self.daily_claims = {}  # {user_id: {"timestamp": float, "amount": int, "username": str}}
        self.lock = asyncio.Lock()  # For thread-safe operations
        self.load_balances()
        self.load_daily_claims()"""

if old_init in content:
    content = content.replace(old_init, new_init)
    print("Patched __init__ in economy_manager.py")
else:
    print("Could not find old_init in economy_manager.py")

# Add load_daily_claims, save_daily_claims, and claim_daily methods
daily_methods = """
    def load_daily_claims(self):
        \"\"\"Load daily claims from file\"\"\"
        try:
            if os.path.exists(self.daily_file):
                with open(self.daily_file, 'r', encoding='utf-8') as f:
                    self.daily_claims = json.load(f)
                print(f"✅ Loaded {len(self.daily_claims)} daily claim records")
            else:
                self.daily_claims = {}
        except Exception as e:
            print(f"⚠️ Error loading daily claims: {e}")
            self.daily_claims = {}

    def save_daily_claims(self):
        \"\"\"Save daily claims to file\"\"\"
        try:
            Path(self.daily_file).parent.mkdir(parents=True, exist_ok=True)
            with open(self.daily_file, 'w', encoding='utf-8') as f:
                json.dump(self.daily_claims, f, indent=2)
            return True
        except Exception as e:
            print(f"❌ Error saving daily claims: {e}")
            return False

    async def claim_daily(self, user_id, username=""):
        \"\"\"
        Claim daily tickets (10 to 50 tickets once every 24 hours).
        Returns tuple: (success, tickets_awarded, new_balance, remaining_seconds)
        \"\"\"
        import time
        import random
        
        async with self.lock:
            user_id_str = str(user_id)
            now = time.time()
            cooldown = 86400  # 24 hours in seconds
            
            if user_id_str in self.daily_claims:
                last_claim_time = self.daily_claims[user_id_str].get("timestamp", 0)
                time_passed = now - last_claim_time
                if time_passed < cooldown:
                    remaining = cooldown - time_passed
                    current_balance = self.balances.get(user_id_str, 0)
                    return False, 0, current_balance, remaining
            
            # Award random tickets between 10 and 50
            tickets = random.randint(10, 50)
            
            # Add to balance
            current = self.balances.get(user_id_str, 0)
            self.balances[user_id_str] = current + tickets
            self.save_balances()
            new_balance = self.balances[user_id_str]
            
            # Record claim
            self.daily_claims[user_id_str] = {
                "timestamp": now,
                "amount": tickets,
                "username": username or ""
            }
            self.save_daily_claims()
            
            write_economy_log(user_id, "daily", tickets, new_balance, f"Daily reward (+{tickets} tickets)")
            print(f"🎁 User {user_id} ({username}) claimed daily reward: +{tickets} tickets. New balance: {new_balance}")
            
            return True, tickets, new_balance, 0
"""

if "def claim_daily" not in content:
    content += daily_methods
    with open(econ_mgr_file, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Added daily methods to economy_manager.py")
else:
    print("Daily methods already exist in economy_manager.py")


# 2. Update systems/economy/economy_commands.py
econ_cmds_file = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/systems/economy/economy_commands.py'
with open(econ_cmds_file, 'r', encoding='utf-8') as f:
    cmd_content = f.read()

daily_cmd_code = """
    @bot.command("daily", "claim")
    async def daily_cmd(bot, user, message):
        remaining_cd = check_cd(user.id, "daily_cmd", 3)
        if remaining_cd > 0:
            await bot.send_message(MessageFormatter.cooldown(remaining_cd), user.id)
            return
        
        success, tickets, balance, remaining_sec = await bot.economy.claim_daily(user.id, user.username)
        
        if not success:
            hours = int(remaining_sec // 3600)
            mins = int((remaining_sec % 3600) // 60)
            msg = (
                f"{Colors.ORANGE}⏳ Daily already claimed!\\n"
                f"{Colors.LIGHT_GRAY}Next reward in: {Colors.GOLD}{hours}h {mins}m\\n"
                f"{Colors.SKY_BLUE}🎟️ Balance: {Colors.GOLD}{balance} pts"
            )
            await bot.send_message(msg, user.id)
        else:
            msg = (
                f"{Colors.GOLD}🎁 {Colors.PINK}@{user.username} {Colors.MINT}claimed their daily reward!\\n"
                f"{Colors.YELLOW}🎟️ +{tickets} tickets {Colors.LIGHT_GRAY}• {Colors.GOLD}{balance} total pts\\n"
                f"{Colors.SKY_BLUE}💡 Use /daily once every 24 hours!"
            )
            await bot.highrise.chat(msg)
"""

if "@bot.command(\"daily\"" not in cmd_content:
    # Insert right before the last closing of register or end of file
    target = '    @bot.command("costs", "prices")'
    if target in cmd_content:
        cmd_content = cmd_content.replace(target, daily_cmd_code + "\n" + target)
        with open(econ_cmds_file, 'w', encoding='utf-8') as f:
            f.write(cmd_content)
        print("Registered @bot.command('daily', 'claim') in economy_commands.py")
    else:
        print("Could not find target to insert daily_cmd")
else:
    print("@bot.command('daily') already registered")


# 3. Update COMMANDS.md
cmds_md = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/COMMANDS.md'
with open(cmds_md, 'r', encoding='utf-8') as f:
    md_content = f.read()

if '/daily' not in md_content:
    md_content = md_content.replace(
        '### Point & Economy Commands',
        '### Point & Economy Commands\n- `/daily` or `/claim` - Claim 10-50 free tickets once every 24 hours'
    )
    with open(cmds_md, 'w', encoding='utf-8') as f:
        f.write(md_content)
    print("Updated COMMANDS.md with /daily")


# 4. Update BOT_COMMANDS.txt
bot_cmds_txt = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/BOT_COMMANDS.txt'
with open(bot_cmds_txt, 'r', encoding='utf-8') as f:
    txt_content = f.read()

if '!daily' not in txt_content:
    txt_content = txt_content.replace(
        '=== ECONOMY COMMANDS ===',
        '=== ECONOMY COMMANDS ===\n!daily                   - Claim 10-50 random tickets once every 24 hours'
    )
    with open(bot_cmds_txt, 'w', encoding='utf-8') as f:
        f.write(txt_content)
    print("Updated BOT_COMMANDS.txt with !daily")
