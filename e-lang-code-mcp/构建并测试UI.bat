@echo off
setlocal
cd /d "%~dp0"
set "OUT=%~dp0ui-test-output.txt"

echo === build (tsc) === > "%OUT%"
pushd server
call npm run build >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo === bundle (esbuild) === >> "%OUT%"
call npm run bundle >> "%OUT%" 2>&1
popd
echo. >> "%OUT%"
echo === test-ui === >> "%OUT%"
node scripts\test-ui.mjs >> "%OUT%" 2>&1
echo. >> "%OUT%"
echo === done === >> "%OUT%"

type "%OUT%"
echo.
echo 输出已写入: %OUT%
pause
