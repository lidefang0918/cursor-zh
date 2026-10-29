@echo off
chcp 65001 >nul
call "%~dp0app\czl.cmd" status
echo.
echo Log: %APPDATA%\cursor-zh-localizer\cli.log
pause
