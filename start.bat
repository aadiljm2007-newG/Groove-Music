@echo off
title GROOVE.RAW - Vinyl Player OS
cd /d "%~dp0"

echo ===================================================
echo   Starting GROOVE.RAW // VINYL_OS Server...
echo ===================================================

:: Check if node_modules exists, install dependencies if missing
if not exist "node_modules\" (
    echo [INFO] First time setup: installing dependencies...
    call npm install
)

:: Launch browser in background after short delay
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Start the application
npm start
pause
