@echo off
rem Double-click to start JARVIS on Windows.
rem JARVIS is the Node build (server.ts + the glass dashboard) on port 3000.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo JARVIS needs Node.js. Install the LTS version from nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing JARVIS's packages with npm install...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Check that you are online, then run this file again.
    pause
    exit /b 1
  )
)

rem Open the dashboard once the server has had a moment to come up.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'"

echo Starting JARVIS on http://localhost:3000 ...
call npm run dev
if errorlevel 1 pause
