#!/bin/bash
# System Monitor Dashboard - One-command start
# Works on macOS and Linux
# Usage: ./start.sh [--stop|--status|--restart]

set -e
cd "$(dirname "$0")"

DASHBOARD_PORT=${DASHBOARD_PORT:-8888}
API_PORT=${API_PORT:-8889}
GLANCES_PORT=${GLANCES_PORT:-61208}
BIND_ADDRESS=${BIND_ADDRESS:-127.0.0.1}
API_BIND_ADDRESS=${API_BIND_ADDRESS:-$BIND_ADDRESS}
PID_DIR="./pids"

# Detect OS
OS="unknown"
case "$(uname -s)" in
    Darwin*) OS="macos" ;;
    Linux*)  OS="linux" ;;
    MINGW*|CYGWIN*|MSYS*) OS="windows" ;;
esac

# Colors (disable on Windows/non-interactive)
if [ -t 1 ] && [ "$OS" != "windows" ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

mkdir -p "$PID_DIR" logs

glances_install_hint() {
    case "$OS" in
        macos)  echo "  Install with: brew install glances" ;;
        linux)  echo "  Install with: sudo apt install glances  OR  pip install glances" ;;
        *)      echo "  Install with: pip install glances" ;;
    esac
}

stop_services() {
    echo -e "${YELLOW}Stopping services...${NC}"
    
    for pidfile in "$PID_DIR"/*.pid; do
        [ -f "$pidfile" ] || continue
        pid=$(cat "$pidfile")
        name=$(basename "$pidfile" .pid)
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null && echo -e "  ${RED}■${NC} Stopped $name (PID $pid)"
        fi
        rm -f "$pidfile"
    done
    
    # Also try to stop glances
    pkill -f "glances -w" 2>/dev/null && echo -e "  ${RED}■${NC} Stopped glances" || true
    
    echo -e "${GREEN}All services stopped.${NC}"
}

status_services() {
    echo -e "${BLUE}Service Status:${NC}"
    
    for pidfile in "$PID_DIR"/*.pid; do
        [ -f "$pidfile" ] || continue
        pid=$(cat "$pidfile")
        name=$(basename "$pidfile" .pid)
        if kill -0 "$pid" 2>/dev/null; then
            echo -e "  ${GREEN}●${NC} $name (PID $pid)"
        else
            echo -e "  ${RED}●${NC} $name (dead)"
            rm -f "$pidfile"
        fi
    done
    
    if pgrep -f "glances -w" >/dev/null 2>&1; then
        echo -e "  ${GREEN}●${NC} glances"
    else
        echo -e "  ${RED}●${NC} glances (not running)"
    fi
}

start_services() {
    echo -e "${BLUE}🖥️  System Monitor Dashboard${NC}"
    echo "================================"
    echo -e "Platform: ${GREEN}$OS${NC}"
    echo ""
    
    # Check dependencies
    echo -e "${YELLOW}Checking dependencies...${NC}"
    
    if ! command -v node &>/dev/null; then
        echo -e "${RED}✗ Node.js not found${NC}"
        echo "  Install from: https://nodejs.org/"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
    
    if ! command -v python3 &>/dev/null; then
        echo -e "${RED}✗ Python3 not found${NC}"
        echo "  Install from: https://python.org/"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} Python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
    
    if ! command -v glances &>/dev/null; then
        echo -e "${RED}✗ Glances not found${NC}"
        glances_install_hint
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} Glances"
    
    if command -v openclaw &>/dev/null; then
        echo -e "  ${GREEN}✓${NC} OpenClaw (optional)"
    else
        echo -e "  ${YELLOW}○${NC} OpenClaw not found (AI stats will be hidden)"
    fi
    
    # Check curl for health checks
    if ! command -v curl &>/dev/null; then
        echo -e "  ${YELLOW}○${NC} curl not found (health checks disabled)"
        SKIP_HEALTH_CHECK=1
    fi
    
    echo ""
    
    # Stop existing services first
    stop_services 2>/dev/null || true
    echo ""
    
    # Start Glances
    echo -e "${YELLOW}Starting Glances...${NC}"
    if pgrep -f "glances -w" >/dev/null 2>&1; then
        echo -e "  ${GREEN}●${NC} Glances already running"
    else
        glances -w --bind "$BIND_ADDRESS" -p "$GLANCES_PORT" >/dev/null 2>&1 &
        echo $! > "$PID_DIR/glances.pid"
        sleep 2
        if [ -z "${SKIP_HEALTH_CHECK:-}" ] && curl -s "http://127.0.0.1:$GLANCES_PORT/api/4/cpu" >/dev/null 2>&1; then
            echo -e "  ${GREEN}●${NC} Glances started on $BIND_ADDRESS:$GLANCES_PORT"
        else
            echo -e "  ${YELLOW}○${NC} Glances starting on $BIND_ADDRESS:$GLANCES_PORT..."
        fi
    fi
    
    # Start API server
    echo -e "${YELLOW}Starting API server...${NC}"
    PORT=$API_PORT API_BIND_ADDRESS="$API_BIND_ADDRESS" node api-server.js >> logs/api-server.log 2>&1 &
    echo $! > "$PID_DIR/api-server.pid"
    sleep 1
    API_CHECK_HOST="$API_BIND_ADDRESS"
    if [ "$API_CHECK_HOST" = "0.0.0.0" ]; then
        API_CHECK_HOST="127.0.0.1"
    fi
    if [ -z "${SKIP_HEALTH_CHECK:-}" ] && curl -s "http://$API_CHECK_HOST:$API_PORT/api/quote" >/dev/null 2>&1; then
        echo -e "  ${GREEN}●${NC} API server started on $API_BIND_ADDRESS:$API_PORT"
    else
        echo -e "  ${YELLOW}○${NC} API server starting on $API_BIND_ADDRESS:$API_PORT..."
    fi
    
    # Start collector
    echo -e "${YELLOW}Starting data collector...${NC}"
    python3 collector.py >> logs/collector.log 2>&1 &
    echo $! > "$PID_DIR/collector.pid"
    echo -e "  ${GREEN}●${NC} Collector started"
    
    # Start dashboard web server
    echo -e "${YELLOW}Starting dashboard server...${NC}"
    python3 -m http.server "$DASHBOARD_PORT" --bind "$BIND_ADDRESS" >> logs/dashboard.log 2>&1 &
    echo $! > "$PID_DIR/dashboard.pid"
    sleep 1
    echo -e "  ${GREEN}●${NC} Dashboard server started on $BIND_ADDRESS:$DASHBOARD_PORT"
    
    echo ""
    echo "================================"
    echo -e "${GREEN}All services started!${NC}"
    echo ""
    echo -e "Dashboard: ${BLUE}http://$BIND_ADDRESS:$DASHBOARD_PORT${NC}"
    echo -e "API:       ${BLUE}http://$API_BIND_ADDRESS:$API_PORT${NC}"
    echo -e "Glances:   ${BLUE}http://$BIND_ADDRESS:$GLANCES_PORT${NC}"
    echo ""
    echo "Logs in ./logs/"
    echo ""
    if [ "$BIND_ADDRESS" = "127.0.0.1" ]; then
        echo -e "${YELLOW}Remote access:${NC}"
        echo "  tailscale serve --bg $DASHBOARD_PORT"
        echo "  tailscale serve --bg --set-path /api http://127.0.0.1:$API_PORT"
        echo "  Then visit: https://\$(hostname).your-tailnet.ts.net"
        echo ""
    fi
    echo "Commands:"
    echo "  ./start.sh --stop    Stop all services"
    echo "  ./start.sh --status  Check status"
    echo "  ./start.sh --restart Restart everything"
}

# Parse arguments
case "${1:-}" in
    --stop|-s)
        stop_services
        ;;
    --status)
        status_services
        ;;
    --restart|-r)
        stop_services
        echo ""
        start_services
        ;;
    --help|-h)
        echo "System Monitor Dashboard"
        echo ""
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  (none)     Start all services"
        echo "  --stop     Stop all services"
        echo "  --status   Show service status"
        echo "  --restart  Restart all services"
        echo "  --help     Show this help"
        echo ""
        echo "Environment variables:"
        echo "  BIND_ADDRESS    IP to bind to (default: 127.0.0.1)"
        echo "  API_BIND_ADDRESS  API bind IP (default: BIND_ADDRESS)"
        echo "  DASHBOARD_PORT  Dashboard port (default: 8888)"
        echo "  API_PORT        API server port (default: 8889)"
        echo "  GLANCES_PORT    Glances API port (default: 61208)"
        echo ""
        echo "Examples:"
        echo "  ./start.sh                          # Localhost only (secure)"
        echo "  BIND_ADDRESS=192.168.50.2 ./start.sh  # LAN access"
        echo "  BIND_ADDRESS=0.0.0.0 ./start.sh       # All interfaces"
        ;;
    *)
        start_services
        ;;
esac
