@echo off
setlocal
cd /d "%~dp0"
set "OUT=%~dp0build-output.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-native.ps1" -EasyLangRoot "D:\software\eyy" > "%OUT%" 2>&1
type "%OUT%"
echo.
echo Output file: %OUT%
pause
