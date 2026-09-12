#!/bin/bash
# ============================================================================
# 03-portal-install.sh — WiFi config portal + watchdog
# Run as: mirror
# Usage:  bash 03-portal-install.sh 2>&1 | tee portal.log
# ============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

divider() { echo ""; echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"; }

PORTAL_DIR="$HOME/mm-portal"
mkdir -p "$PORTAL_DIR"

# ════════════════════════════════════════════════════════════════════════════
divider "CONFIG PORTAL SERVER"
# ════════════════════════════════════════════════════════════════════════════

cat > "$PORTAL_DIR/server.js" << 'SERVEREOF'
const http = require("http");
const { execSync, exec } = require("child_process");
const url = require("url");
const os = require("os");

const PORT = 8081;

// Interface name is firmware/kernel dependent — detect it, fall back to the known one
const WIFI_IFACE = (() => {
	try {
		const out = execSync("nmcli -t -f DEVICE,TYPE device status").toString();
		const line = out.split("\n").find(l => l.trim().endsWith(":wifi"));
		if (line) return line.split(":")[0];
	} catch (e) {}
	return "wlp2s0";
})();

function getIP() {
	try {
		const ifaces = os.networkInterfaces();
		if (ifaces[WIFI_IFACE]) {
			for (const addr of ifaces[WIFI_IFACE]) {
				if (addr.family === "IPv4") return addr.address;
			}
		}
	} catch(e) {}
	return "unknown";
}

function getSSID() {
	try { return execSync(`iwgetid -r ${WIFI_IFACE} 2>/dev/null`).toString().trim(); }
	catch(e) { return "Not connected"; }
}

function getHostname() {
	try { return execSync("hostname").toString().trim(); } catch(e) { return "mirror"; }
}

function scanWifi() {
	try {
		const raw = execSync(`nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname ${WIFI_IFACE} --rescan yes 2>/dev/null`).toString();
		const seen = new Set();
		return raw.split("\n").filter(l => l.trim())
			.map(l => { const p = l.split(":"); return { ssid: p[0], signal: p[1], security: p.slice(2).join(":") }; })
			.filter(n => n.ssid && !seen.has(n.ssid) && seen.add(n.ssid))
			.sort((a, b) => parseInt(b.signal) - parseInt(a.signal));
	} catch(e) { return []; }
}

function htmlPage(body, refresh) {
	const r = refresh ? `<meta http-equiv="refresh" content="${refresh}">` : "";
	return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${r}<title>MagicMirror Config</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee;padding:20px;max-width:500px;margin:0 auto}
h1{color:#0ff;margin-bottom:10px;font-size:1.4em}
h2{color:#888;margin-bottom:20px;font-size:0.9em;font-weight:normal}
.card{background:#16213e;border-radius:12px;padding:20px;margin-bottom:15px}
.status{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #0d1b3e}
.status:last-child{border:none}
.label{color:#888}.value{color:#0ff;font-weight:bold}.value.bad{color:#f44}
input[type=text],input[type=password],select{width:100%;padding:12px;border-radius:8px;border:1px solid #333;background:#0d1b3e;color:#eee;font-size:16px;margin-bottom:10px}
button{width:100%;padding:14px;border-radius:8px;border:none;background:#0ff;color:#1a1a2e;font-weight:bold;font-size:16px;cursor:pointer;margin-top:5px}
button:active{opacity:0.8}
button.danger{background:#f44;color:#fff}
button.secondary{background:#333;color:#eee}
button.remote{background:#6c5ce7;color:#fff}
.msg{padding:15px;border-radius:8px;margin-bottom:15px;text-align:center}
.msg.ok{background:#0a3d0a;color:#4f4}
.msg.err{background:#3d0a0a;color:#f44}
.msg.info{background:#0a2a3d;color:#4cf}
.networks{max-height:200px;overflow-y:auto}
.net-item{padding:10px;border-bottom:1px solid #0d1b3e;cursor:pointer;display:flex;justify-content:space-between}
.net-item:active{background:#0d1b3e}
.signal{color:#888;font-size:0.9em}
a{color:#0ff}
</style>
</head><body>${body}</body></html>`;
}

const server = http.createServer((req, res) => {
	const parsed = url.parse(req.url, true);
	const path = parsed.pathname;
	res.setHeader("Content-Type", "text/html; charset=utf-8");

	if (path === "/" || path === "/index.html") {
		const ssid = getSSID();
		const ip = getIP();
		const hostname = getHostname();
		const connected = ssid !== "Not connected" && ssid !== "";
		const networks = scanWifi();

		const netOptions = networks.map(n =>
			`<div class="net-item" onclick="document.getElementById('ssid').value='${n.ssid.replace(/'/g, "\\'")}'">` +
			`<span>${n.ssid}</span><span class="signal">${n.signal}% ${n.security ? "🔒" : ""}</span></div>`
		).join("");

		const body = `
<h1>MagicMirror² Config</h1>
<h2>${hostname}</h2>

<div class="card">
 <div class="status"><span class="label">WiFi</span><span class="value ${connected ? '' : 'bad'}">${ssid}</span></div>
 <div class="status"><span class="label">IP Address</span><span class="value">${ip}</span></div>
 <div class="status"><span class="label">Hostname</span><span class="value">${hostname}.local</span></div>
 <div class="status"><span class="label">MM² Web</span><span class="value"><a href="http://${ip}:8080">http://${ip}:8080</a></span></div>
 <div class="status"><span class="label">Remote Control</span><span class="value"><a href="http://${ip}:8080/remote.html">remote.html</a></span></div>
</div>

<div class="card">
 <a href="http://${ip}:8080/remote.html"><button class="remote" type="button">Open Remote Control</button></a>
</div>

<div class="card">
 <h1 style="margin-bottom:15px">WiFi Settings</h1>
 ${networks.length > 0 ? `<p style="color:#888;margin-bottom:8px">Tap a network:</p><div class="networks">${netOptions}</div><br>` : ''}
 <form method="POST" action="/connect">
  <input type="text" id="ssid" name="ssid" placeholder="WiFi Network Name (SSID)" required>
  <input type="password" name="password" placeholder="WiFi Password" required>
  <label style="display:flex;align-items:center;gap:8px;margin:10px 0;color:#888">
   <input type="checkbox" name="static" value="1" checked> Use static IP
  </label>
  <input type="text" name="ip" placeholder="Static IP (e.g. 192.168.1.86)" value="${connected ? ip : ''}">
  <input type="text" name="gateway" placeholder="Gateway (e.g. 192.168.1.1)">
  <input type="text" name="dns" placeholder="DNS (e.g. 8.8.8.8,8.8.4.4)" value="8.8.8.8,8.8.4.4">
  <button type="submit">Connect</button>
 </form>
</div>

<div class="card">
 <h1 style="margin-bottom:15px">Mirror Control</h1>
 <form method="POST" action="/restart-mm"><button class="secondary" type="submit">Restart MagicMirror</button></form>
 <br>
 <form method="POST" action="/reboot"><button class="danger" type="submit">Reboot Device</button></form>
</div>`;
		res.end(htmlPage(body));

	} else if (path === "/connect" && req.method === "POST") {
		let rawBody = "";
		req.on("data", chunk => rawBody += chunk);
		req.on("end", () => {
			const params = new URLSearchParams(rawBody);
			const ssid = params.get("ssid"), password = params.get("password");
			const useStatic = params.get("static") === "1";
			const ip = params.get("ip"), gateway = params.get("gateway");
			const dns = params.get("dns") || "8.8.8.8,8.8.4.4";
			if (!ssid || !password) { res.end(htmlPage(`<div class="msg err">SSID and password required</div><a href="/">Back</a>`)); return; }
			try {
				try { execSync(`nmcli connection delete "${ssid}" 2>/dev/null`); } catch(e) {}
				try { execSync(`nmcli connection down Hotspot 2>/dev/null`); } catch(e) {}
				try { execSync(`nmcli connection delete Hotspot 2>/dev/null`); } catch(e) {}
				execSync(`nmcli device wifi connect "${ssid}" password "${password}" ifname ${WIFI_IFACE}`);
				if (useStatic && ip && gateway) {
					execSync(`nmcli connection modify "${ssid}" ipv4.method manual ipv4.addresses "${ip}/24" ipv4.gateway "${gateway}" ipv4.dns "${dns}"`);
					execSync(`nmcli connection up "${ssid}"`);
				}
				const newIP = useStatic && ip ? ip : getIP();
				res.end(htmlPage(`
<div class="msg ok">Connected to ${ssid}!</div>
<div class="card">
 <div class="status"><span class="label">New IP</span><span class="value">${newIP}</span></div>
 <div class="status"><span class="label">Config</span><span class="value"><a href="http://${newIP}:8081">http://${newIP}:8081</a></span></div>
 <div class="status"><span class="label">Mirror</span><span class="value"><a href="http://${newIP}:8080">http://${newIP}:8080</a></span></div>
 <div class="status"><span class="label">Remote</span><span class="value"><a href="http://${newIP}:8080/remote.html">remote.html</a></span></div>
</div>`));
			} catch(e) { res.end(htmlPage(`<div class="msg err">Failed: ${e.message}</div><a href="/">Back</a>`)); }
		});

	} else if (path === "/restart-mm" && req.method === "POST") {
		exec("systemctl --user restart magicmirror");
		res.end(htmlPage(`<div class="msg ok">MagicMirror restarting...</div>`, 5));
	} else if (path === "/reboot" && req.method === "POST") {
		res.end(htmlPage(`<div class="msg info">Rebooting in 3 seconds...</div>`));
		setTimeout(() => exec("sudo reboot"), 3000);
	} else {
		res.writeHead(302, { Location: "/" }); res.end();
	}
});

server.listen(PORT, "0.0.0.0", () => { console.log(`Config portal on http://0.0.0.0:${PORT}`); });
SERVEREOF
ok "Portal server created"

# ════════════════════════════════════════════════════════════════════════════
divider "WIFI WATCHDOG"
# ════════════════════════════════════════════════════════════════════════════

cat > "$PORTAL_DIR/watchdog.sh" << 'WATCHEOF'
#!/bin/bash
WIFI_IFACE="$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | grep ':wifi$' | head -1 | cut -d: -f1)"
WIFI_IFACE="${WIFI_IFACE:-wlp2s0}"
HOTSPOT_SSID="MirrorSetup"
HOTSPOT_PASS="mirror123"
CHECK_INTERVAL=30

is_wifi_connected() {
	local state=$(nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep "^${WIFI_IFACE}:" | cut -d: -f2)
	[ "$state" = "connected" ]
}

is_hotspot_active() {
	nmcli connection show --active 2>/dev/null | grep -q "Hotspot\|$HOTSPOT_SSID"
}

start_hotspot() {
	echo "$(date): WiFi down — starting hotspot"
	nmcli connection delete "$HOTSPOT_SSID" 2>/dev/null || true
	nmcli device wifi hotspot ifname "$WIFI_IFACE" ssid "$HOTSPOT_SSID" password "$HOTSPOT_PASS"
	sleep 2
	nmcli connection modify Hotspot ipv4.addresses "192.168.4.1/24" ipv4.method shared 2>/dev/null || true
	nmcli connection up Hotspot 2>/dev/null || true
	echo "$(date): Hotspot active — $HOTSPOT_SSID (pass: $HOTSPOT_PASS) → http://192.168.4.1:8081"
}

sleep 10
is_wifi_connected || start_hotspot

while true; do
	sleep "$CHECK_INTERVAL"
	if ! is_hotspot_active && ! is_wifi_connected; then
		start_hotspot
	fi
done
WATCHEOF
chmod +x "$PORTAL_DIR/watchdog.sh"
ok "WiFi watchdog created"

# ════════════════════════════════════════════════════════════════════════════
divider "SYSTEMD SERVICES"
# ════════════════════════════════════════════════════════════════════════════

mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/mm-portal.service << EOF
[Unit]
Description=MagicMirror Config Portal
After=network.target
[Service]
Type=simple
Restart=always
RestartSec=5
WorkingDirectory=$PORTAL_DIR
ExecStart=/usr/bin/node $PORTAL_DIR/server.js
[Install]
WantedBy=default.target
EOF

cat > ~/.config/systemd/user/mm-wifi-watchdog.service << EOF
[Unit]
Description=MagicMirror WiFi Watchdog
After=network.target
[Service]
Type=simple
Restart=always
RestartSec=10
ExecStart=$PORTAL_DIR/watchdog.sh
[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable mm-portal.service mm-wifi-watchdog.service
systemctl --user start mm-portal.service mm-wifi-watchdog.service
ok "Portal and watchdog enabled and started"

HOST="$(hostname).local"

divider "PORTAL INSTALL COMPLETE"
echo ""
echo "  Config portal:  http://${HOST}:8081"
echo "  Remote Control: http://${HOST}:8080/remote.html"
echo "  SSH:            ssh $(whoami)@${HOST}"
echo "  WiFi hotspot:   MirrorSetup (pass: mirror123) → http://192.168.4.1:8081"
echo ""
