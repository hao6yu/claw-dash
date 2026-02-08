# System Monitor Dashboard - PowerShell Start Script
# Usage: .\start.ps1 [-Stop] [-Status] [-Help]

param(
    [switch]$Stop,
    [switch]$Status,
    [switch]$Restart,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$DashboardPort = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } else { 8888 }
$ApiPort = if ($env:API_PORT) { $env:API_PORT } else { 8889 }
$GlancesPort = if ($env:GLANCES_PORT) { $env:GLANCES_PORT } else { 61208 }
$BindAddress = if ($env:BIND_ADDRESS) { $env:BIND_ADDRESS } else { "127.0.0.1" }
$ApiBindAddress = if ($env:API_BIND_ADDRESS) { $env:API_BIND_ADDRESS } else { $BindAddress }
$PidDir = ".\pids"
$LogDir = ".\logs"

function Write-Status($Icon, $Message, $Color = "White") {
    Write-Host "  $Icon " -NoNewline -ForegroundColor $Color
    Write-Host $Message
}

function Test-Port($Port) {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $connection
}

function Stop-Services {
    Write-Host "`nStopping services..." -ForegroundColor Yellow
    
    # Kill by PID files
    if (Test-Path $PidDir) {
        Get-ChildItem "$PidDir\*.pid" | ForEach-Object {
            $pid = Get-Content $_.FullName
            $name = $_.BaseName
            try {
                Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                Write-Status "■" "Stopped $name (PID $pid)" Red
            } catch {}
            Remove-Item $_.FullName -Force
        }
    }
    
    # Fallback: kill by port
    @($DashboardPort, $ApiPort, $GlancesPort) | ForEach-Object {
        $conn = Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    
    Write-Host "All services stopped." -ForegroundColor Green
}

function Get-ServiceStatus {
    Write-Host "`nService Status:" -ForegroundColor Cyan
    
    if (Test-Port $GlancesPort) {
        Write-Status "●" "Glances (port $GlancesPort)" Green
    } else {
        Write-Status "●" "Glances (not running)" Red
    }
    
    if (Test-Port $ApiPort) {
        Write-Status "●" "API Server (port $ApiPort)" Green
    } else {
        Write-Status "●" "API Server (not running)" Red
    }
    
    if (Test-Port $DashboardPort) {
        Write-Status "●" "Dashboard (port $DashboardPort)" Green
    } else {
        Write-Status "●" "Dashboard (not running)" Red
    }
    
    Write-Host ""
}

function Start-Services {
    Write-Host ""
    Write-Host "  System Monitor Dashboard" -ForegroundColor Cyan
    Write-Host "================================"
    Write-Host ""
    
    # Check dependencies
    Write-Host "Checking dependencies..." -ForegroundColor Yellow
    
    # Node.js
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Status "✗" "Node.js not found" Red
        Write-Host "    Install from: https://nodejs.org/"
        exit 1
    }
    $nodeVersion = & node -v
    Write-Status "✓" "Node.js $nodeVersion" Green
    
    # Python
    $pythonCmd = if (Get-Command python -ErrorAction SilentlyContinue) { "python" } 
                 elseif (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" }
                 else { $null }
    if (-not $pythonCmd) {
        Write-Status "✗" "Python not found" Red
        Write-Host "    Install from: https://python.org/"
        exit 1
    }
    Write-Status "✓" "Python" Green
    
    # Glances
    if (-not (Get-Command glances -ErrorAction SilentlyContinue)) {
        Write-Status "✗" "Glances not found" Red
        Write-Host "    Install with: pip install glances"
        exit 1
    }
    Write-Status "✓" "Glances" Green
    
    # OpenClaw (optional)
    if (Get-Command openclaw -ErrorAction SilentlyContinue) {
        Write-Status "✓" "OpenClaw (optional)" Green
    } else {
        Write-Status "○" "OpenClaw not found (AI stats hidden)" Yellow
    }
    
    Write-Host ""
    
    # Create directories
    New-Item -ItemType Directory -Path $PidDir -Force | Out-Null
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    
    # Stop existing services
    Stop-Services 2>$null
    Write-Host ""
    
    # Start Glances
    Write-Host "Starting Glances..." -ForegroundColor Yellow
    if (-not (Test-Port $GlancesPort)) {
        $proc = Start-Process -FilePath "glances" -ArgumentList "-w", "--bind", $BindAddress, "-p", $GlancesPort -WindowStyle Hidden -PassThru -RedirectStandardOutput "$LogDir\glances.log"
        $proc.Id | Out-File "$PidDir\glances.pid"
        Start-Sleep -Seconds 2
    }
    Write-Status "●" "Glances started on ${BindAddress}:${GlancesPort}" Green
    
    # Start API server
    Write-Host "Starting API server..." -ForegroundColor Yellow
    $env:PORT = $ApiPort
    $env:API_BIND_ADDRESS = $ApiBindAddress
    $proc = Start-Process -FilePath "node" -ArgumentList "api-server.js" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$LogDir\api-server.log"
    $proc.Id | Out-File "$PidDir\api-server.pid"
    Start-Sleep -Seconds 1
    Write-Status "●" "API server started on ${ApiBindAddress}:$ApiPort" Green
    
    # Start collector
    Write-Host "Starting data collector..." -ForegroundColor Yellow
    $proc = Start-Process -FilePath $pythonCmd -ArgumentList "collector.py" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$LogDir\collector.log"
    $proc.Id | Out-File "$PidDir\collector.pid"
    Write-Status "●" "Collector started" Green
    
    # Start dashboard
    Write-Host "Starting dashboard server..." -ForegroundColor Yellow
    $proc = Start-Process -FilePath $pythonCmd -ArgumentList "-m", "http.server", $DashboardPort, "--bind", $BindAddress -WindowStyle Hidden -PassThru -RedirectStandardOutput "$LogDir\dashboard.log"
    $proc.Id | Out-File "$PidDir\dashboard.pid"
    Write-Status "●" "Dashboard started on ${BindAddress}:${DashboardPort}" Green
    
    Write-Host ""
    Write-Host "================================"
    Write-Host "All services started!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Dashboard: " -NoNewline; Write-Host "http://${BindAddress}:${DashboardPort}" -ForegroundColor Cyan
    Write-Host "API:       " -NoNewline; Write-Host "http://${ApiBindAddress}:${ApiPort}" -ForegroundColor Cyan
    Write-Host "Glances:   " -NoNewline; Write-Host "http://${BindAddress}:${GlancesPort}" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Logs in $LogDir\"
    Write-Host ""
    if ($BindAddress -eq "127.0.0.1") {
        Write-Host "Remote access:" -ForegroundColor Yellow
        Write-Host "  tailscale serve --bg $DashboardPort"
        Write-Host "  tailscale serve --bg --set-path /api http://127.0.0.1:$ApiPort"
        Write-Host "  Then visit: https://`$(hostname).your-tailnet.ts.net"
        Write-Host ""
    }
    Write-Host "Commands:"
    Write-Host "  .\start.ps1 -Stop     Stop all services"
    Write-Host "  .\start.ps1 -Status   Check status"
    Write-Host "  .\start.ps1 -Restart  Restart everything"
    Write-Host ""
}

function Show-Help {
    Write-Host ""
    Write-Host "System Monitor Dashboard - PowerShell"
    Write-Host ""
    Write-Host "Usage: .\start.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  (none)     Start all services"
    Write-Host "  -Stop      Stop all services"
    Write-Host "  -Status    Show service status"
    Write-Host "  -Restart   Restart all services"
    Write-Host "  -Help      Show this help"
    Write-Host ""
    Write-Host "Environment variables:"
    Write-Host "  BIND_ADDRESS    IP to bind to (default: 127.0.0.1)"
    Write-Host "  API_BIND_ADDRESS  API bind IP (default: BIND_ADDRESS)"
    Write-Host "  DASHBOARD_PORT  Dashboard port (default: 8888)"
    Write-Host "  API_PORT        API server port (default: 8889)"
    Write-Host "  GLANCES_PORT    Glances API port (default: 61208)"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\start.ps1                                    # Localhost only (secure)"
    Write-Host "  `$env:BIND_ADDRESS='192.168.50.2'; .\start.ps1  # LAN access"
    Write-Host "  `$env:BIND_ADDRESS='0.0.0.0'; .\start.ps1       # All interfaces"
    Write-Host ""
}

# Main
if ($Help) {
    Show-Help
} elseif ($Stop) {
    Stop-Services
} elseif ($Status) {
    Get-ServiceStatus
} elseif ($Restart) {
    Stop-Services
    Write-Host ""
    Start-Services
} else {
    Start-Services
}
