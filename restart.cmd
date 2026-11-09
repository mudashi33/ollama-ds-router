@echo off
rem Restart the time router: kill whatever listens on 8788, start it hidden, wait for status.
rem Use this after editing router.mjs / schedule.mjs / .env.
setlocal
cd /d "%~dp0"
set PORT=8788
if not "%~1"=="" set PORT=%~1

echo Stopping the process on port %PORT% ...
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr LISTENING ^| findstr :%PORT%') do (
  echo   kill PID %%p
  taskkill /PID %%p /F >nul 2>&1
)

echo Starting ...
cscript //nologo "%~dp0run-hidden.vbs"

for /l %%i in (1,1,20) do (
  curl -s -o nul -w "%%{http_code}" http://127.0.0.1:%PORT%/_router/status > "%TEMP%\tr-status.txt" 2>nul
  set /p CODE=<"%TEMP%\tr-status.txt"
  if "!CODE!"=="200" goto ready
  ping -n 2 127.0.0.1 >nul
)
echo Status check: see router.log
goto :eof

:ready
echo Router is up: http://127.0.0.1:%PORT%/
del "%TEMP%\tr-status.txt" >nul 2>&1
