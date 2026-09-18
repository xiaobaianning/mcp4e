@echo off
setlocal
cd /d "%~dp0"
echo Analyzing .ec module and writing ecom-analysis.txt ...
echo.
node ".\scripts\dump-ecom-analysis.mjs" %*
echo.
echo Done. File: %CD%\ecom-analysis.txt
pause
