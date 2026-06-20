@echo off
setlocal

cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting AkibaBet...
echo Local:   http://localhost:5173/
echo Network: http://0.0.0.0:5173/
echo.

call npm run dev -- --host 0.0.0.0

pause
