import re

# 1. Patch systems/position/position_manager.py
pos_mgr_file = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/systems/position/position_manager.py'
with open(pos_mgr_file, 'r', encoding='utf-8') as f:
    content = f.read()

if 'import asyncio' not in content:
    content = 'import asyncio\n' + content

old_move = """    @staticmethod
    async def move_bot_to(bot, destination: PositionType) -> bool:
        \"\"\"Move the bot to a Position or AnchorPosition safely.\"\"\"
        if not bot or not bot.bot_user_id or not destination:
            return False
        
        if isinstance(destination, AnchorPosition):
            try:
                await bot.highrise.walk_to(destination)
                return True
            except Exception as e:
                print(f"⚠️ Failed to walk to anchor point: {e}")
                return False
        elif isinstance(destination, Position):
            try:
                await bot.highrise.teleport(bot.bot_user_id, destination)
                return True
            except Exception as e:
                try:
                    await bot.highrise.walk_to(destination)
                    return True
                except Exception as walk_e:
                    print(f"⚠️ Failed to teleport/walk to position: {e} / {walk_e}")
                    return False
        return False"""

new_move = """    @staticmethod
    async def move_bot_to(bot, destination: PositionType, retries: int = 3) -> bool:
        \"\"\"Move the bot to a Position or AnchorPosition safely with retry logic.\"\"\"
        if not bot or not bot.bot_user_id or not destination:
            return False
        
        for attempt in range(retries):
            if isinstance(destination, AnchorPosition):
                try:
                    await bot.highrise.walk_to(destination)
                    return True
                except Exception as e:
                    if attempt < retries - 1:
                        await asyncio.sleep(1.0)
                        continue
                    print(f"⚠️ Failed to walk to anchor point: {e}")
                    return False
            elif isinstance(destination, Position):
                try:
                    await bot.highrise.teleport(bot.bot_user_id, destination)
                    return True
                except Exception as e:
                    try:
                        await bot.highrise.walk_to(destination)
                        return True
                    except Exception as walk_e:
                        if attempt < retries - 1:
                            await asyncio.sleep(1.0)
                            continue
                        print(f"⚠️ Failed to teleport/walk to position: {e} / {walk_e}")
                        return False
        return False"""

if old_move in content:
    content = content.replace(old_move, new_move)
    with open(pos_mgr_file, 'w', encoding='utf-8') as f:
        f.write(content)
    print("✅ Successfully patched systems/position/position_manager.py")
else:
    print("⚠️ old_move not found in position_manager.py (may already be patched)")

# 2. Patch main.py startup docking
main_file = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/main.py'
with open(main_file, 'r', encoding='utf-8') as f:
    main_content = f.read()

old_on_start_dock = """        # Move to default position / anchor
        if self.position_manager.has_position():
            try:
                await self.position_manager.ensure_home_position(self)
                default_pos = self.position_manager.get_position()
                if isinstance(default_pos, AnchorPosition):
                    print(f"⚓ Bot anchored to furniture: {default_pos.entity_id} #{default_pos.anchor_ix}")
                elif isinstance(default_pos, Position):
                    print(f"🚶 Bot moved to default position: ({default_pos.x}, {default_pos.y}, {default_pos.z})")
            except Exception as e:
                print(f"⚠️ Failed to move to default position: {e}")"""

new_on_start_dock = """        # Move to default position / anchor with resilient startup docking
        if self.position_manager.has_position():
            async def _startup_dock():
                await asyncio.sleep(2.5)
                try:
                    await self.position_manager.ensure_home_position(self)
                    default_pos = self.position_manager.get_position()
                    if isinstance(default_pos, AnchorPosition):
                        print(f"⚓ Bot anchored to furniture: {default_pos.entity_id} #{default_pos.anchor_ix}")
                    elif isinstance(default_pos, Position):
                        print(f"🚶 Bot moved to default position: ({default_pos.x}, {default_pos.y}, {default_pos.z})")
                except Exception as e:
                    print(f"⚠️ Failed to move to default position: {e}")
            asyncio.create_task(_startup_dock())"""

if old_on_start_dock in main_content:
    main_content = main_content.replace(old_on_start_dock, new_on_start_dock)
    with open(main_file, 'w', encoding='utf-8') as f:
        f.write(main_content)
    print("✅ Successfully patched main.py startup docking")
else:
    print("⚠️ old_on_start_dock not found in main.py (may already be patched)")
