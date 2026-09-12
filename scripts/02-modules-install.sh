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

# MMM-Remote-Control-Repository is deliberately not installed — upstream
# deprecated it in Jul 2025, MMM-Remote-Control now maintains modules.json itself.
# An existing copy on the device is left in place but no longer configured.

# ════════════════════════════════════════════════════════════════════════════
divider "CUSTOM MODULES"
# ════════════════════════════════════════════════════════════════════════════

# Every module in the repo, so adding one needs no change here. Each is
# replaced rather than merged, otherwise a renamed file would linger.
shopt -s nullglob
CUSTOM=("$REPO_DIR"/modules/*/)
shopt -u nullglob
if [ ${#CUSTOM[@]} -eq 0 ]; then
    echo -e "${RED}No modules found in $REPO_DIR/modules${NC}"; exit 1
fi
for src in "${CUSTOM[@]}"; do
    name="$(basename "$src")"
    rm -rf "$MMDIR/modules/$name"
    cp -r "$src" "$MMDIR/modules/"
    ok "$name installed"
done

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

# Which profile is live is the user's choice, and this script now runs
# unattended from the nightly update - resetting it to guest every night would
# quietly undo mm-profile.sh. Only pick one when nothing is chosen yet.
if [ -L "$MMDIR/config/config.js" ] || [ -f "$MMDIR/config/config.js" ]; then
    skip "Active profile left as $(basename "$(readlink -f "$MMDIR/config/config.js")")"
else
    ln -sf "$MMDIR/config/config-guest.js" "$MMDIR/config/config.js"
    ok "Active profile → guest"
fi

cp "$REPO_DIR/config/custom.css" "$MMDIR/css/custom.css"
ok "custom.css installed (portrait rotation)"

divider "MODULES COMPLETE — Run 03-portal-install.sh next"
