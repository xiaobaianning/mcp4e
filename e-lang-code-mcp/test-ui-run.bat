@echo off & cd /d "%~dp0" & node "scripts\test-ui-run.mjs" > "ui-run-output.txt" 2>&1 & type "ui-run-output.txt" & echo. & echo Done. Output: ui-run-output.txt & pause
