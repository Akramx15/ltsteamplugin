@echo off
setlocal enableextensions

set "HELPER=%~dp0restart_steam.ps1"
if not exist "%HELPER%" exit /b 2

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%HELPER%"
exit /b %errorlevel%
