@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer with npm, then reopen this launcher.
  pause
  exit /b 1
)
node "%~dp0scripts\start.mjs" %*
if errorlevel 1 (
  echo.
  echo Startup failed. See the message above and README.md.
  pause
  exit /b 1
)
exit /b 0
