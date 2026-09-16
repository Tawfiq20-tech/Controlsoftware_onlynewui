@echo off
setlocal enabledelayedexpansion
title Onefinity Sender - Vertical Pendant

cd /d "%~dp0"

echo ============================================================
echo  Onefinity Sender - Vertical Frontend (Port 3001)
echo ============================================================
echo.

set "NODE_CMD=runtime\node.exe"
if not exist "!NODE_CMD!" set "NODE_CMD=node"

echo Starting Vertical frontend at http://localhost:3001 ...
echo.

start "" !NODE_CMD! scripts\serve-frontend.js --vertical

timeout /t 1 /nobreak >nul

rem Try launching Microsoft Edge / Chrome in standalone app mode with window size resembling portrait
set "LAUNCHED="
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if not defined LAUNCHED if exist %%P (
        start "" %%P --app=http://localhost:3001 --window-size=680,1080
        set "LAUNCHED=1"
    )
)

if not defined LAUNCHED (
    start http://localhost:3001
)

echo Frontend is running. Close this window to keep background server active or press any key to exit.
