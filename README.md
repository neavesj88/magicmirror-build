# MagicMirror² Build

Complete build scripts and config for a MagicMirror² smart mirror kiosk.

## Hardware

- Fanless mini PC (Celeron N3350, 4GB RAM, 32GB eMMC)
- Salvaged laptop screen (1920x1080, 30-pin eDP)
- 30-pin eDP LCD driver board (HDMI/USB-C input)
- 300x400x3mm two-way acrylic mirror (PMMA) x2
- Black aluminium canvas frame (30x40cm)
- USB-C female chassis mount connectors
- DC power pigtails for USB-C conversion

## Software

- Debian 13 (Trixie) with XFCE
- MagicMirror² v2.35.0
- Weston compositor (MM² defaults to Wayland)
- Custom MMM-BTCAud module (BTC/AUD price + 7-day chart)
- MMM-Remote-Control + Repository (phone management)
- WiFi config portal with hotspot failover

## Quick Start

1. Install Debian 13 Trixie with XFCE on the mini PC
2. Create user `mirror` with sudo privileges
3. Install Node.js 22 LTS
4. Install MagicMirror²:
   ```bash
   cd ~ && git clone https://github.com/MagicMirrorOrg/MagicMirror
   cd MagicMirror && npm install --production
   ```
5. Run the build scripts in order:
   ```bash
   bash scripts/01-system-setup.sh 2>&1 | tee setup.log
   bash scripts/02-modules-install.sh 2>&1 | tee modules.log
   bash scripts/03-portal-install.sh 2>&1 | tee portal.log
   ```
6. Copy config files:
   ```bash
   cp config/config-guest.js ~/MagicMirror/config/
   cp config/config-personal.js ~/MagicMirror/config/
   ln -sf ~/MagicMirror/config/config-guest.js ~/MagicMirror/config/config.js
   ```
7. Copy custom module:
   ```bash
   cp -r modules/MMM-BTCAud ~/MagicMirror/modules/
   ```
8. Reboot: `sudo reboot`

## Access

| What | URL |
|------|-----|
| Mirror display | http://mirror.local:8080 |
| Remote Control | http://mirror.local:8080/remote.html |
| Config Portal | http://mirror.local:8081 |
| WiFi Setup Hotspot | SSID: MirrorSetup / Pass: mirror123 → http://192.168.4.1:8081 |

## Management

```bash
~/mm-profile.sh guest        # switch to guest profile
~/mm-profile.sh personal     # switch to personal profile
~/mm-wifi.sh "SSID" "pass"   # change WiFi
~/mm-update.sh               # manual MM² update
systemctl --user restart magicmirror  # restart
```

## Future Ideas

### Second Mirror via Chromecast

A Chromecast can display the MagicMirror page on any TV or monitor without a second Pi.

**Standard Chromecast dongle** — needs something to initiate the cast. Run `catt` from the MagicMirror Pi itself:

```bash
pip install catt
catt -d "Living Room TV" cast_site http://192.168.20.86:8080/
```

Add to a startup script so it casts on boot. Downside: if the cast drops, it needs to be re-initiated.

**Chromecast with Google TV** — runs Android TV, so you can sideload a kiosk browser app and point it at the mirror URL directly. No initiator needed, self-recovering.

## Files

```
scripts/
  01-system-setup.sh       # Packages, autologin, kiosk, debloat, fast boot
  02-modules-install.sh    # MMM-Remote-Control, MMM-BTCAud, desktop icons
  03-portal-install.sh     # WiFi config portal + watchdog
config/
  config-guest.js          # Guest profile
  config-personal.js       # Personal profile (crypto/stats placeholders)
  weston.ini               # Weston compositor config (no bars, fullscreen)
  custom.css               # Portrait rotation CSS
modules/
  MMM-BTCAud/              # Custom BTC/AUD price + chart module
docs/
  blog-post.md             # Project blog post
  cheatsheet.pdf           # Printed A4 reference card
```
