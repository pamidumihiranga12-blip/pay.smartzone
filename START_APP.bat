@echo off
title SmartZone Pay - SMARTZONE LK
echo ========================================================
echo   Starting SmartZone Pay App & Server (SMARTZONE LK)...
echo ========================================================

cd /d "%~dp0"
start "" http://localhost:5000
node server/index.js
pause
