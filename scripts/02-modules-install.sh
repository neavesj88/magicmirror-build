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
# Staged then swapped, never deleted-then-copied. This runs unattended from the
# nightly cron on a box with no SSH: a copy that dies midway between the rm and
# the cp (disk full, power cut, set -e on any failure) would leave the module
# missing or half-written, and MagicMirror would come back up without it until
# somebody physically intervened. Staging means a failure leaves the previous
# working copy exactly where it was.
for src in "${CUSTOM[@]}"; do
    name="$(basename "$src")"
    staged="$MMDIR/modules/.$name.new"
    rm -rf "$staged"
    if cp -r "$src" "$staged"; then
        rm -rf "$MMDIR/modules/$name"
        mv "$staged" "$MMDIR/modules/$name"
        ok "$name installed"
    else
        rm -rf "$staged"
        echo -e "${RED}$name: copy failed, left the existing copy in place${NC}"
        exit 1
    fi
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

# ════════════════════════════════════════════════════════════════════════════
divider "OVERNIGHT SCREEN-OFF"
# ════════════════════════════════════════════════════════════════════════════

# Installed from here rather than script 01 so the nightly update keeps it
# current: script 01 never runs again once the box is built.
install -m 755 "$REPO_DIR/scripts/mm-display.sh" "$HOME/mm-display.sh"
install -m 755 "$REPO_DIR/scripts/mm-display-settings.sh" "$HOME/mm-display-settings.sh"
mkdir -p "$HOME/.config"
# The repo defaults only. Times set from the desktop icon live in
# mm-display.local.conf, which is never written here.
cp "$REPO_DIR/config/display.conf" "$HOME/.config/mm-display.conf"
ok "mm-display.sh and its schedule installed"

# Desktop icon for changing the times on the mirror. Written only when it
# differs: XFCE trusts a launcher by its checksum, so rewriting identical
# content keeps it trusted, and gio needs the session bus (the updater sets it).
ICON="$HOME/Desktop/Screen-off-Times.desktop"
ICON_NEW=$(cat << EOF
[Desktop Entry]
Type=Application
Name=Screen-off Times
Icon=preferences-desktop-screensaver
Exec=$HOME/mm-display-settings.sh
Terminal=false
EOF
)
if [ -d "$HOME/Desktop" ] && [ "$(cat "$ICON" 2>/dev/null)" != "$ICON_NEW" ]; then
    printf '%s\n' "$ICON_NEW" > "$ICON"
    chmod +x "$ICON"
    gio set "$ICON" metadata::xfce-exe-checksum "$(sha256sum "$ICON" | cut -d' ' -f1)" 2>/dev/null || true
    ok "Screen-off Times desktop icon installed"
fi

# Only rewritten when the line differs, so the nightly run doesn't churn it.
# The `|| true` matters: with pipefail, a grep -v that filters out every line
# fails, and the crontab would be replaced with an empty one.
CRON_DISPLAY="*/5 * * * * $HOME/mm-display.sh auto >/dev/null 2>&1"
if crontab -l 2>/dev/null | grep -qxF "$CRON_DISPLAY"; then
    skip "Screen-off cron already present"
else
    { crontab -l 2>/dev/null | grep -vF "mm-display.sh" || true; echo "$CRON_DISPLAY"; } | crontab -
    ok "Screen-off cron installed (checks every 5 min)"
fi

divider "MODULES COMPLETE — Run 03-portal-install.sh next"
