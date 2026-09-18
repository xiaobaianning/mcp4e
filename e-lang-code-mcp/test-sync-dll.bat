@echo off
setlocal
cd /d "%~dp0"
set "OUT=%~dp0dll-sync-output.txt"
node scripts\test-sync-dll.mjs > "%OUT%" 2>&1
type "%OUT%"
echo.
echo Output file: %OUT%
pause
