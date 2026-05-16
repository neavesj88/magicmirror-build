# MagicMirror

## In Progress

### Project Description

I had a spare laptop screen sitting around doing nothing and came across MagicMirror² - an open-source platform for building smart mirrors. Figured it was a good excuse to finally do something with it.

The concept is straightforward. Two-way mirror glass in front of a display, with a small fanless mini PC behind it running MagicMirror² on Debian. It shows the time, weather, WA public holidays, news from a few Australian sources, and a custom Bitcoin price module I wrote that pulls the AUD price from CoinGecko with a 7-day chart. The whole thing is portrait orientation and sits in my bathroom.

The mini PC runs headless in kiosk mode - it auto-logs in, launches the mirror display fullscreen on boot, and comes back up on its own after a power outage. I've got MMM-Remote-Control installed so I can manage everything from my phone, and there's a WiFi config portal that creates a setup hotspot if it ever loses connection, so I don't need to plug a keyboard in to change networks.

I built a custom module (MMM-BTCAud) for the Bitcoin price display since the existing ones didn't do exactly what I wanted. It shows the current price, 24h and 7d changes, and a canvas-drawn chart that follows whatever global colour theme I set.

One thing I'm particularly proud of is the WiFi failover. If the mirror can't connect to its configured network — say the password changes or it gets moved to a different house — it automatically broadcasts its own hotspot called "MirrorSetup". You connect to that from your phone, browse to the config page, enter the new WiFi credentials, and it switches over. No keyboard needed, no terminal access, just works. I wanted this to be something anyone could maintain, not just me.

To that end I also printed a cheatsheet onto thick card and stuck it behind the mirror. It's got the login details, IP addresses, keyboard shortcuts, how to stop and start the mirror, where the config files live, and how to use the WiFi setup hotspot. If someone else ends up with this thing after me, they should have a fighting chance of keeping it going.

Most of the coding was done with AI assistance — I used Claude to help build the setup scripts, the custom BTC module, the WiFi portal, and the kiosk automation. It's genuinely effective at taking something I can picture in my head and turning it into working code far quicker than I could have done on my own. The ideas and the direction were mine, but having an AI that can write systemd services and Node.js modules on the fly was a massive time saver.

Still need to convert the power setup to run entirely off USB-C.

### Project Info

**Status:** In Progress  
**Progress:** 90%

### Technologies

- MagicMirror² v2.35.0
- Debian 13 (Trixie)
- JavaScript (custom modules)
- CoinGecko API
- systemd
- NetworkManager

### Project Journal

**April 5, 2026**

Got the mini PC set up with Debian and MagicMirror² installed. Configured the static IP, time sync, and mDNS so I can reach it at mirror.local on the network. Set up the full kiosk mode — autologin, autostart, panels removed, black desktop, cursor hidden, screen blanking disabled. After a reboot it comes straight up in portrait fullscreen with no interaction needed.

**April 6, 2026**

Built the custom BTC/AUD module and installed MMM-Remote-Control for phone management. Also set up a WiFi watchdog that creates a hotspot if the network drops, so I can reconfigure it from my phone without needing physical access. Mounted it in the bathroom and it's been running solid since.

**Parts List**

Everything was sourced from AliExpress. The laptop screen I already had, and the mini PC I picked up separately. Total for the parts below came to about $95 AUD.

| Part | Cost (AUD) |
|------|-----------|
| 300x400x3mm two-way acrylic mirror (PMMA) x2 | ~$50 |
| 30-pin eDP LCD driver board (HDMI/USB-C, 1920x1080) | $24.48 |
| Black aluminium alloy frame (30x40cm) | $15.32 |
| Bi-direction HDMI switch | $4.52 |
| 5.5x2.1mm DC power pigtails (5 pairs) | $3.15 |
| USB-C female chassis mount connectors | ~$4 |

The two mirror panels are 300x400mm each and 3mm thick — I needed two to cover the full screen area. The eDP driver board takes the laptop's 30-pin panel and gives it HDMI and USB-C inputs, which is what makes the whole thing work without the original laptop. The frame is just a cheap aluminium canvas frame that fits the 30x40cm mirror panels perfectly. The DC pigtails and USB-C connectors are for converting the whole power setup to run off a single USB-C cable, which is still on the to-do list.
