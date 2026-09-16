@echo off
setlocal enabledelayedexpansion
title Onefinity Sender

rem Always run from this script's own folder, no matter where it was
rem double-clicked from (Desktop shortcut, USB stick, etc).
cd /d "%~dp0"

echo ============================================================
echo  Onefinity Sender
echo ============================================================
echo.

if not exist "runtime\node.exe" (
    echo [ERROR] runtime\node.exe not found.
    echo This package is incomplete or was extracted wrong.
    echo Re-download/re-extract the zip and try again.
    echo.
    pause
    exit /b 1
)

if not exist "backend\index.js" (
    echo [ERROR] backend\index.js not found.
    echo This package is incomplete or was extracted wrong.
    echo.
    pause
    exit /b 1
)

echo Starting backend server on http://localhost:4000 ...
echo (Leave this window open. Closing it stops the server.)
echo.

rem Check if port 4000 is already in use by an orphaned process.
rem The decision lives in the :port_busy routine below, NOT inside this if
rem block: a closing bracket inside an echo ends a bracketed block early in
rem cmd, which is what broke this file on 2026-09-16.
netstat -ano | findstr /R /C:":4000 .*LISTENING" >nul 2>&1
if not errorlevel 1 call :port_busy
if defined OFS_ABORT exit /b 1

netstat -ano | findstr /R /C:":4000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [WARNING] Port 4000 is currently in use by an existing process.
    echo Freeing port 4000 to ensure a clean start...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":4000 .*LISTENING"') do (
        taskkill /F /T /PID %%a
    )
    ping 127.0.0.1 -n 2 >nul

    rem Targeted kill can fail (a second RUN.bat window still open re-grabs
    rem the port the instant it's freed, a PID already gone by the time
    rem taskkill runs, etc.) -- 2026-09-09 Tawfiq hit exactly this, the
    rem original >nul 2>&1 swallowed the failure silently and left him
    rem staring at "port already in use" with no clue why. Re-check, and if
    rem still occupied, fall back to killing every node.exe (this package
    rem ships its own runtime\node.exe and isn't expected to share the
    rem machine with an unrelated Node app) instead of just failing.
    netstat -ano | findstr /R /C:":4000 .*LISTENING" >nul 2>&1
    if not errorlevel 1 (
        echo [WARNING] Port 4000 still in use after targeted kill.
        echo Stopping all node.exe processes to recover...
        taskkill /F /IM node.exe
        ping 127.0.0.1 -n 2 >nul
    )
)

"runtime\node.exe" "backend\index.js"

echo.
echo ============================================================
echo  Server stopped (exit code %errorlevel%).
echo  If this was unexpected, see README.txt "DEBUG" section.
echo ============================================================
pause
exit /b 0

rem ----------------------------------------------------------------------
rem Something is already listening on port 4000. If it is the sender and it
rem is CARVING, killing it kills the carve: the controller stops hearing
rem from the PC and stops the machine on its own 5 second watchdog, in the
rem middle of the cut. That is what happened on 2026-09-15 at 19:18, when a
rem second RUN.bat was double-clicked during a job.
rem Nothing is killed here unless the running sender explicitly answers that
rem no job is active. A missing curl, a timeout, an older sender without the
rem check, or another program on the port all stop and ask the operator.
rem ----------------------------------------------------------------------
:port_busy
set "OFS_JOBSTATE=%TEMP%\ofs_jobactive.txt"
del "%OFS_JOBSTATE%" >nul 2>&1
curl -s -m 5 -o "%OFS_JOBSTATE%" http://127.0.0.1:4000/api/job/active >nul 2>&1
if not exist "%OFS_JOBSTATE%" goto :port_busy_ask
findstr /C:"\"active\":true" "%OFS_JOBSTATE%" >nul 2>&1
if not errorlevel 1 goto :port_busy_carving
findstr /C:"\"active\":false" "%OFS_JOBSTATE%" >nul 2>&1
if not errorlevel 1 goto :port_busy_idle
goto :port_busy_ask

:port_busy_idle
del "%OFS_JOBSTATE%" >nul 2>&1
echo The sender already running reports the machine is idle - restarting it.
goto :eof

:port_busy_carving
del "%OFS_JOBSTATE%" >nul 2>&1
echo ============================================================
echo  A CARVE IS RUNNING RIGHT NOW
echo ============================================================
echo.
echo  The sender is already open and the machine is cutting. Starting a
echo  second copy would stop the machine in the middle of the cut.
echo.
echo  Use the sender that is already open:
echo      http://localhost:4000
echo.
echo  To stop the carve, press STOP there first, then run this again.
echo.
start "" "http://localhost:4000"
set "OFS_ABORT=1"
pause
goto :eof

:port_busy_ask
del "%OFS_JOBSTATE%" >nul 2>&1
echo ============================================================
echo  SOMETHING IS ALREADY USING PORT 4000
echo ============================================================
echo.
echo  It did not say whether the machine is idle. It may be an older
echo  version of the sender, or another program using the same port.
echo.
echo  If a carve is running, stopping it now would stop the machine
echo  mid-cut. Check the sender first:
echo      http://localhost:4000
echo.
start "" "http://localhost:4000"
echo  If nothing is carving and you want to restart it, type  Y  and
echo  press Enter. Press Enter on its own to leave it alone.
echo.
set "OFS_FORCE="
set /p OFS_FORCE=Your choice:
if /I "%OFS_FORCE%"=="Y" goto :port_busy_forced
echo Leaving the running sender alone.
set "OFS_ABORT=1"
pause
goto :eof

:port_busy_forced
echo Freeing port 4000 at your request...
goto :eof
