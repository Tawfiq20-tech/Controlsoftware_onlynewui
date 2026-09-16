@echo off
setlocal enabledelayedexpansion
title Onefinity Sender - Dual Layout (Horizontal + Vertical)

cd /d "%~dp0"

echo ============================================================
echo  Onefinity Sender - Dual Frontend (Ports 3000 & 3001)
echo ============================================================
echo.

set "NODE_CMD=runtime\node.exe"
if not exist "!NODE_CMD!" set "NODE_CMD=node"

echo Starting both Horizontal (3000) and Vertical (3001) servers...
start "" !NODE_CMD! scripts\serve-frontend.js --all

timeout /t 1 /nobreak >nul

rem Launch Horizontal App Window
set "LAUNCHED_H="
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if not defined LAUNCHED_H if exist %%P (
        start "" %%P --app=http://localhost:3000 --window-size=1280,800
        set "LAUNCHED_H=1"
    )
)
if not defined LAUNCHED_H start http://localhost:3000

rem Launch Vertical App Window
set "LAUNCHED_V="
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if not defined LAUNCHED_V if exist %%P (
        start "" %%P --app=http://localhost:3001 --window-size=680,1080
        set "LAUNCHED_V=1"
    )
)
if not defined LAUNCHED_V start http://localhost:3001

echo Both servers are active.
echo Horizontal: http://localhost:3000
echo Vertical:   http://localhost:3001
