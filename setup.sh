#!/bin/bash
# System Monitor Dashboard - Setup Script
# Validates dependencies and creates initial config

set -e
cd "$(dirname "$0")"

# Detect OS
OS="unknown"
case "$(uname -s)" in
    Darwin*) OS="macos" ;;
    Linux*)  OS="linux" ;;
    MINGW*|CYGWIN*|MSYS*) OS="windows" ;;
esac

echo "🖥️  System Monitor Dashboard Setup"
echo "======================================"
echo "Platform: $OS"
echo ""

# Check for dependencies
echo "Checking dependencies..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found"
    echo "   Install from: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 not found"
    echo "   Install from: https://python.org/"
    exit 1
fi
echo "✅ Python $(python3 --version)"

# Check Glances
if ! command -v glances &> /dev/null; then
    echo "⚠️  Glances not found"
    case "$OS" in
        macos)  echo "   Install with: brew install glances" ;;
        linux)  echo "   Install with: sudo apt install glances  OR  pip install glances" ;;
        *)      echo "   Install with: pip install glances" ;;
    esac
    echo "   Dashboard will still work but system metrics won't be available."
else
    echo "✅ Glances installed"
fi

# Check OpenClaw (optional)
if command -v openclaw &> /dev/null; then
    echo "✅ OpenClaw installed (optional)"
else
    echo "ℹ️  OpenClaw not found (optional - AI stats will be hidden)"
fi

echo ""
echo "Creating directories..."
mkdir -p logs pids

echo ""
echo "Copying example config..."
if [ ! -f config.json ]; then
    cp config.example.json config.json
    echo "✅ Created config.json - edit this to customize your dashboard"
else
    echo "ℹ️  config.json already exists"
fi

echo ""
echo "======================================"
echo "Setup complete! 🎉"
echo ""
echo "To start the dashboard:"
echo ""
echo "  ./start.sh"
echo ""
echo "Or manually:"
echo ""
echo "  1. Start Glances (in a separate terminal):"
echo "     glances -w --bind 0.0.0.0"
echo ""
echo "  2. Start the API server:"
echo "     node api-server.js &"
echo ""
echo "  3. Start the data collector:"
echo "     python3 collector.py &"
echo ""
echo "  4. Serve the dashboard:"
echo "     python3 -m http.server 8888"
echo ""
echo "  5. Open http://localhost:8888 in your browser"
echo ""

if [ "$OS" = "macos" ]; then
    echo "For persistent operation on macOS, see the launchd/ folder for example service files."
elif [ "$OS" = "linux" ]; then
    echo "For persistent operation on Linux, see README.md for systemd service example."
fi
echo ""
