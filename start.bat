@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first.
  pause
  exit /b 1
)

echo ============================================
echo   AI Group Chat - local debug server
echo   Open: http://127.0.0.1:3000
echo   Stop: press Ctrl+C in this window
echo ============================================
echo.

node server.js

if errorlevel 1 (
  echo.
  echo [ERROR] Server exited with an error. Check the log above.
  pause
)

endlocal
