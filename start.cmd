@echo off
setlocal

where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0server.js" %*
  exit /b %errorlevel%
)

set "WIBRATE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%WIBRATE_NODE%" (
  "%WIBRATE_NODE%" "%~dp0server.js" %*
  exit /b %errorlevel%
)

echo Node.js 20 or newer was not found.
echo Install Node.js from https://nodejs.org/ and run this file again.
pause
exit /b 1
