import os

main_path = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main/main.py'
if os.path.exists(main_path):
    with open(main_path, 'r', encoding='utf-8') as f:
        m_content = f.read()

    # 1. Add timeout to fetch_inventory
    target1 = "success = await self.inventory_manager.fetch_inventory(self.highrise)"
    replace1 = "success = await asyncio.wait_for(self.inventory_manager.fetch_inventory(self.highrise), timeout=6.0)"
    if target1 in m_content:
        m_content = m_content.replace(target1, replace1)
        print("Updated fetch_inventory timeout")

    # 2. Add timeout to sync_from_highrise
    target2 = "await self.outfit_manager.sync_from_highrise(self.highrise)"
    replace2 = "await asyncio.wait_for(self.outfit_manager.sync_from_highrise(self.highrise), timeout=6.0)"
    if target2 in m_content:
        m_content = m_content.replace(target2, replace2)
        print("Updated sync_from_highrise timeout")

    with open(main_path, 'w', encoding='utf-8') as f:
        f.write(m_content)
    print("main.py updated successfully")
