@echo off
rem Builds dist\FocusDock Setup <version>.exe. Needs Node.js 22.12 or newer (https://nodejs.org, the LTS version).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 goto fail
call npm test
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo Done. The installer is in the dist folder.
explorer dist
pause
exit /b 0
:fail
echo Build failed. See the messages above.
pause
exit /b 1
