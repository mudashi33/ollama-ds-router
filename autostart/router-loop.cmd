@echo off
setlocal enableextensions
set "ROUTER_DIR=D:\CodeProjects\DeepseekHarnessProjects\ollama-ds-router"
set "NODE_EXE=D:\nodejs\node.exe"
set "LOG=%~dp0router-supervisor.log"
set "PORT=8788"

rem 如果端口已经被别人占着，不要退出：守在这里等它释放，然后接管。
rem 以前是直接 exit，结果"别人"死掉后就再也没人拉起路由器（2026-11-06 12:50 断服 2 分钟）。
call :port_busy
if "%BUSY%"=="0" goto start
echo [%DATE% %TIME%] port %PORT% already listening - supervisor waits for it to free up >> "%LOG%"
:wait_free
timeout /t 30 /nobreak >nul
call :port_busy
if "%BUSY%"=="1" goto wait_free
echo [%DATE% %TIME%] port %PORT% free again - taking over >> "%LOG%"

:start
cd /d "%ROUTER_DIR%"
if errorlevel 1 (
    echo [%DATE% %TIME%] FATAL cannot cd to %ROUTER_DIR% >> "%LOG%"
    exit /b 2
)

:loop
echo [%DATE% %TIME%] starting node --env-file=.env router.mjs >> "%LOG%"
"%NODE_EXE%" --env-file=.env router.mjs >> "%LOG%" 2>&1
echo [%DATE% %TIME%] node exited code=%ERRORLEVEL% - restarting in 5s >> "%LOG%"
timeout /t 5 /nobreak >nul
call :port_busy
if "%BUSY%"=="0" goto loop
echo [%DATE% %TIME%] another instance holds port %PORT% - waiting >> "%LOG%"
:wait_other
timeout /t 30 /nobreak >nul
call :port_busy
if "%BUSY%"=="1" goto wait_other
echo [%DATE% %TIME%] port %PORT% free again - resuming >> "%LOG%"
goto loop

:port_busy
set "BUSY=0"
for /f "delims=" %%A in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do set "BUSY=1"
exit /b 0
