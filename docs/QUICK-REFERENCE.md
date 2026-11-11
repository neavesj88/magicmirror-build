# MagicMirror² quick reference

The everyday card for a mirror built from this repo. Anything in `<angle brackets>`
is specific to your own unit. Fill those in on your printed copy, and never in
this file.

## Logins and addresses

| | |
|---|---|
| Username | `mirror` |
| Password (sudo) | `<sudo-password>` |
| Hostname / IP | `mirror.local` · `<mirror-ip>` |
| SSH | `ssh -i <path-to-ssh-key> mirror@<mirror-ip>` |
| House WiFi | `<home-wifi-ssid>` |
| Setup hotspot | `MirrorSetup` · `<hotspot-password>` (default `mirror123`, set by `HOTSPOT_PASS` in `scripts/03-portal-install.sh`) |

| Address | What it is |
|---|---|
| `http://<mirror-ip>:8080` | The mirror display, live |
| `http://<mirror-ip>:8080/remote.html` | Remote Control: restart, show/hide modules, install modules |
| `http://<mirror-ip>:8081` | WiFi portal: change network, status, reboot |

Remote Control's brightness slider dims the *picture* in software. It cannot
make the panel brighter than the display board's own setting.

## What's on the mirror

| Position | Module |
|---|---|
| Top bar | Update notice, only shown when MagicMirror itself has a new release |
| Top left | Clock and a public-holiday calendar |
| Top right | Current weather and the forecast |
| Middle | [MMM-WallyMap](../modules/MMM-WallyMap) travel map while a trip is live; otherwise [MMM-BTCAud](../modules/MMM-BTCAud), the BTC/AUD price with a 7-day chart |
| Bottom bar | [MMM-Newswire](../modules/MMM-Newswire) news ticker |

### How the news ticker behaves

| Rule | Default |
|---|---|
| Feeds re-checked | every 4 h; a failed feed retries after 10 min |
| Headline retired | older than 48 h (per feed with `maxItemAgeHours`) |
| "Offline" marker | a feed on the bar hasn't refreshed for 5 h |
| Bar clears | after 12 h without a refresh, showing "Headlines unavailable" rather than old news |
| Animation | `animation: "roll"` (default), `"marquee"`, `"fade"` or `"wipe"` |

## Automatic updates

Every night at **03:00**, cron runs `~/mm-update.sh`. To deploy a change, push it
to GitHub. Nothing is ever copied onto the mirror by hand.

1. **Build repo**: pulls this repo, then redeploys the configs, `custom.css` and the custom modules.
2. **Upstream**: pulls MagicMirror core and every cloned module, and fetches Electron before restarting.
3. **Restart**: only when something actually changed. Otherwise the log says "nothing to update".
4. **Health check**: waits up to 60 s for the page to answer. If it doesn't, every repo is put back where it was and the mirror restarts.

To run it now, double-click **Update Mirror** on the desktop, or over SSH:

```sh
~/mm-update.sh --force
```

To check last night's run:

```sh
tail -5 ~/mm-update.log
```

The last line should say "nothing to update" or "mirror healthy". "needs a human" means the run failed.

## Overnight screen-off

From **23:00 to 05:00** the display board is switched off, because an LCD's
backlight shows through the mirror as a grey box even when the page is black.
It's checked every 5 min, so a reboot in the night goes dark again within minutes.

| To | Do |
|---|---|
| Change the hours, or turn it off | Double-click **Screen-off Times** on the desktop. That's saved on the mirror and updates won't undo it; picking 23:00 / 05:00 / On again goes back to the repo's times |
| Change the repo default | `OFF_AT`, `ON_AT`, `NIGHT_OFF` in `config/display.conf`, push, then update |
| Wake it now | `~/mm-display.sh on`. At night it stays on until 05:00, then the normal schedule carries on |
| Turn it off now | `~/mm-display.sh off`. In the day it stays off until `on`; at night it still wakes at 05:00 |
| Check | `~/mm-display.sh status`, log in `~/mm-display.log` |

## Changing the config

> **Edit in the repo, not on the mirror.** Each update copies `config/config-guest.js`
> and `config/custom.css` over the mirror's copies, so an edit made on the device
> is gone by morning. Edit, push, then click **Update Mirror** (or wait for 03:00).

| File in the repo | Purpose |
|---|---|
| `config/config-guest.js` | The live profile. On the mirror, `~/MagicMirror/config/config.js` is a symlink to it |
| `config/config-personal.js` | Second profile. Copied only if missing, so the device's copy does not follow the repo |
| `config/custom.css` | Portrait rotation and global styles |
| `modules/MMM-*/` | The custom modules; each README lists every option |

| To change | Look for | Notes |
|---|---|---|
| 12 / 24 h clock | `timeFormat: 24` | top of file |
| Weather location | `lat` / `lon` | in **both** weather modules |
| News feeds | `module: "MMM-Newswire"` | `feeds: [...]`, each with optional `weight` and `maxItems` |
| Calendars | `module: "calendar"` | add to `calendars: [...]` |
| Module position | `position:` | `top_bar`, `top_left`, `top_right`, `middle_center`, `bottom_bar` … |
| Who can connect | `ipWhitelist: []` | empty means anyone on the LAN |

Add a news feed, inside the Newswire `feeds: [...]` list:

```js
{ title: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", maxItems: 4 },
```

Add a Google Calendar: in Google Calendar, go to Settings → your calendar → *Secret address in iCal format*, then add this inside `calendars: [...]`:

```js
{ symbol: "calendar", url: "PASTE_ICAL_URL" },
```

Check a config before pushing it: `cd ~/MagicMirror && node --run config:check`

**Adding a module:** install it from **remote.html → Modules**, or `git clone` it into
`~/MagicMirror/modules` and run `npm install --omit=dev` inside it. Cloned modules
are updated every night with the rest. Put its config block in the repo's
`config-guest.js`, or the next update removes it from the screen.

## On the mirror itself

| Desktop icon | What it does |
|---|---|
| **Stop Mirror** | Closes MagicMirror and brings back the XFCE desktop |
| **Start Mirror** | Starts it again, fullscreen |
| **Update Mirror** | Runs the update now and shows the result |
| **Screen-off Times** | Change when the screen switches off overnight, or turn that off |
| **Cheat sheet PDF** | The printed card, if one has been copied to `~/Desktop`. It opens in Atril on top of the running mirror. Rotate it 90° first (PDF page rotation), because the desktop isn't turned for the portrait panel |
| **Terminal**, **Firefox** | As named |

```sh
systemctl --user status  magicmirror
systemctl --user restart magicmirror
systemctl --user stop    magicmirror
sudo reboot          # no password needed
sudo shutdown now    # no password needed
```

> **Text console (Ctrl+Alt+F2): always log out before leaving.** Type `exit` before
> Ctrl+Alt+F7. A login left open there holds the screen, and MagicMirror crash-loops
> (`no drm device found`). To fix it, find the session with `loginctl`, run
> `loginctl terminate-session <id>`, then `sudo reboot`.

## WiFi and moving house

A watchdog checks the WiFi every 30 s. If the mirror can't reach `<home-wifi-ssid>`,
it starts its own hotspot:

1. On your phone, join **MirrorSetup** with `<hotspot-password>`.
2. Browse to `http://192.168.4.1:8081`.
3. Enter the new network and password (and a static IP if you want one).
4. The mirror joins it. While the hotspot is up, it also retries the saved WiFi every 5 min, so a router outage clears by itself.

From a terminal: `~/mm-wifi.sh "SSID" "password"`. Run it with no arguments to list networks.

## Troubleshooting

| Problem | Fix |
|---|---|
| Black screen | Between 23:00 and 05:00 that's the screen-off; `~/mm-display.sh on` wakes it. Otherwise open `:8080` from another machine. If it loads, the fault is the display, not MagicMirror. If it doesn't, run `systemctl --user status magicmirror`, then restart it |
| Screen dim | Software and the board are already at full (`ddcutil getvcp 10` reads 100/100). What's left is the panel itself behind the acrylic: try `ddcutil setvcp 12 75` (contrast; 50 is default), or a brighter panel |
| Config won't load | `node --run config:check` in `~/MagicMirror` |
| Module missing | Check its block is in the **repo's** `config-guest.js` and was pushed, then run Update Mirror |
| "Headlines unavailable" | No feed has refreshed for 12 h, usually because there's no internet. Check the WiFi portal at `:8081` |
| Update log: "needs a human" | Read the log above that line: `tail -60 ~/mm-update.log`. The mirror is usually still running the old version |
| Wrong rotation | In the repo's `config/custom.css`, swap `90deg` ↔ `-90deg`, push, then update |
| Escape the kiosk | Double-click **Stop Mirror** |
| No network | Wait for the MirrorSetup hotspot (above), or in a terminal check `ip -br addr`, then run `sudo systemctl restart NetworkManager` |
| Screenshot | Over SSH, run `DISPLAY=:0 XAUTHORITY=~/.Xauthority scrot -o /tmp/shot.png`. The image comes out sideways, so rotate it 90° |

### Forgot the password

Plug in a keyboard and reboot. The boot menu only waits 1 s, so tap **Esc** as the
mirror starts. On the Debian entry, press **e**, go to the end of the line starting
`linux`, and add `init=/bin/bash`. Press **Ctrl+X**, then run:

```sh
mount -o remount,rw /
passwd mirror
sync
reboot -f
```

The edit only lasts for that one boot.

---

Built for MagicMirror² 2.38 on Debian 13 (Trixie), running on a fanless Celeron N3350 mini PC.
