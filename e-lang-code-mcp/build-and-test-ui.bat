@echo off
setlocal
cd /d "%~dp0"
set "OUT=%~dp0ui-test-output.txt"
echo == build == > "%OUT%"
pushd server
call npm run build >> "%OUT%" 2>&1
echo == bundle == >> "%OUT%"
call npm run bundle >> "%OUT%" 2>&1
popd
echo == test-ui == >> "%OUT%"
node scripts\test-ui.mjs >> "%OUT%" 2>&1
echo == done == >> "%OUT%"
type "%OUT%"
echo.
echo Output file: %OUT%
pause
