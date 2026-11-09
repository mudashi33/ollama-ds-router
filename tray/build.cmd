@echo off
setlocal
call "D:\Visual Studio\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul 2>&1
if errorlevel 1 (
  echo [build] vcvarsall failed
  exit /b 1
)
cd /d "%~dp0"
cl /nologo /O2 /MT /utf-8 /EHsc /DUNICODE /D_UNICODE router-tray.cpp ^
   /link /SUBSYSTEM:WINDOWS /OUT:RouterTray.exe ^
   user32.lib gdi32.lib winhttp.lib comctl32.lib shell32.lib advapi32.lib
if errorlevel 1 (
  echo [build] FAILED
  exit /b 1
)
echo [build] OK
