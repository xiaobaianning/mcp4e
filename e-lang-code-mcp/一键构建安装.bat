@echo off
setlocal
set "EASY_LANG_ROOT=D:\software\eyy"
set "REPO=%~dp0"
cd /d "%REPO%"

echo ============================================
echo  [1/3] Building FNE support library...
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%scripts\build-native.ps1" -EasyLangRoot "%EASY_LANG_ROOT%"
if errorlevel 1 goto fail

echo.
echo ============================================
echo  [2/3] Building MCP server (npm)...
echo ============================================
pushd "%REPO%server"
call npm install
if errorlevel 1 (popd & goto fail)
call npm run bundle
if errorlevel 1 (popd & goto fail)
popd

echo.
echo ============================================
echo  [3/3] Installing FNE and registering MCP...
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%scripts\install.ps1" -EasyLangRoot "%EASY_LANG_ROOT%" -Force
if errorlevel 1 goto fail

echo.
echo ============================================
echo  DONE.
echo  Next: open EasyLanguage - Tools - Support Library Config
echo        - check the EasyLanguage MCP support library - restart EasyLanguage.
echo ============================================
pause
exit /b 0

:fail
echo.
echo ============================================
echo  FAILED. Copy the messages above and send them.
echo ============================================
pause
exit /b 1
