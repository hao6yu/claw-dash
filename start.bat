@echo off
REM System Monitor Dashboard - Windows Start Script
REM Usage: start.bat [stop|status]

setlocal enabledelayedexpansion
cd /d "%~dp0"

set DASHBOARD_PORT=8888
set API_PORT=8889
set GLANCES_PORT=61208
if "%BIND_ADDRESS%"=="" set BIND_ADDRESS=127.0.0.1

if "%1"=="stop" goto :stop
if "%1"=="status" goto :status
if "%1"=="--stop" goto :stop
if "%1"=="--status" goto :status
if "%1"=="--help" goto :help
if "%1"=="-h" goto :help

:start
echo.
echo  System Monitor Dashboard
echo ================================
echo.

REM Check dependencies
echo Checking dependencies...

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Node.js not found
    echo     Install from: https://nodejs.org/
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do echo [OK] Node.js %%i

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Python not found
    echo     Install from: https://python.org/
    exit /b 1
)
echo [OK] Python

where glances >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Glances not found
    echo     Install with: pip install glances
    exit /b 1
)
echo [OK] Glances

where openclaw >nul 2>&1
if %errorlevel% neq 0 (
    echo [  ] OpenClaw not found ^(optional - AI stats hidden^)
) else (
    echo [OK] OpenClaw ^(optional^)
)

echo.

REM Create directories
if not exist logs mkdir logs
if not exist pids mkdir pids

REM Start Glances
echo Starting Glances...
start /b "" glances -w --bind %BIND_ADDRESS% -p %GLANCES_PORT% > logs\glances.log 2>&1
echo [OK] Glances starting on %BIND_ADDRESS%:%GLANCES_PORT%

REM Wait for Glances
timeout /t 2 /nobreak >nul

REM Start API server
echo Starting API server...
start /b "" node api-server.js > logs\api-server.log 2>&1
echo [OK] API server starting on port %API_PORT%

REM Start collector
echo Starting data collector...
start /b "" python collector.py > logs\collector.log 2>&1
echo [OK] Collector starting

REM Start dashboard
echo Starting dashboard server...
start /b "" python -m http.server %DASHBOARD_PORT% --bind %BIND_ADDRESS% > logs\dashboard.log 2>&1
echo [OK] Dashboard starting on %BIND_ADDRESS%:%DASHBOARD_PORT%

echo.
echo ================================
echo All services started!
echo.
echo Dashboard: http://%BIND_ADDRESS%:%DASHBOARD_PORT%
echo API:       http://%BIND_ADDRESS%:%API_PORT%
echo Glances:   http://%BIND_ADDRESS%:%GLANCES_PORT%
echo.
echo Logs in .\logs\
echo.
if "%BIND_ADDRESS%"=="127.0.0.1" (
    echo Remote access:
    echo   tailscale serve --bg %DASHBOARD_PORT%
    echo   Then visit your Tailscale hostname with https://
    echo.
)
echo To stop: start.bat stop
echo.
goto :eof

:stop
echo.
echo Stopping services...
taskkill /f /im "node.exe" /fi "WINDOWTITLE eq api-server*" >nul 2>&1
taskkill /f /im "python.exe" /fi "WINDOWTITLE eq collector*" >nul 2>&1
taskkill /f /im "python.exe" /fi "WINDOWTITLE eq http.server*" >nul 2>&1
taskkill /f /im "glances.exe" >nul 2>&1

REM Fallback: kill by port
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%DASHBOARD_PORT%" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%API_PORT%" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%GLANCES_PORT%" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

echo Services stopped.
goto :eof

:status
echo.
echo Service Status:
echo.

netstat -aon | findstr ":%GLANCES_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [RUNNING] Glances ^(port %GLANCES_PORT%^)
) else (
    echo [STOPPED] Glances
)

netstat -aon | findstr ":%API_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [RUNNING] API Server ^(port %API_PORT%^)
) else (
    echo [STOPPED] API Server
)

netstat -aon | findstr ":%DASHBOARD_PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [RUNNING] Dashboard ^(port %DASHBOARD_PORT%^)
) else (
    echo [STOPPED] Dashboard
)

echo.
goto :eof

:help
echo.
echo System Monitor Dashboard - Windows
echo.
echo Usage: start.bat [command]
echo.
echo Commands:
echo   ^(none^)    Start all services
echo   stop      Stop all services
echo   status    Show service status
echo   --help    Show this help
echo.
goto :eof
