@echo off
rem Local Judge (Java) launcher - runs on Windows directly (no WSL)
cd /d "%~dp0"

rem Open the browser after the server has had time to start
start "" /b cmd /c "timeout /t 2 > nul & start http://localhost:2436"

node backend\server.js
pause
