@echo off
setlocal
cd /d "%~dp0"
set "OUT=%~dp0scaffold-output.txt"
node scripts\test-sync-scaffold.mjs > "%OUT%" 2>&1
type "%OUT%"
echo.
echo Output file: %OUT%
pause
