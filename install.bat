@echo off
rem dsh-mobile-remote installer - double-click to install into web profile
rem (asks for a phone access password, then writes config; restart dsh web after)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
