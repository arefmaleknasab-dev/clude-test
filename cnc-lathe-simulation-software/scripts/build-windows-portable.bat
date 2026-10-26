@echo off
setlocal
rem Build a portable KharratCode package on Windows 10 (needs Node.js 20+ installed).
cd /d "%~dp0\.."
set OUT=KharratCode-Windows10-Portable

call npm install || goto :err
call npm run build || goto :err

if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%" || goto :err
node scripts\prepare-portable-html.mjs dist\index.html "%OUT%\KharratCode.html" || goto :err

> "%OUT%\KharratCode.bat" echo @echo off
>> "%OUT%\KharratCode.bat" echo start "" "%%~dp0KharratCode.html"

echo.
echo Done. Portable folder: %CD%\%OUT%
echo Run KharratCode.bat (or open KharratCode.html) - no install, works offline.
exit /b 0

:err
echo.
echo Build failed. Check the messages above.
exit /b 1
