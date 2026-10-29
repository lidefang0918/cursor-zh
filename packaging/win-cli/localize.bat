@echo off
chcp 65001 >nul
call "%~dp0app\czl.cmd" status
echo.
echo ==================================================
echo.
call "%~dp0app\czl.cmd" localize --close --start
echo.
echo Log: %APPDATA%\cursor-zh-localizer\cli.log
pause
