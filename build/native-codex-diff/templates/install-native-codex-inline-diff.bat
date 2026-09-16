@echo off
rem Copyright (c) Microsoft Corporation. All rights reserved.
rem Licensed under the MIT License. See License.txt in the project root.
setlocal EnableExtensions DisableDelayedExpansion
title Install Codex Native Inline Diff for VS Code 1.138.0

rem Prevent Windows PowerShell 5.1 from inheriting incompatible PowerShell 7 module paths.
set "PSModulePath="

set "PACKAGE_DIR=%~dp0"
set "PATCH_SCRIPT=%PACKAGE_DIR%scripts\patch-official-vscode.ps1"
set "TEST_SCRIPT=%PACKAGE_DIR%scripts\test-patch-official-vscode.ps1"
set "PATCH_BUILD_DIR=%PACKAGE_DIR%payload"
set "OFFICIAL_INSTALL_DIR="
if exist "%PACKAGE_DIR%install-target.local.cmd" call "%PACKAGE_DIR%install-target.local.cmd"
set "VSCODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if defined OFFICIAL_INSTALL_DIR set "VSCODE_EXE=%OFFICIAL_INSTALL_DIR%\Code.exe"

for %%I in ("%PATCH_SCRIPT%") do set "PATCH_SCRIPT=%%~fI"
for %%I in ("%TEST_SCRIPT%") do set "TEST_SCRIPT=%%~fI"
for %%I in ("%PATCH_BUILD_DIR%") do set "PATCH_BUILD_DIR=%%~fI"

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo ERROR: Windows PowerShell was not found.
    set "RESULT=1"
    goto finish
)

if not exist "%PATCH_SCRIPT%" (
    echo ERROR: Patch script was not found:
    echo %PATCH_SCRIPT%
    set "RESULT=1"
    goto finish
)

if not exist "%PATCH_BUILD_DIR%\product.json" (
    echo ERROR: Patch payload was not found:
    echo %PATCH_BUILD_DIR%
    set "RESULT=1"
    goto finish
)

if /I "%~1"=="--plan" goto plan
if /I "%~1"=="--dry-run" goto dry_run
if /I "%~1"=="--verify" goto verify
if /I "%~1"=="--test" goto test
if not "%~1"=="" goto usage

:apply
echo ============================================================
echo Codex Native Inline Diff patch for official VS Code 1.138.0
echo ============================================================
echo.
echo Save all files and fully exit every official VS Code window.
echo The patch script will stop safely if Code.exe is still running.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_SCRIPT%" -OfficialInstallDir "%OFFICIAL_INSTALL_DIR%" -Action Apply -PatchBuildDir "%PATCH_BUILD_DIR%"
if errorlevel 1 (
    echo.
    echo ERROR: Patch apply failed. No launch will be attempted.
    set "RESULT=1"
    goto finish
)

echo.
echo Verifying patched files and product checksums...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_SCRIPT%" -OfficialInstallDir "%OFFICIAL_INSTALL_DIR%" -Action Verify -PatchBuildDir "%PATCH_BUILD_DIR%"
if errorlevel 1 (
    echo.
    echo ERROR: Patch verification failed. Use the backup path printed above to restore.
    set "RESULT=1"
    goto finish
)

echo.
echo SUCCESS: The patch is installed and verified.
if /I "%CODEX_PATCH_NO_LAUNCH%"=="1" goto apply_done
if not exist "%VSCODE_EXE%" set "VSCODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
if not exist "%VSCODE_EXE%" set "VSCODE_EXE=%ProgramFiles(x86)%\Microsoft VS Code\Code.exe"
if not exist "%VSCODE_EXE%" (
    echo WARNING: Official Code.exe was not found, so VS Code was not started.
    echo Expected: %VSCODE_EXE%
    goto apply_done
)

echo Starting official Visual Studio Code...
start "" "%VSCODE_EXE%"

:apply_done
set "RESULT=0"
goto finish

:plan
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_SCRIPT%" -OfficialInstallDir "%OFFICIAL_INSTALL_DIR%" -Action Plan -PatchBuildDir "%PATCH_BUILD_DIR%"
set "RESULT=%ERRORLEVEL%"
goto finish

:dry_run
echo Running the complete Apply validation path without changing files...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_SCRIPT%" -OfficialInstallDir "%OFFICIAL_INSTALL_DIR%" -Action Apply -PatchBuildDir "%PATCH_BUILD_DIR%" -WhatIf
set "RESULT=%ERRORLEVEL%"
goto finish

:verify
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PATCH_SCRIPT%" -OfficialInstallDir "%OFFICIAL_INSTALL_DIR%" -Action Verify -PatchBuildDir "%PATCH_BUILD_DIR%"
set "RESULT=%ERRORLEVEL%"
goto finish

:test
if not exist "%TEST_SCRIPT%" (
    echo ERROR: Regression test script was not found:
    echo %TEST_SCRIPT%
    set "RESULT=1"
    goto finish
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TEST_SCRIPT%" -OfficialInstallDir "%OFFICIAL_INSTALL_DIR%" -PatchBuildDir "%PATCH_BUILD_DIR%"
set "RESULT=%ERRORLEVEL%"
goto finish

:usage
echo Usage:
echo   Double-click with no arguments to apply, verify, and launch VS Code.
echo   %~nx0 --plan
echo   %~nx0 --dry-run
echo   %~nx0 --verify
echo   %~nx0 --test
set "RESULT=2"

:finish
echo.
if /I not "%CODEX_PATCH_NO_PAUSE%"=="1" (
    echo Press any key to close this window...
    pause >nul
)
endlocal & exit /b %RESULT%
