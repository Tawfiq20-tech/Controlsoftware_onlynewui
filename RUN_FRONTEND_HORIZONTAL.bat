@echo off
setlocal enabledelayedexpansion
title Onefinity Sender - Horizontal Desktop

cd /d "%~dp0"

echo ============================================================
echo  Onefinity Sender - Horizontal Frontend (Port 3000)
echo ============================================================
echo.

set "NODE_CMD=runtime\node.exe"
if not exist "!NODE_CMD!" set "NODE_CMD=node"

echo Starting Horizontal frontend at http://localhost:3000 ...
echo.

start "" !NODE_CMD! scripts\serve-frontend.js --horizontal

timeout /t 1 /nobreak >nul

rem Try launching Microsoft Edge / Chrome in standalone app mode
set "LAUNCHED="
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if not defined LAUNCHED if exist %%P (
        start "" %%P --app=http://localhost:3000
        set "LAUNCHED=1"
    )
)

if not defined LAUNCHED (
    start http://localhost:3000
)

echo Frontend is running. Close this window to keep background server active or press any key to exit.
