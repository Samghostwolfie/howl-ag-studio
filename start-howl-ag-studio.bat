@echo off
title Howl A/G Studio - Launcher
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo.
    echo  Node.js doesn't seem to be installed yet.
    echo  Download and install it from https://nodejs.org (choose the LTS version),
    echo  then double-click this file again.
    echo.
    pause
    exit /b
)

if not exist ".env" (
    echo Setting up your config file for the first time...
    copy /Y ".env.example" ".env" >nul
)

if not exist "node_modules" (
    echo Installing dependencies - this can take a minute the first time...
    call npm install
)

echo.
echo Starting the Howl A/G Studio server in its own window...
echo   Keep that window open while you're using the site.
echo   Close it whenever you want to stop the site.
echo.

start "Howl A/G Studio - SERVER (keep this window open)" cmd /k npm start

timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"

echo Opening the site in your browser now.
echo Admin panel: http://localhost:3000/admin  (username: admin, password: ChangeMe123! - change this after logging in!)
echo.
echo You can close THIS window - the server keeps running in the other one.
pause
