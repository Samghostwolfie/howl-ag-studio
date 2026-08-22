@echo off
setlocal enabledelayedexpansion
title Howl A/G Studio - Temporary Public Link
cd /d "%~dp0"

echo.
echo   ==================================================
echo     TEMPORARY PUBLIC LINK  -  for demos only
echo   ==================================================
echo.
echo   This puts the site you are running RIGHT NOW on a public
echo   web address, straight from this computer.
echo.
echo   It works only while this window and the server window
echo   stay open. Close either one and the link dies.
echo.

REM ---- Find Node ------------------------------------------------------
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE (
  for %%P in (
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  ) do if exist "%%~P" set "NODE_EXE=%%~P"
)
if not defined NODE_EXE (
  echo   [X] Node.js not found. Install from https://nodejs.org then retry.
  pause & exit /b 1
)

REM ---- Hide the admin panel for the duration of the demo ---------------
REM The link is public, so /admin would be reachable by anyone who guessed it.
REM A random address for this session keeps that door out of sight.
for /f %%R in ('"!NODE_EXE!" -e "console.log(require(''crypto'').randomBytes(5).toString(''hex''))"') do set "SECRET=%%R"
set "ADMIN_PATH=control-!SECRET!"

echo   [1/4] Starting the site...
taskkill /F /IM node.exe >nul 2>nul
timeout /t 2 /nobreak >nul
start "Howl A/G Studio - SERVER (keep open)" cmd /k "set ADMIN_PATH=!ADMIN_PATH!&& "!NODE_EXE!" server.js"
timeout /t 5 /nobreak >nul

REM ---- Get cloudflared (one small file, no account needed) --------------
if exist "cloudflared.exe" (
  echo   [2/4] Tunnel tool already here.
) else (
  echo   [2/4] Downloading the tunnel tool ^(about 20 MB, one time^)...
  curl -L -# -o "cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  if not exist "cloudflared.exe" (
    echo.
    echo   [X] Download failed. Check your internet connection.
    pause & exit /b 1
  )
)

echo   [3/4] Opening the tunnel...
echo.
echo   ==================================================
echo     YOUR ADMIN PANEL FOR THIS SESSION:
echo       /!ADMIN_PATH!
echo     ^(add that to the end of the link below^)
echo   ==================================================
echo.
echo   [4/4] Watch for a line below that looks like:
echo.
echo         https://something-random.trycloudflare.com
echo.
echo   THAT is your shareable link. Copy it from this window.
echo.
echo   --------------------------------------------------
echo.

"cloudflared.exe" tunnel --url http://localhost:3000

echo.
echo   Tunnel closed. The public link no longer works.
pause
