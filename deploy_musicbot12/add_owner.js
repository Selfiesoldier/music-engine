import fs from 'fs';
import path from 'path';

const mainDir = 'C:/Users/sanif/OneDrive/Desktop/musicbot-main';

// 1. Update admins.json
const adminsJsonPath = path.join(mainDir, 'systems/admin/data/admins.json');
if (fs.existsSync(adminsJsonPath)) {
  const admins = JSON.parse(fs.readFileSync(adminsJsonPath, 'utf8'));
  if (!admins.owners) admins.owners = [];
  if (!admins.owners.includes('_paul_sanif_')) {
    admins.owners.unshift('_paul_sanif_');
  }
  fs.writeFileSync(adminsJsonPath, JSON.stringify(admins, null, 2), 'utf8');
  console.log('✅ Updated admins.json locally with _paul_sanif_');
}

// 2. Update admin_manager.py
const adminManagerPath = path.join(mainDir, 'systems/admin/admin_manager.py');
if (fs.existsSync(adminManagerPath)) {
  let content = fs.readFileSync(adminManagerPath, 'utf8');
  content = content.replace(
    'DEFAULT_OWNERS = ["paul_sanif", "692dbdef5b2eb22b61d96993"]',
    'DEFAULT_OWNERS = ["_paul_sanif_", "paul_sanif", "692dbdef5b2eb22b61d96993"]'
  );
  content = content.replace(
    'OWNER_USERNAME = "paul_sanif"',
    'OWNER_USERNAME = "_paul_sanif_"'
  );
  fs.writeFileSync(adminManagerPath, content, 'utf8');
  console.log('✅ Updated admin_manager.py locally with _paul_sanif_');
}

// 3. Update systeminfo_manager.py
const sysInfoPath = path.join(mainDir, 'systems/systeminfo/systeminfo_manager.py');
if (fs.existsSync(sysInfoPath)) {
  let content = fs.readFileSync(sysInfoPath, 'utf8');
  content = content.replace(
    'owner_username = "paul_sanif"',
    'owner_username = "_paul_sanif_"'
  );
  fs.writeFileSync(sysInfoPath, content, 'utf8');
  console.log('✅ Updated systeminfo_manager.py locally with _paul_sanif_');
}
