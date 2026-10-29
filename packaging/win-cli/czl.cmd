@echo off
rem Shared launcher for the Windows CLI package. Usage: call czl.cmd status|localize|revert [options]
rem Runtime: app\node\node.exe if present, otherwise Cursor's own Cursor.exe in Node mode (ELECTRON_RUN_AS_NODE=1).
setlocal
chcp 65001 >nul
set "APP=%~dp0"
set "LOGDIR=%APPDATA%\cursor-zh-localizer"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "RUNTIME="
set "ASNODE="
if exist "%APP%node\node.exe" set "RUNTIME=%APP%node\node.exe"
if defined RUNTIME goto run
if exist "%LOCALAPPDATA%\Programs\cursor\Cursor.exe" set "RUNTIME=%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
if not defined RUNTIME if exist "%ProgramFiles%\cursor\Cursor.exe" set "RUNTIME=%ProgramFiles%\cursor\Cursor.exe"
if not defined RUNTIME if exist "%ProgramW6432%\cursor\Cursor.exe" set "RUNTIME=%ProgramW6432%\cursor\Cursor.exe"
if not defined RUNTIME goto noruntime
set "ASNODE=1"
:run
if defined ASNODE set "ELECTRON_RUN_AS_NODE=1"
"%RUNTIME%" "%APP%scripts\run.mjs" %* "--log=%LOGDIR%\cli.log"
set "RC=%ERRORLEVEL%"
set "ELECTRON_RUN_AS_NODE="
endlocal & exit /b %RC%
:noruntime
echo.
echo [X] Cursor not found: %LOCALAPPDATA%\Programs\cursor\Cursor.exe or %ProgramFiles%\cursor\Cursor.exe
echo     Install Cursor first, or put node.exe into "%APP%node\".
echo [%DATE% %TIME%] Cursor.exe / node.exe not found >> "%LOGDIR%\cli.log"
endlocal & exit /b 9
