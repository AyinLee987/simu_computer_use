@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer first.
  pause
  exit /b 1
)
where docker >nul 2>nul
if errorlevel 1 (
  echo Please install and start Docker Desktop first.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo Starting Docker Desktop...
  docker desktop start
  if errorlevel 1 goto failed
)
if not exist node_modules (
  call npm install
  if errorlevel 1 goto failed
)
node scripts/setup.mjs
if errorlevel 1 goto failed
docker compose up -d --build
if errorlevel 1 goto failed
echo Open http://127.0.0.1:4317 after the server starts.
node server.mjs
pause
exit /b
:failed
echo Setup failed. See the message above and README.md.
pause
exit /b 1
