@echo off
setlocal
cd /d "%~dp0"

echo Testing bridge: ide.status ...
echo.
node ".\scripts\bridge-call.mjs" ide.status
echo.

echo If it failed, check:
echo   1. EasyLanguage is running
echo   2. "EasyLanguage MCP" support library is checked in Tools - Support Library Config
echo   3. EasyLanguage was restarted after installing
echo   4. a saved project is open in EasyLanguage
echo.
pause
