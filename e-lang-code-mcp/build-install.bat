@echo off
setlocal
cd /d "%~dp0"
set "OUT=%~dp0build-install-output.txt"
echo == build == > "%OUT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-native.ps1" -EasyLangRoot "D:\software\eyy" >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo == server bundle == >> "%OUT%"
pushd server
call npm run bundle >> "%OUT%" 2>&1
popd
echo. >> "%OUT%"
echo == install == >> "%OUT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -EasyLangRoot "D:\software\eyy" -Force >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo == done == >> "%OUT%"
type "%OUT%"
echo.
echo Output file: %OUT%
pause
