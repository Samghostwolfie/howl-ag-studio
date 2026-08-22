@echo off
setlocal enabledelayedexpansion
title Howl A/G Studio - Restart
cd /d "%~dp0"

echo.
echo   ============================================
echo     HOWL A/G STUDIO - RESTARTING THE SITE
echo   ============================================
echo.

REM ---- Find Node, even if Explorer's PATH is stale --------------------
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"

if not defined NODE_EXE (
  for %%P in (
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  ) do (
    if exist "%%~P" set "NODE_EXE=%%~P"
  )
)

if not defined NODE_EXE (
  echo   [X] Could not find Node.js on this computer.
  echo.
  echo   Install it from https://nodejs.org  ^(the "LTS" button^),
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

REM ---- Find npm the same way ------------------------------------------
set "NPM_CMD="
where npm >nul 2>nul && set "NPM_CMD=npm"
if not defined NPM_CMD (
  for %%P in (
    "%ProgramFiles%\nodejs\npm.cmd"
    "%ProgramFiles(x86)%\nodejs\npm.cmd"
    "%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
  ) do (
    if exist "%%~P" set "NPM_CMD=%%~P"
  )
)

echo   [1/4] Node found: !NODE_EXE!

REM ---- Stop whatever is already serving the site ----------------------
echo   [2/4] Stopping the old server...
taskkill /F /IM node.exe >nul 2>nul
if errorlevel 1 (
  echo         nothing was running - fine, starting fresh.
) else (
  echo         old server stopped.
)
timeout /t 2 /nobreak >nul

REM ---- Sanity check: are the packages there? --------------------------
REM The app deliberately uses only the packages that were installed on day one,
REM so this should always pass. If it ever fails, npm install is the fix.
echo   [3/4] Checking packages...

set "MISSING="
if not exist "node_modules" set "MISSING=1"
if not defined MISSING (
  "!NODE_EXE!" -e "const p=require('./package.json');for(const m of Object.keys(p.dependencies||{})){try{require.resolve(m)}catch(e){console.error('missing: '+m);process.exit(1)}}" 2>nul
  if errorlevel 1 set "MISSING=1"
)

if defined MISSING (
  echo.
  echo   [!] Some packages are missing from node_modules.
  echo       Open a Command Prompt in this folder and run:  npm install
  echo       Trying to start anyway - the server window will show any error.
  echo.
  timeout /t 4 /nobreak >nul
) else (
  echo         all packages present.
)

REM ---- Start it again with the CURRENT code ---------------------------
echo   [4/4] Starting the site...
echo.

start "Howl A/G Studio - SERVER (keep this open)" cmd /k ""!NODE_EXE!" server.js"

timeout /t 4 /nobreak >nul
start "" "http://localhost:3000/"

echo.
echo   Done. A new window opened running the server.
echo   Keep that window open while you use the site.
echo.
echo   If the site does not load, look at the SERVER window -
echo   any error will be printed there in red text.
echo.
timeout /t 8 /nobreak >nul
exit /b 0
