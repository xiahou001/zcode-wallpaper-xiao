@echo off
setlocal
rem Run the full wallpaper repair (state + asar injection + shadow cleanup + server).
rem Close ZCode first if the injection step reports the file is locked.
set "ROOT=%~dp0"
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%ROOT%tools\repair.js" %*
echo.
pause