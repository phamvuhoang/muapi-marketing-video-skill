#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MuAPI Video Marketing — Setup Script
# Usage: bash scripts/setup.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$ROOT_DIR/mcp-server"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔════════════════════════════════════════════════════╗"
echo "║     MuAPI Video Marketing — Setup                  ║"
echo "╚════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 1: Check dependencies ────────────────────────────────────────────────
echo -e "${YELLOW}[1/5] Checking dependencies...${NC}"

if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org (v18+)${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}✗ Node.js v18+ required. Current: $(node -v)${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

if ! command -v npm &>/dev/null; then
  echo -e "${RED}✗ npm not found${NC}"
  exit 1
fi
echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# ── Step 2: Install & build MCP server ───────────────────────────────────────
echo -e "${YELLOW}[2/5] Installing MCP server dependencies...${NC}"
cd "$MCP_DIR"
npm install --silent
echo -e "${GREEN}✓ Dependencies installed${NC}"

echo -e "${YELLOW}[3/5] Building MCP server...${NC}"
npm run build
echo -e "${GREEN}✓ Build complete → $MCP_DIR/dist/index.js${NC}"

# ── Step 4: Configure API key ────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[4/5] API Key Configuration${NC}"
echo "Get your MuAPI key at: https://muapi.ai/dashboard"
echo ""

if [ -z "${MUAPI_API_KEY:-}" ]; then
  read -rp "  Enter your MuAPI API key (or press Enter to skip): " INPUT_KEY
  if [ -n "$INPUT_KEY" ]; then
    export MUAPI_API_KEY="$INPUT_KEY"
    echo ""
    echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo -e "  ${CYAN}export MUAPI_API_KEY=\"$INPUT_KEY\"${NC}"
  else
    echo -e "${YELLOW}  ⚠ Skipped. Set MUAPI_API_KEY env var before using the MCP server.${NC}"
  fi
else
  echo -e "${GREEN}  ✓ MUAPI_API_KEY already set in environment${NC}"
fi

# ── Step 4: Generate Claude config snippet ────────────────────────────────────
echo ""
echo -e "${YELLOW}[5/5] Generating Claude config...${NC}"

CONFIG_SNIPPET=$(cat <<EOF
{
  "mcpServers": {
    "muapi-video-marketing": {
      "command": "node",
      "args": ["$MCP_DIR/dist/index.js"],
      "env": {
        "MUAPI_API_KEY": "${MUAPI_API_KEY:-YOUR_KEY_HERE}"
      }
    }
  }
}
EOF
)

echo ""
echo -e "${CYAN}────────────────────────────────────────────────────────${NC}"
echo -e "${CYAN}  Add this to your Claude config:${NC}"
echo -e "${CYAN}────────────────────────────────────────────────────────${NC}"
echo ""
echo "$CONFIG_SNIPPET"
echo ""

# Detect and auto-patch Claude Desktop config
CLAUDE_DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [ -f "$CLAUDE_DESKTOP_CONFIG" ]; then
  echo -e "${YELLOW}  Detected Claude Desktop at: $CLAUDE_DESKTOP_CONFIG${NC}"
  echo -e "  To add manually, merge the mcpServers block above into that file."
fi

# Claude Code
echo -e "  For Claude Code CLI: add to ~/.claude.json → mcpServers section"
echo ""
echo -e "${CYAN}────────────────────────────────────────────────────────${NC}"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "  Quick test (after configuring Claude):"
echo -e "  ${CYAN}Ask Claude: \"Create a 30-second TikTok promo for [your brand]\"${NC}"
echo ""
echo "  Manual server test:"
echo -e "  ${CYAN}MUAPI_API_KEY=your_key node $MCP_DIR/dist/index.js${NC}"
echo ""
