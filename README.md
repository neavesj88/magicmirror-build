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
- MagicMirror² — tracks upstream `master` via the weekly `mm-update.sh` cron
  (2.36.0 on the live unit as of 12 Sep 2026; upstream latest is 2.37.0)
- Weston compositor (MM² defaults to Wayland)
- Custom MMM-BTCAud module (BTC/AUD price + 7-day chart)
- Custom MMM-WallyMap module (white wireframe map of the current trip, pulled
  from the "Where's Wally" travel feed on neaves.au; hides itself when home)
- MMM-Remote-Control (phone management)
- WiFi config portal with hotspot failover
- OpenSSH for headless admin

## Quick Start

1. Install Debian 13 Trixie with XFCE on the mini PC
2. Create user `mirror` with sudo privileges
3. Install Node.js 22 LTS
4. Install MagicMirror²:
   ```bash
   cd ~ && git clone https://github.com/MagicMirrorOrg/MagicMirror
   cd MagicMirror && npm install --production
   ```
5. Clone this repo onto the mirror, then run the build scripts in order from the repo root:
   ```bash
   bash scripts/01-system-setup.sh 2>&1 | tee setup.log
   bash scripts/02-modules-install.sh 2>&1 | tee modules.log
   bash scripts/03-portal-install.sh 2>&1 | tee portal.log
   ```
   Script 02 installs the modules, configs and `custom.css` straight from `config/` and
   `modules/` in this repo — no manual copying needed. An existing
   `config-personal.js` on the device is never overwritten.
6. Reboot: `sudo reboot`

## Access

| What | URL |
|------|-----|
| Mirror display | http://mirror.local:8080 |
| Remote Control | http://mirror.local:8080/remote.html |
| Config Portal | http://mirror.local:8081 |
| SSH | `ssh mirror@mirror.local` |
| WiFi Setup Hotspot | SSID: MirrorSetup / Pass: mirror123 → http://192.168.4.1:8081 |

> The mirror display and Remote Control are served to the whole LAN with no auth
> (`ipWhitelist: []`, `secureEndpoints: false`). Fine behind a trusted home network,
> worth tightening if the box ever lands on a shared one.

## Management

```bash
~/mm-profile.sh guest        # switch to guest profile
~/mm-profile.sh personal     # switch to personal profile
~/mm-wifi.sh "SSID" "pass"   # change WiFi
~/mm-update.sh               # pull this repo + MM² + modules, restart if changed
~/mm-update.sh --force       # redeploy configs/modules even if nothing is new
systemctl --user restart magicmirror  # restart
```

### Updating

The mirror pulls; nothing is pushed to it. There is no route in from outside, so
`mm-update.sh` fetches this repo, redeploys `config/` and `modules/` through
script 02, then updates MM² core and every git-based module, restarting once if
anything actually moved.

- **Nightly at 03:00** by cron.
- **On demand** via the *Update Mirror* desktop icon, which runs it with
  `--force` in a terminal that stays open so the result can be read.

So a change pushed to GitHub reaches the mirror by itself. Two things it will
not do: it never resets which profile is live (`mm-profile.sh` owns that), and
it only reinstalls node modules when the repo actually moved, since that is not
worth doing nightly for nothing.

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

### SmartLife T&H Sensor Integration

A SmartLife temperature & humidity sensor (SmartLife is Tuya-based, so `tuyapi` works) could feed real local readings into the weather module.

- Fetch temp + humidity from the sensor via local Tuya protocol (`tuyapi` npm package)
- Fall back to the existing weather provider (OpenWeatherMap etc.) if the sensor is offline
- External provider still handles everything else: conditions, forecast, wind, UV

Would be a new custom module `MMM-SmartLifeTH`. Needs device ID and local key from the Tuya IoT developer portal.

## Files

```
scripts/
  01-system-setup.sh       # Packages, SSH, autologin, kiosk, debloat, fast boot
  02-modules-install.sh    # Installs modules + configs from this repo
  03-portal-install.sh     # WiFi config portal + hotspot watchdog
config/
  config-guest.js          # Guest profile — always reinstalled by script 02
  config-personal.js       # Personal profile seed — copied only if absent on device
  custom.css               # Portrait rotation CSS
  weston.ini               # Reference only; script 01 generates this with the
                           #   display output detected via xrandr
modules/
  MMM-BTCAud/              # Custom BTC/AUD price + chart module
  MMM-WallyMap/            # Wireframe travel map from the neaves.au travel feed
docs/
  blog-post.md             # Project blog post
  cheatsheet.pdf           # Printed A4 reference card
```

`config/` and `modules/` are the source of truth — edit them here, re-run script 02
on the mirror to deploy. The scripts no longer carry duplicate copies inline.
