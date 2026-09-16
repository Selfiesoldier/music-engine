@echo off
title Highrise Musicbot - Residential Audio Bridge
echo ========================================================
echo   Highrise Musicbot - Home Residential Audio Bridge
echo ========================================================
set BOT_SERVER_URL=http://92.118.206.166:30139
echo Starting local bridge and Cloudflare tunnel...
node home_bridge_manager.js
pause
