@echo off
title Howl A/G Studio - Push Updates to Live Website
cd /d "C:\Users\ifeol\Music\howl-ag-studio\howl-ag-studio-SOFTWARE"

echo =======================================================
echo   HOWL A/G STUDIO - PUSH TO LIVE WEBSITE (RENDER)
echo =======================================================
echo.
echo Pushing your latest updates to GitHub...
echo.

git push origin main

if %errorlevel% equ 0 (
    echo.
    echo =======================================================
    echo   SUCCESS! PUSH COMPLETED.
    echo =======================================================
    echo.
    echo Render has detected your new updates and is now
    echo automatically deploying your live site:
    echo   https://howl-ag-studio.onrender.com/
    echo.
    echo It usually takes 1-2 minutes to finish updating.
    echo Once updated, check your admin panel:
    echo   https://howl-ag-studio.onrender.com/admin
    echo.
) else (
    echo.
    echo =======================================================
    echo   PUSH FAILED OR AUTHENTICATION REQUIRED
    echo =======================================================
    echo If a GitHub sign-in window popped up, please complete the sign-in.
    echo.
)

pause
