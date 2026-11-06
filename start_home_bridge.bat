@echo off
title Highrise Musicbot - Residential Audio Bridge
echo ========================================================
echo   Highrise Musicbot - Home Residential Audio Bridge
echo ========================================================
set BOT_SERVER_URL=http://2.56.246.119:30195
echo Starting local bridge and Cloudflare tunnel...
node home_bridge_manager.js
pause
