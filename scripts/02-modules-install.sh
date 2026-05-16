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

if [ -d "$REPO_DIR/modules/MMM-BTCAud" ]; then
    cp -r "$REPO_DIR/modules/MMM-BTCAud" "$MMDIR/modules/"
    ok "MMM-BTCAud copied from repo"
else
    info "Creating MMM-BTCAud from scratch..."
    mkdir -p "$MMDIR/modules/MMM-BTCAud"

    # Will be created inline below
fi

# Ensure the module files exist regardless of source
MODULE_DIR="$MMDIR/modules/MMM-BTCAud"
mkdir -p "$MODULE_DIR"

cat > "$MODULE_DIR/MMM-BTCAud.js" << 'MODEOF'
Module.register("MMM-BTCAud", {
	defaults: {
		updateInterval: 5 * 60 * 1000,
		currency: "aud",
		coin: "bitcoin",
		chartDays: 7,
		chartWidth: 400,
		chartHeight: 150,
		showChange: true,
		animationSpeed: 1000,
	},
	getStyles: function () { return ["MMM-BTCAud.css"]; },
	start: function () {
		this.price = null; this.change24h = null; this.change7d = null;
		this.chartData = []; this.loaded = false;
		this.getData();
		setInterval(() => this.getData(), this.config.updateInterval);
	},
	getData: function () {
		this.sendSocketNotification("BTC_GET_DATA", {
			coin: this.config.coin, currency: this.config.currency, days: this.config.chartDays,
		});
	},
	socketNotificationReceived: function (notification, payload) {
		if (notification === "BTC_DATA") {
			this.price = payload.price; this.change24h = payload.change24h;
			this.change7d = payload.change7d; this.chartData = payload.chartData;
			this.loaded = true; this.updateDom(this.config.animationSpeed);
		}
	},
	formatPrice: function (price) {
		return new Intl.NumberFormat("en-AU", {
			style: "currency", currency: "AUD", minimumFractionDigits: 0, maximumFractionDigits: 0,
		}).format(price);
	},
	getGlobalColor: function () {
		var el = document.querySelector(".module.MMM-BTCAud .module-content");
		if (el) return window.getComputedStyle(el).color;
		return "rgba(255,255,255,0.7)";
	},
	getDom: function () {
		var wrapper = document.createElement("div");
		wrapper.className = "btcaud-wrapper";
		if (!this.loaded) {
			wrapper.innerHTML = '<div class="btcaud-loading">Loading BTC...</div>';
			return wrapper;
		}
		var priceDiv = document.createElement("div");
		priceDiv.className = "btcaud-price";
		var icon = document.createElement("span");
		icon.className = "btcaud-icon"; icon.innerHTML = "₿";
		priceDiv.appendChild(icon);
		var amount = document.createElement("span");
		amount.className = "btcaud-amount";
		amount.textContent = this.formatPrice(this.price);
		priceDiv.appendChild(amount);
		wrapper.appendChild(priceDiv);
		if (this.config.showChange) {
			var changeDiv = document.createElement("div");
			changeDiv.className = "btcaud-changes";
			if (this.change24h !== null) {
				var c24 = document.createElement("span");
				c24.className = "btcaud-change";
				c24.textContent = "24h: " + (this.change24h >= 0 ? "▲" : "▼") + " " + Math.abs(this.change24h.toFixed(1)) + "%";
				changeDiv.appendChild(c24);
			}
			if (this.change7d !== null) {
				var c7 = document.createElement("span");
				c7.className = "btcaud-change";
				c7.textContent = "7d: " + (this.change7d >= 0 ? "▲" : "▼") + " " + Math.abs(this.change7d.toFixed(1)) + "%";
				changeDiv.appendChild(c7);
			}
			wrapper.appendChild(changeDiv);
		}
		if (this.chartData.length > 0) {
			var canvas = document.createElement("canvas");
			canvas.width = this.config.chartWidth;
			canvas.height = this.config.chartHeight;
			canvas.className = "btcaud-chart";
			wrapper.appendChild(canvas);
			var self = this;
			setTimeout(function () { self.drawChart(canvas); }, 100);
		}
		return wrapper;
	},
	drawChart: function (canvas) {
		var ctx = canvas.getContext("2d");
		var data = this.chartData;
		var w = canvas.width, h = canvas.height;
		var padding = { top: 10, right: 10, bottom: 25, left: 10 };
		var chartW = w - padding.left - padding.right;
		var chartH = h - padding.top - padding.bottom;
		ctx.clearRect(0, 0, w, h);
		if (data.length < 2) return;
		var globalColor = this.getGlobalColor();
		var rgbMatch = globalColor.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
		var r = 255, g = 255, b = 255;
		if (rgbMatch) { r = parseInt(rgbMatch[1]); g = parseInt(rgbMatch[2]); b = parseInt(rgbMatch[3]); }
		var prices = data.map(function (d) { return d[1]; });
		var times = data.map(function (d) { return d[0]; });
		var minP = Math.min.apply(null, prices);
		var maxP = Math.max.apply(null, prices);
		var range = maxP - minP || 1;
		var getX = function (i) { return padding.left + (i / (data.length - 1)) * chartW; };
		var getY = function (p) { return padding.top + chartH - ((p - minP) / range) * chartH; };
		ctx.beginPath();
		ctx.moveTo(getX(0), getY(prices[0]));
		for (var i = 1; i < data.length; i++) ctx.lineTo(getX(i), getY(prices[i]));
		ctx.lineTo(getX(data.length - 1), padding.top + chartH);
		ctx.lineTo(getX(0), padding.top + chartH);
		ctx.closePath();
		var gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
		gradient.addColorStop(0, "rgba(" + r + "," + g + "," + b + ",0.2)");
		gradient.addColorStop(1, "rgba(" + r + "," + g + "," + b + ",0)");
		ctx.fillStyle = gradient; ctx.fill();
		ctx.beginPath();
		ctx.moveTo(getX(0), getY(prices[0]));
		for (var i = 1; i < data.length; i++) ctx.lineTo(getX(i), getY(prices[i]));
		ctx.strokeStyle = "rgb(" + r + "," + g + "," + b + ")";
		ctx.lineWidth = 2; ctx.stroke();
		var lastX = getX(data.length - 1), lastY = getY(prices[prices.length - 1]);
		ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
		ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")"; ctx.fill();
		ctx.fillStyle = "rgba(" + r + "," + g + "," + b + ",0.5)";
		ctx.font = "10px sans-serif"; ctx.textAlign = "center";
		var dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		var step = Math.floor(data.length / 7);
		for (var i = 0; i < 7; i++) {
			var idx = Math.min(i * step, data.length - 1);
			ctx.fillText(dayLabels[new Date(times[idx]).getDay()], getX(idx), h - 5);
		}
	},
});
MODEOF

cat > "$MODULE_DIR/node_helper.js" << 'HELPEREOF'
var NodeHelper = require("node_helper");
module.exports = NodeHelper.create({
	start: function () { console.log("[MMM-BTCAud] Node helper started"); },
	socketNotificationReceived: function (notification, payload) {
		if (notification === "BTC_GET_DATA") this.fetchData(payload);
	},
	fetchData: async function (config) {
		try {
			var priceRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + config.coin + "&vs_currencies=" + config.currency + "&include_24hr_change=true");
			var priceData = await priceRes.json();
			var price = priceData[config.coin][config.currency];
			var change24h = priceData[config.coin][config.currency + "_24h_change"];
			var chartRes = await fetch("https://api.coingecko.com/api/v3/coins/" + config.coin + "/market_chart?vs_currency=" + config.currency + "&days=" + config.days);
			var chartData = await chartRes.json();
			var change7d = null;
			if (chartData.prices && chartData.prices.length > 1) {
				change7d = ((chartData.prices[chartData.prices.length - 1][1] - chartData.prices[0][1]) / chartData.prices[0][1]) * 100;
			}
			this.sendSocketNotification("BTC_DATA", {
				price: price, change24h: change24h, change7d: change7d, chartData: chartData.prices || [],
			});
		} catch (error) { console.error("[MMM-BTCAud] Error:", error.message); }
	},
});
HELPEREOF

cat > "$MODULE_DIR/MMM-BTCAud.css" << 'CSSEOF'
.btcaud-wrapper { text-align: center; min-width: 300px; }
.btcaud-loading { color: inherit; font-size: 14px; opacity: 0.5; }
.btcaud-price { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 5px; }
.btcaud-icon { color: inherit; font-size: 28px; font-weight: bold; }
.btcaud-amount { font-size: 32px; font-weight: 300; color: inherit; letter-spacing: 1px; }
.btcaud-changes { display: flex; justify-content: center; gap: 20px; margin-bottom: 8px; }
.btcaud-change { font-size: 13px; font-weight: 400; color: inherit; }
.btcaud-chart { display: block; margin: 0 auto; }
CSSEOF

cat > "$MODULE_DIR/package.json" << 'EOF'
{ "name": "MMM-BTCAud", "version": "1.0.0", "description": "Bitcoin AUD price + 7-day chart", "main": "node_helper.js", "dependencies": {} }
EOF

ok "MMM-BTCAud module created"

# ════════════════════════════════════════════════════════════════════════════
divider "CONFIG FILES"
# ════════════════════════════════════════════════════════════════════════════

# Copy configs from repo if available, otherwise create them
if [ -f "$REPO_DIR/config/config-guest.js" ]; then
    cp "$REPO_DIR/config/config-guest.js" "$MMDIR/config/config-guest.js"
    cp "$REPO_DIR/config/config-personal.js" "$MMDIR/config/config-personal.js"
    ok "Configs copied from repo"
else
    info "Creating configs inline..."
fi

# Always write the definitive configs
cat > "$MMDIR/config/config-guest.js" << 'EOF'
let config = {
	address: "0.0.0.0",
	port: 8080,
	basePath: "/",
	ipWhitelist: [],
	useHttps: false,
	language: "en",
	locale: "en-AU",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 24,
	units: "metric",
	modules: [
		{ module: "alert" },
		{ module: "MMM-Remote-Control-Repository" },
		{
			module: "MMM-Remote-Control",
			config: {
				showModuleApiMenu: true,
				secureEndpoints: false,
			}
		},
		{ module: "updatenotification", position: "top_bar" },
		{ module: "clock", position: "top_left" },
		{
			module: "calendar",
			header: "WA Public Holidays",
			position: "top_left",
			config: {
				maximumEntries: 10,
				calendars: [
					{
						fetchInterval: 7 * 24 * 60 * 60 * 1000,
						symbol: "calendar-check",
						url: "https://www.officeholidays.com/ics-all/australia/western-australia"
					},
					// Google Calendar: uncomment and paste your secret iCal URL
					// { symbol: "calendar", url: "YOUR_GOOGLE_CALENDAR_ICAL_URL" },
				]
			}
		},
		{
			module: "weather",
			position: "top_right",
			header: "Perth",
			config: {
				weatherProvider: "openmeteo",
				type: "current",
				lat: -31.9985,
				lon: 115.7654,
				showWindDirection: true,
				showHumidity: "wind",
				showFeelsLike: true,
			}
		},
		{
			module: "weather",
			position: "top_right",
			header: "Forecast",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: -31.9985,
				lon: 115.7654,
				maxNumberOfDays: 5,
				colored: true,
			}
		},
		{
			module: "MMM-BTCAud",
			position: "middle_center",
			config: {
				updateInterval: 5 * 60 * 1000,
				chartWidth: 400,
				chartHeight: 150,
			}
		},
		{
			module: "newsfeed",
			position: "bottom_bar",
			config: {
				feeds: [
					{ title: "ABC News", url: "https://www.abc.net.au/news/feed/51120/rss.xml" },
					{ title: "SBS News", url: "https://www.sbs.com.au/news/feed" },
					{ title: "The Guardian AU", url: "https://www.theguardian.com/au/rss" },
					{ title: "9News", url: "https://www.9news.com.au/rss" },
				],
				showSourceTitle: true,
				showPublishDate: true,
				broadcastNewsFeeds: true,
				broadcastNewsUpdates: true,
				updateInterval: 30000,
				reloadInterval: 300000,
			}
		},
	]
};
if (typeof module !== "undefined") { module.exports = config; }
EOF

cp "$MMDIR/config/config-guest.js" "$MMDIR/config/config-personal.js"
ln -sf "$MMDIR/config/config-guest.js" "$MMDIR/config/config.js"
ok "Configs written and symlinked"

# CSS rotation
cat > "$MMDIR/css/custom.css" << 'EOF'
/* Portrait rotation — 90° clockwise
 * If upside down: change rotate(90deg) → rotate(-90deg)
 * transform-origin: bottom left → top left
 * top: -100vw → top: 100vh
 */
body {
	margin: 0;
	position: absolute;
	transform: rotate(90deg);
	transform-origin: bottom left;
	width: 100vh;
	height: 100vw;
	object-fit: cover;
	top: -100vw;
	visibility: visible;
}
EOF
ok "custom.css with portrait rotation"

divider "MODULES COMPLETE — Run 03-portal-install.sh next"
