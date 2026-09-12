#!/bin/bash
# ============================================================================
# 02-modules-install.sh — MMM-Remote-Control, MMM-BTCAud, configs
# Run as: mirror
# Usage:  bash 02-modules-install.sh 2>&1 | tee modules.log
# ============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

divider() { echo ""; echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"; }

MMDIR="$HOME/MagicMirror"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -d "$MMDIR" ]; then
    echo -e "${RED}MagicMirror not found at $MMDIR. Install it first.${NC}"; exit 1
fi

# ════════════════════════════════════════════════════════════════════════════
divider "MMM-Remote-Control"
# ════════════════════════════════════════════════════════════════════════════

cd "$MMDIR/modules"

if [ -d "MMM-Remote-Control" ]; then
    info "Updating..."
    cd MMM-Remote-Control && git pull && npm ci --omit=dev && cd ..
else
    git clone https://github.com/Jopyth/MMM-Remote-Control.git
    cd MMM-Remote-Control && npm ci --omit=dev && cd ..
fi
ok "MMM-Remote-Control installed"

# ════════════════════════════════════════════════════════════════════════════
divider "MMM-Remote-Control-Repository"
# ════════════════════════════════════════════════════════════════════════════

cd "$MMDIR/modules"

if [ -d "MMM-Remote-Control-Repository" ]; then
    info "Updating..."
    cd MMM-Remote-Control-Repository && git pull && npm install --production && cd ..
else
    git clone https://github.com/MMRIZE/MMM-Remote-Control-Repository.git
    cd MMM-Remote-Control-Repository && npm install --production && cd ..
fi
ok "MMM-Remote-Control-Repository installed"

# ════════════════════════════════════════════════════════════════════════════
divider "MMM-BTCAud (Custom Module)"
# ════════════════════════════════════════════════════════════════════════════

if [ ! -d "$REPO_DIR/modules/MMM-BTCAud" ]; then
    echo -e "${RED}MMM-BTCAud not found at $REPO_DIR/modules/MMM-BTCAud${NC}"; exit 1
fi
rm -rf "$MMDIR/modules/MMM-BTCAud"
cp -r "$REPO_DIR/modules/MMM-BTCAud" "$MMDIR/modules/"
ok "MMM-BTCAud installed"

# ════════════════════════════════════════════════════════════════════════════
divider "CONFIG FILES"
# ════════════════════════════════════════════════════════════════════════════

if [ ! -f "$REPO_DIR/config/config-guest.js" ]; then
    echo -e "${RED}Configs not found in $REPO_DIR/config${NC}"; exit 1
fi

cp "$REPO_DIR/config/config-guest.js" "$MMDIR/config/config-guest.js"
ok "config-guest.js installed"

# Personal profile is hand-tuned on the device — never overwrite an existing one
if [ -f "$MMDIR/config/config-personal.js" ]; then
    skip "config-personal.js exists — left untouched"
else
    cp "$REPO_DIR/config/config-personal.js" "$MMDIR/config/config-personal.js"
    ok "config-personal.js seeded from repo default"
fi

ln -sf "$MMDIR/config/config-guest.js" "$MMDIR/config/config.js"
ok "Active profile → guest"

cp "$REPO_DIR/config/custom.css" "$MMDIR/css/custom.css"
ok "custom.css installed (portrait rotation)"

divider "MODULES COMPLETE — Run 03-portal-install.sh next"
