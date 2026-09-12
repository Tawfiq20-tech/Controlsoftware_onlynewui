@echo off
setlocal
title Enable CNC Local Remote Access (Firewall Setup)

echo ============================================================
echo   CNC Control Software - Local Network Access Setup
echo ============================================================
echo.

rem Check for administrative privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Administrative privileges required to configure Windows Firewall.
    echo Requesting elevation...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo [1/2] Adding Windows Firewall rule for Port 4000 (TCP Inbound)...
netsh advfirewall firewall delete rule name="CNC Control Software Port 4000" >nul 2>&1
netsh advfirewall firewall add rule name="CNC Control Software Port 4000" dir=in action=allow protocol=TCP localport=4000 profile=any >nul
if %errorlevel% equ 0 (
    echo   [OK] Port 4000 rule added successfully for Private, Public, and Domain profiles.
) else (
    echo   [ERROR] Failed to add port 4000 firewall rule.
)

echo [2/2] Adding Windows Firewall rule for bundled Node.js runtime...
set "RUNTIME_NODE=%~dp0..\runtime\node.exe"
if exist "%RUNTIME_NODE%" (
    netsh advfirewall firewall delete rule name="CNC Control Software Runtime" >nul 2>&1
    netsh advfirewall firewall add rule name="CNC Control Software Runtime" dir=in action=allow program="%RUNTIME_NODE%" profile=any >nul
    echo   [OK] Node.js runtime rule added successfully.
) else (
    echo   [NOTE] Bundled runtime\node.exe not found at standard path, skipping binary rule.
)

echo.
echo ============================================================
echo   Setup Complete!
echo   Devices on your local Wi-Fi can now connect to port 4000.
echo ============================================================
echo.
pause
