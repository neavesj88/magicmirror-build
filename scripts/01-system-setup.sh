#!/bin/bash
# ============================================================================
# 01-system-setup.sh — Packages, autologin, kiosk mode, debloat, fast boot
# Run as: mirror (with sudo)
# Usage:  bash 01-system-setup.sh 2>&1 | tee setup.log
# ============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

divider() { echo ""; echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"; }

if [ "$(whoami)" = "root" ]; then echo -e "${RED}Run as mirror, not root${NC}"; exit 1; fi

MMDIR="$HOME/MagicMirror"
# Detect connected display output
DISPLAY_OUTPUT=$(xrandr --query 2>/dev/null | grep " connected" | head -1 | awk '{print $1}' || echo "DP-2")

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 1: PACKAGES"
# ════════════════════════════════════════════════════════════════════════════

info "Updating apt..."
sudo apt-get update -qq

PACKAGES=(weston net-tools x11-xserver-utils xdotool unclutter evtest openssh-server)
MISSING=()
for pkg in "${PACKAGES[@]}"; do
    dpkg -l "$pkg" 2>/dev/null | grep -q "^ii" || MISSING+=("$pkg")
done

if [ ${#MISSING[@]} -gt 0 ]; then
    info "Installing: ${MISSING[*]}"
    sudo apt-get install -y "${MISSING[@]}"
    ok "Packages installed"
else
    skip "All packages present"
fi

# Remote admin — the mirror is wall-mounted, so SSH is the only practical way in
sudo systemctl enable --now ssh
ok "SSH enabled (mirror.local:22)"

# Make /sbin available in PATH (ifconfig etc like Kali)
SBIN_PROFILE="/etc/profile.d/sbin-path.sh"
if [ ! -f "$SBIN_PROFILE" ]; then
    sudo tee "$SBIN_PROFILE" > /dev/null << 'EOF'
if [ -d /sbin ] && ! echo "$PATH" | grep -q "/sbin"; then
    export PATH="$PATH:/sbin:/usr/sbin"
fi
EOF
    sudo chmod 644 "$SBIN_PROFILE"
    ok "Added /sbin to system PATH"
else
    skip "/sbin PATH already configured"
fi

grep -qF '/sbin:/usr/sbin' "$HOME/.bashrc" || echo 'export PATH="$PATH:/sbin:/usr/sbin"' >> "$HOME/.bashrc"
export PATH="$PATH:/sbin:/usr/sbin"

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 2: LIGHTDM AUTOLOGIN"
# ════════════════════════════════════════════════════════════════════════════

getent group autologin &>/dev/null || { sudo groupadd -r autologin; ok "Created autologin group"; }
id -nG mirror | grep -qw autologin || { sudo gpasswd -a mirror autologin; ok "Added mirror to autologin"; }
id -nG mirror | grep -qw input || { sudo usermod -aG input mirror; ok "Added mirror to input group"; }

sudo tee /etc/lightdm/lightdm.conf > /dev/null << 'EOF'
[Seat:*]
autologin-guest=false
autologin-user=mirror
autologin-user-timeout=0
user-session=xfce
greeter-session=lightdm-gtk-greeter
EOF
ok "LightDM autologin configured"

PAM_FILE="/etc/pam.d/lightdm-autologin"
if grep -q "^auth.*required.*pam_succeed_if.so.*user != root" "$PAM_FILE" 2>/dev/null; then
    sudo sed -i 's/^auth.*required.*pam_succeed_if.so.*user != root.*quiet_success/# & # Disabled for autologin/' "$PAM_FILE"
    ok "PAM autologin fixed"
else
    skip "PAM already allows non-root autologin"
fi

loginctl show-user mirror 2>/dev/null | grep -q "Linger=yes" || { sudo loginctl enable-linger mirror; ok "Linger enabled"; }

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 3: WESTON CONFIG"
# ════════════════════════════════════════════════════════════════════════════

mkdir -p ~/.config
cat > ~/.config/weston.ini << EOF
[core]
idle-time=0

[shell]
panel-position=none
locking=false

[output]
name=${DISPLAY_OUTPUT}
mode=1920x1080
EOF
ok "Weston config created (no panels, no idle, fullscreen)"

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 4: MM² STARTUP SCRIPT + SERVICE"
# ════════════════════════════════════════════════════════════════════════════

cat > ~/mm-start.sh << 'EOF'
#!/bin/bash
export DISPLAY=:0.0
export XAUTHORITY=/home/mirror/.Xauthority
export HOME=/home/mirror

killall electron node weston 2>/dev/null
sleep 1

weston --width=1920 --height=1080 --fullscreen &
for i in $(seq 1 30); do
    [ -e "/run/user/$(id -u)/wayland-1" ] && break
    sleep 0.5
done
sleep 1

cd /home/mirror/MagicMirror
export WAYLAND_DISPLAY=wayland-1
exec npm start
EOF
chmod +x ~/mm-start.sh
ok "Created mm-start.sh"

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/magicmirror.service << EOF
[Unit]
Description=MagicMirror²
After=graphical-session.target

[Service]
Type=simple
Restart=always
RestartSec=10
Environment=DISPLAY=:0.0
Environment=XAUTHORITY=/home/mirror/.Xauthority
Environment=HOME=/home/mirror
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u)
ExecStart=/home/mirror/mm-start.sh
ExecStopPost=/bin/bash -c "killall weston 2>/dev/null || true"

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable magicmirror.service
ok "MagicMirror systemd service enabled"

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 5: KIOSK MODE"
# ════════════════════════════════════════════════════════════════════════════

mkdir -p ~/.config/autostart

# Disable screen blanking + hide cursor
cat > ~/.config/autostart/mm-kiosk.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=MM Kiosk Setup
Exec=bash -c "sleep 2 && xset s off && xset s noblank && xset -dpms && unclutter -idle 3 -root &"
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

# Kill XFCE panel
cat > ~/.config/autostart/kill-panel.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Kill XFCE Panel
Exec=bash -c "sleep 1 && killall xfce4-panel 2>/dev/null; true"
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
ok "Kiosk autostart entries created"

# Hide panels
xfce4-panel --quit 2>/dev/null || true
sleep 1
xfconf-query -c xfce4-panel -p /panels -r -R 2>/dev/null || true
xfconf-query -c xfce4-panel -p /plugins -r -R 2>/dev/null || true

# Desktop icons on (for Stop/Start Mirror)
xfconf-query -c xfce4-desktop -p /desktop-icons/style -n -t int -s 2 2>/dev/null || true

# Black background
xfconf-query -c xfce4-desktop -p "/backdrop/screen0/monitor${DISPLAY_OUTPUT}/workspace0/image-style" -n -t int -s 0 2>/dev/null || true
xfconf-query -c xfce4-desktop -p "/backdrop/screen0/monitor${DISPLAY_OUTPUT}/workspace0/color-style" -n -t int -s 0 2>/dev/null || true
xfconf-query -c xfce4-desktop -p "/backdrop/screen0/monitor${DISPLAY_OUTPUT}/workspace0/rgba1" -n -t double -t double -t double -t double -s 0.0 -s 0.0 -s 0.0 -s 1.0 2>/dev/null || true
ok "Desktop set to black, panels removed"

# Purge screensaver/power manager
for pkg in xfce4-screensaver xfce4-power-manager; do
    dpkg -l "$pkg" 2>/dev/null | grep -q "^ii" && { sudo apt-get purge -y "$pkg"; ok "Removed $pkg"; } || true
done

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 6: DEBLOAT"
# ════════════════════════════════════════════════════════════════════════════

BLOAT=(libreoffice-common libreoffice-core cups cups-browsed cups-daemon
       system-config-printer blueman bluetooth bluez at-spi2-core
       evolution-data-server simple-scan sane-utils parole vlc tumbler
       yelp xfce4-screenshooter xfce4-taskmanager xfce4-notifyd gnome-disk-utility)

REMOVABLE=()
for pkg in "${BLOAT[@]}"; do
    dpkg -l "$pkg" 2>/dev/null | grep -q "^ii" && REMOVABLE+=("$pkg")
done

if [ ${#REMOVABLE[@]} -gt 0 ]; then
    info "Removing: ${REMOVABLE[*]}"
    sudo apt-get purge -y "${REMOVABLE[@]}" 2>/dev/null || true
    sudo apt-get autoremove -y
    ok "Bloat removed"
else
    skip "No bloat to remove"
fi

# Disable unnecessary services
for svc in ModemManager cups cups-browsed bluetooth; do
    systemctl is-enabled "$svc" 2>/dev/null | grep -q "enabled" && { sudo systemctl disable --now "$svc" 2>/dev/null || true; ok "Disabled $svc"; } || true
done

# Keep avahi for mirror.local
sudo systemctl enable avahi-daemon
sudo systemctl start avahi-daemon 2>/dev/null || true
ok "avahi-daemon enabled (mirror.local)"

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 7: POWER FAILURE RECOVERY + FAST BOOT"
# ════════════════════════════════════════════════════════════════════════════

# Disable all sleep
sudo mkdir -p /etc/systemd/sleep.conf.d
sudo tee /etc/systemd/sleep.conf.d/nosleep.conf > /dev/null << 'EOF'
[Sleep]
AllowSuspend=no
AllowHibernation=no
AllowSuspendThenHibernate=no
AllowHybridSleep=no
EOF

for target in sleep.target suspend.target hibernate.target hybrid-sleep.target; do
    sudo systemctl mask "$target" 2>/dev/null || true
done
ok "Sleep/suspend/hibernate disabled"

# GRUB timeout
if grep -q "GRUB_TIMEOUT=5" /etc/default/grub 2>/dev/null; then
    sudo sed -i 's/GRUB_TIMEOUT=5/GRUB_TIMEOUT=1/' /etc/default/grub
    sudo update-grub 2>/dev/null || true
    ok "GRUB timeout → 1 second"
fi

# Volatile journal (save eMMC)
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/volatile.conf > /dev/null << 'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=30M
EOF
ok "Journald set to volatile"

# Sudoers for passwordless reboot
SUDOERS_FILE="/etc/sudoers.d/mirror-reboot"
if [ ! -f "$SUDOERS_FILE" ]; then
    sudo tee "$SUDOERS_FILE" > /dev/null << 'EOF'
mirror ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown
EOF
    sudo chmod 440 "$SUDOERS_FILE"
    ok "Passwordless reboot configured"
fi

warn "MANUAL: Enter BIOS → set 'After Power Failure → Power On'"

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 8: DESKTOP ICONS"
# ════════════════════════════════════════════════════════════════════════════

mkdir -p ~/Desktop

FIREFOX_BIN=$(which firefox-esr 2>/dev/null || which firefox 2>/dev/null || echo "")
if [ -z "$FIREFOX_BIN" ]; then
    sudo apt-get install -y firefox-esr
    FIREFOX_BIN=$(which firefox-esr)
fi

cat > ~/Desktop/Firefox.desktop << EOF
[Desktop Entry]
Type=Application
Name=Firefox
Icon=firefox-esr
Exec=$FIREFOX_BIN
Terminal=false
EOF

cat > ~/Desktop/Terminal.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Terminal
Icon=utilities-terminal
Exec=xfce4-terminal
Terminal=false
EOF

cat > ~/Desktop/Stop-Mirror.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Stop Mirror
Icon=process-stop
Exec=bash -c "systemctl --user stop magicmirror; killall weston electron node 2>/dev/null; xfce4-panel & xfce4-desktop &"
Terminal=false
EOF

cat > ~/Desktop/Start-Mirror.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Start Mirror
Icon=video-display
Exec=bash -c "killall xfce4-panel 2>/dev/null; systemctl --user restart magicmirror"
Terminal=false
EOF

cat > ~/Desktop/Update-Mirror.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Update Mirror
Icon=system-software-update
Exec=xfce4-terminal --title=Mirror-Update -e /home/mirror/mm-update-interactive.sh
Terminal=false
EOF

chmod +x ~/Desktop/*.desktop
for f in ~/Desktop/*.desktop; do
    gio set "$f" metadata::xfce-exe-checksum "$(sha256sum "$f" | cut -d' ' -f1)" 2>/dev/null || true
done
ok "Desktop icons created and trusted"

# ════════════════════════════════════════════════════════════════════════════
divider "PHASE 9: UTILITY SCRIPTS"
# ════════════════════════════════════════════════════════════════════════════

# Profile switcher
cat > ~/mm-profile.sh << 'EOF'
#!/bin/bash
MMDIR="$HOME/MagicMirror"
PROFILE="${1:-}"
if [ "$PROFILE" != "guest" ] && [ "$PROFILE" != "personal" ]; then
    CURRENT=$(readlink -f "$MMDIR/config/config.js" 2>/dev/null || echo "unknown")
    echo "Current: $CURRENT"
    echo "Usage: $0 [guest|personal]"
    exit 1
fi
ln -sf "$MMDIR/config/config-${PROFILE}.js" "$MMDIR/config/config.js"
systemctl --user restart magicmirror
echo "Switched to $PROFILE."
EOF
chmod +x ~/mm-profile.sh

# Auto updater — this build repo, then MM² core and every git-based module, so
# updatenotification stops nagging. Restarts only when something changed.
#
# Pulling the build repo here is what lets a change pushed to GitHub reach the
# mirror on its own: there is no shell access to this box from outside, so the
# mirror fetches rather than being deployed to.
cat > ~/mm-update.sh << 'EOF'
#!/bin/bash
LOG="$HOME/mm-update.log"
MMDIR="$HOME/MagicMirror"
# Cloned here if absent, so this works even on a box where the repo was first
# unpacked somewhere else.
BUILD_REPO="$HOME/magicmirror-build"
BUILD_URL="https://github.com/neavesj88/magicmirror-build.git"
CHANGED=0
# "dir|pre-pull-hash" per updated repo, so a failed start can be undone.
ROLLBACK=""

# --force redeploys the configs and modules even when nothing new was pushed,
# which is what the desktop icon wants: clicking it should always apply.
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Summary lines go to the terminal as well as the log, so the desktop icon
# shows something useful. Command output stays in the log only.
log() { echo "$*" | tee -a "$LOG"; }

# Don't let the log eat the eMMC
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 1000000 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

log ""
log "=== MM² Update: $(date) ==="

# Pull one repo, npm install if it moved. Never aborts the run on failure —
# one broken module must not stop the rest from updating.
update_repo() {
    local dir="$1" label="$2" before after
    cd "$dir" 2>/dev/null || { log "  $label: missing, skipped"; return 0; }
    before=$(git rev-parse HEAD 2>/dev/null) || { log "  $label: not a git repo, skipped"; return 0; }
    if ! git pull --ff-only >> "$LOG" 2>&1; then
        log "  $label: pull failed (local edits or diverged), skipped"
        return 0
    fi
    after=$(git rev-parse HEAD)
    if [ "$before" = "$after" ]; then
        log "  $label: up to date"
        return 0
    fi
    log "  $label: ${before:0:8} -> ${after:0:8}"
    if [ -f package.json ]; then
        # A failed npm install used to still set CHANGED, so the mirror was
        # restarted into half-installed dependencies and came back broken. Put
        # the repo back where it was instead and leave the working tree alone.
        if ! npm install --omit=dev >> "$LOG" 2>&1; then
            log "  $label: npm install FAILED, rolling back to ${before:0:8}"
            git reset --hard "$before" >> "$LOG" 2>&1
            npm install --omit=dev >> "$LOG" 2>&1 || log "  $label: rollback npm also failed"
            return 0
        fi
    fi
    # Remembered so a failed start can put everything back.
    ROLLBACK="$ROLLBACK$dir|$before"$'\n'
    CHANGED=1
}

# The build repo first, so new module files are in place before anything is
# restarted. Redeploys only when it actually moved, because 02 reinstalls node
# modules and that is not worth doing nightly for nothing.
deploy_build_repo() {
    local before after
    if [ ! -d "$BUILD_REPO/.git" ]; then
        log "  build repo: cloning into $BUILD_REPO"
        git clone "$BUILD_URL" "$BUILD_REPO" >> "$LOG" 2>&1 || {
            log "  build repo: clone FAILED"; return 0; }
    else
        cd "$BUILD_REPO" 2>/dev/null || { log "  build repo: unreadable, skipped"; return 0; }
        before=$(git rev-parse HEAD 2>/dev/null)
        if ! git pull --ff-only >> "$LOG" 2>&1; then
            log "  build repo: pull failed (local edits or diverged), skipped"
            return 0
        fi
        after=$(git rev-parse HEAD)
        if [ "$before" = "$after" ]; then
            log "  build repo: up to date"
            [ "$FORCE" = "0" ] && return 0
            log "  build repo: forced redeploy"
        else
            log "  build repo: ${before:0:8} -> ${after:0:8}"
        fi
    fi

    if bash "$BUILD_REPO/scripts/02-modules-install.sh" >> "$LOG" 2>&1; then
        log "  build repo: modules and configs redeployed"
        CHANGED=1
    else
        log "  build repo: redeploy FAILED, see $LOG"
    fi
}

deploy_build_repo

update_repo "$MMDIR" "MagicMirror core"

# Custom modules are deployed from the build repo, not cloned, so they have no
# .git and are skipped automatically.
for d in "$MMDIR"/modules/*/; do
    [ -d "$d/.git" ] || continue
    update_repo "$d" "$(basename "$d")"
done

if [ "$CHANGED" != "1" ]; then
    log "Done - nothing to update."
    exit 0
fi

log "Restarting MagicMirror..."
systemctl --user restart magicmirror >> "$LOG" 2>&1

# Did it actually come back? This runs at 03:00 with nobody able to look, and
# the core is pulled from upstream master, so "the update ran" is not the same
# as "the mirror still works". Give it time to boot Electron, then check the
# unit is up and the web server is actually answering.
healthy() {
    systemctl --user is-active --quiet magicmirror || return 1
    command -v curl >/dev/null 2>&1 || return 0
    curl -fsS -m 5 -o /dev/null "http://127.0.0.1:8080" 2>/dev/null
}

OK=0
for _ in 1 2 3 4 5 6; do
    sleep 10
    if healthy; then OK=1; break; fi
done

if [ "$OK" = "1" ]; then
    log "Done - updates applied, mirror healthy."
    exit 0
fi

# Unhealthy. Put every repo that moved back where it was and restart again -
# a stale mirror is recoverable, a dead one on a bathroom wall is not.
log "MIRROR DID NOT COME BACK - rolling back"
while IFS='|' read -r dir hash; do
    [ -n "$dir" ] || continue
    cd "$dir" 2>/dev/null || continue
    log "  reverting $(basename "$dir") to ${hash:0:8}"
    git reset --hard "$hash" >> "$LOG" 2>&1
    [ -f package.json ] && npm install --omit=dev >> "$LOG" 2>&1
done <<< "$ROLLBACK"

systemctl --user restart magicmirror >> "$LOG" 2>&1
sleep 20
if healthy; then
    log "Done - rolled back, mirror healthy again."
else
    log "Done - ROLLED BACK BUT STILL UNHEALTHY, needs a human."
fi
EOF
chmod +x ~/mm-update.sh

# What the desktop icon runs: force a redeploy even with nothing new pushed,
# then hold the window open so the result can actually be read.
cat > ~/mm-update-interactive.sh << 'EOF'
#!/bin/bash
"$HOME/mm-update.sh" --force
echo
read -rp "Finished - press Enter to close "
EOF
chmod +x ~/mm-update-interactive.sh

# WiFi helper
cat > ~/mm-wifi.sh << 'EOF'
#!/bin/bash
SSID="${1:-}"; PASS="${2:-}"
if [ -z "$SSID" ]; then
    nmcli device wifi list
    echo ""; echo "Usage: $0 \"SSID\" \"password\""; exit 1
fi
if nmcli connection show "$SSID" &>/dev/null; then
    nmcli connection modify "$SSID" wifi-sec.psk "$PASS"
    nmcli connection up "$SSID"
else
    nmcli device wifi connect "$SSID" password "$PASS"
fi
ip -br addr | grep wlp
EOF
chmod +x ~/mm-wifi.sh

ok "Utility scripts created"

# Nightly updates. Rewrites any existing entry so re-running this script
# corrects the schedule instead of leaving a stale one behind.
# Redirected because log() also writes to stdout now, and cron would otherwise
# try to mail every run.
CRON_LINE="0 3 * * * $HOME/mm-update.sh >/dev/null 2>&1"
( crontab -l 2>/dev/null | grep -vF "mm-update.sh"; echo "$CRON_LINE" ) | crontab -
ok "Update cron installed (daily 03:00)"

divider "SYSTEM SETUP COMPLETE — Run 02-modules-install.sh next"
