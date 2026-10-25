@echo off
rem Apply the wallpaper loader to ZCode Desktop.
rem Strategy: equal-length in-place patch of app.asar only (original bytes auto-backed up).
rem NEVER creates the resources\app shadow dir (it causes old-frontend-vs-new-backend
rem mismatch after ZCode updates). A legacy shadow dir is removed ONLY when ZCode is
rem not running (deleting while running would 404 its lazy-loaded chunks).
rem NOTE: keep this file pure ASCII - cmd.exe parses .cmd with GBK codepage and
rem UTF-8 Chinese text breaks command blocks (see git history for details).
set "ROOT=%~dp0"
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%ROOT%asar-patch-inplace.js"
if errorlevel 1 exit /b 1
if exist "%LOCALAPPDATA%\Programs\ZCode\resources\app" (
  tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
  if errorlevel 1 (
    echo.
    echo Legacy shadow dir resources\app found, ZCode not running - removing...
    rmdir /s /q "%LOCALAPPDATA%\Programs\ZCode\resources\app" 2>nul
    if exist "%LOCALAPPDATA%\Programs\ZCode\resources\app" (
      echo Remove failed - close ZCode completely and run again.
    ) else (
      echo Shadow dir removed.
    )
  ) else (
    echo.
    echo Shadow dir found but ZCode is RUNNING - skip removal ^(deleting now would 404 lazy assets^).
    echo Close ZCode completely and run this script again to clean up.
  )
)
echo Done. Restart ZCode to take effect.
exit /b 0
