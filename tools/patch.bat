@echo off
setlocal enabledelayedexpansion
title Toon Valley - point the launcher at the community server
set "BASE=https://toonvalley.sapi.click"

echo.
echo   Toon Valley launcher patcher
echo   ----------------------------
echo   Points the launcher at %BASE% (game port 30720).
echo   Close the launcher first, then press a key.
echo.
pause >nul

rem Try the usual places for resources\app.asar, in order:
rem   1. next to this .bat (extracted client: <client>\Launcher\resources)
rem   2. one level up (this .bat inside a tools\ folder)
rem   3. the installer's per-user path
set "DEST="
if exist "%~dp0Launcher\resources\app.asar" set "DEST=%~dp0Launcher\resources"
if not defined DEST if exist "%~dp0..\Launcher\resources\app.asar" set "DEST=%~dp0..\Launcher\resources"
if not defined DEST if exist "%LOCALAPPDATA%\Programs\Toon Valley\Launcher\resources\app.asar" set "DEST=%LOCALAPPDATA%\Programs\Toon Valley\Launcher\resources"

if not defined DEST (
  echo Could not find Launcher\resources\app.asar automatically.
  echo Drag the client's Launcher folder onto this file, or type the path:
  set /p DEST=Path to ...\Launcher\resources: 
)
set "DEST=%DEST:"=%"

if not exist "%DEST%\app.asar" (
  echo No app.asar in "%DEST%" - aborting.
  pause
  exit /b 1
)

echo Backing up the original launcher...
if not exist "%DEST%\app.asar.orig" copy /y "%DEST%\app.asar" "%DEST%\app.asar.orig" >nul

echo Downloading the patched launcher...
curl.exe -fsSL -o "%DEST%\app.asar.new" "%BASE%/launcher/app.asar"
if errorlevel 1 (
  echo Download failed. Check your connection, or the launcher may still be running.
  pause
  exit /b 1
)

move /y "%DEST%\app.asar.new" "%DEST%\app.asar" >nul
if errorlevel 1 (
  echo Could not replace app.asar - close the launcher and run this again.
  pause
  exit /b 1
)

echo.
echo Done. Start the launcher and log in with any username you like.
pause
