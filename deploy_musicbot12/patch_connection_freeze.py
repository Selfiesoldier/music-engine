import os

conn_mgr_path = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/core/connection_manager.py'
if os.path.exists(conn_mgr_path):
    with open(conn_mgr_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Remove the blocking started_event.wait() so restart can fire even during startup
    old_wait = """        # Wait for connection manager to be fully started
        await self.started_event.wait()
        
        # Now wait for restart event to be set
        await self.restart_event.wait()"""

    new_wait = """        # Wait for restart event to be set (no dependency on started_event)
        await self.restart_event.wait()"""

    if old_wait in content:
        content = content.replace(old_wait, new_wait)
        with open(conn_mgr_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print("✅ Fixed connection_manager.py: removed blocking started_event.wait()")
    else:
        print("⚠️ Pattern not found in connection_manager.py")

main_path = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/main.py'
if os.path.exists(main_path):
    with open(main_path, 'r', encoding='utf-8') as f:
        m_content = f.read()

    # 2. Add timeout to fetch_inventory and sync_from_highrise so they never hang on disconnected socket
    if "success = await self.inventory_manager.fetch_inventory(self.highrise)" in m_content:
        m_content = m_content.replace(
            "success = await self.inventory_manager.fetch_inventory(self.highrise)",
            "success = await asyncio.wait_for(self.inventory_manager.fetch_inventory(self.highrise), timeout=8.0)"
        )
        print("✅ Added timeout to fetch_inventory in main.py")

    if "await self.outfit_manager.sync_from_highrise(self.highrise)" in m_content:
        m_content = m_content.replace(
            "await self.outfit_manager.sync_from_highrise(self.highrise)",
            "await asyncio.wait_for(self.outfit_manager.sync_from_highrise(self.highrise), timeout=8.0)"
        )
        print("✅ Added timeout to sync_from_highrise in main.py")

    with open(main_path, 'w', encoding='utf-8') as f:
        f.write(m_content)
    print("✅ main.py patched successfully!")
