@echo off
setlocal
cd /d "%~dp0"

echo.
echo  WhisperX ASR Portal
echo  --------------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js not found.
  echo  Install Node.js 18 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  [1/3] Installing dependencies, first run only...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo  [1/3] Dependencies already installed.
)

echo  [2/3] Compiling TypeScript...
call npm run build
if errorlevel 1 (
  echo.
  echo  [ERROR] Build failed.
  pause
  exit /b 1
)

echo  [3/3] Starting server...
echo.
node dist\server\index.js

echo.
echo  Server stopped.
pause
