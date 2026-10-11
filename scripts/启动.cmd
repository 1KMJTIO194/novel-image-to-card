@echo off
REM ============================================================
REM  Novel to Character Card Generator - Windows launcher
REM
REM  This file is intentionally ASCII-only.
REM  cmd.exe parses batch files using the console codepage, so
REM  non-ASCII text here would be mis-parsed on some systems
REM  (bytes get eaten -> "xxx is not recognized as a command").
REM  All Chinese messages live in launcher.mjs (same folder as this
REM  script), which runs on Node (UTF-8 safe) and is invoked below.
REM ============================================================

chcp 65001 >nul 2>nul
title Novel2Card
cd /d "%~dp0"

echo.
echo ============================================================
echo    Novel to Character Card Generator
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

for /f "tokens=*" %%i in ('node -v 2^>nul') do set "NODE_VERSION=%%i"
if not defined NODE_VERSION goto NO_NODE

REM Locate the launcher. It lives in one of two places:
REM   repo layout     -> scripts\launcher.mjs  (same folder as this file)
REM   portable layout -> scripts\launcher.mjs  (this file at root, launcher in scripts\)
REM The two layouts are mutually exclusive, so a two-step probe covers both:
REM "next to me" first (repo), then "scripts\ next to me" (portable).
REM Always prefix with %~dp0: a bare relative path resolves against the current
REM directory, which is already this script's folder after the cd above --
REM so "scripts\launcher.mjs" would become scripts\scripts\launcher.mjs (a real bug we hit).
set "LAUNCHER=%~dp0launcher.mjs"
if not exist "%LAUNCHER%" set "LAUNCHER=%~dp0scripts\launcher.mjs"
if not exist "%LAUNCHER%" goto NO_LAUNCHER

call node "%LAUNCHER%" --port 3000
set "CODE=%errorlevel%"
if not "%CODE%"=="0" goto FAILED

echo.
echo   Server stopped. Double-click this file to start again.
echo.
pause
exit /b 0

:NO_LAUNCHER
echo.
echo   [ERROR] launcher.mjs was not found.
echo.
echo   Looked in:
echo     %~dp0launcher.mjs
echo     %~dp0scripts\launcher.mjs
echo   The archive may not have been extracted completely.
echo   Please extract the whole folder again (use 7-Zip / WinRAR).
echo.
pause
exit /b 1

:NO_NODE
echo.
echo   [ERROR] Node.js was not found.
echo.
echo   This tool needs Node.js 18 or newer.
echo   Opening the download page: https://nodejs.org/
echo   Install the LTS version, then run this file again.
echo.
if not defined N2C_NO_BROWSER start "" "https://nodejs.org/"
timeout /t 3 >nul
pause
exit /b 1

:FAILED
echo.
echo   [ERROR] Startup failed (exit code %CODE%).
echo   See the messages above. Press any key to close.
echo.
pause
exit /b %CODE%
